import { describe, it, expect, vi, beforeEach } from "vitest";

// The real resolver runs (cache-only); only its storage, provider and meter are stubbed.
const { orgCtx, providerLookup, consumeQuota, db, tx } = vi.hoisted(() => {
	const tx = {
		$executeRaw: vi.fn(async () => 0),
		client: { findFirst: vi.fn() },
		tax_group: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
	};
	return {
		orgCtx: vi.fn(),
		providerLookup: vi.fn(),
		consumeQuota: vi.fn(async () => ({ allowed: true })),
		tx,
		db: {
			$transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
			tax_address_resolution: { findUnique: vi.fn(), upsert: vi.fn() },
			tax_rate_set: { findUnique: vi.fn(), create: vi.fn() },
			recurring_plan: { findFirst: vi.fn() },
		},
	};
});
vi.mock("../../db.js", () => ({ db }));
vi.mock("../../services/tax/taxMode.js", () => ({ getOrgTaxContext: orgCtx }));
vi.mock("../../services/tax/index.js", () => ({
	getTaxRateProvider: () => ({ name: "ziptax", lookup: providerLookup }),
}));
vi.mock("../entitlements/quota.js", () => ({ consumeQuota }));
vi.mock("../../services/tax/taxMetrics.js", () => ({
	otelTaxMetrics: { cacheHit: vi.fn(), providerCall: vi.fn() },
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { estimateDocumentTax, planKeptRate } from "../estimateDocumentTax.js";
import { keptRateRef } from "../documentTaxPlan.js";

const LA_CROSSE_ROW = {
	id: "rs1",
	state_code: "WI",
	total_rate: 0.055,
	components: [
		{
			id: "c1",
			jurisdiction_type: "state",
			jurisdiction_name: "WI",
			jurisdiction_code: "55",
			rate: 0.05,
		},
		{
			id: "c2",
			jurisdiction_type: "county",
			jurisdiction_name: "LA CROSSE",
			jurisdiction_code: "063",
			rate: 0.005,
		},
	],
};
const CACHED_RESOLUTION = {
	id: "res-1",
	status: "ok",
	sourcing: "D",
	resolved_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
	valid_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
	rate_set: LA_CROSSE_ROW,
};
const MANUAL_ORG = {
	stored_mode: "manual",
	auto_entitled: true,
	mode: "manual",
	registered_states: ["WI"],
	legacy_rate: 0,
	address: "1 Shop Rd, La Crosse, WI 54601",
};
const AUTO_ORG = { ...MANUAL_ORG, stored_mode: "auto", mode: "auto" };
const WI_STANDARD = {
	id: "g-def",
	name: "WI Standard",
	rates: [
		{
			sort_order: 0,
			tax_rate: { id: "r1", name: "State", rate: 0.0825, jurisdiction: null },
		},
	],
};
const KEPT_SNAPSHOT = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs1",
	sourcing: "D",
	rounding: "jurisdiction_half_up",
	groups: [],
};
const ADDRESS = "400 Main St, La Crosse, WI 54601";

const PLAN_LINE = { total: 189, taxable: true, tax_group_id: null };
const estimate = (lines = [PLAN_LINE], kept: ReturnType<typeof keptRateRef> = null) =>
	estimateDocumentTax({
		organizationId: "org1",
		clientId: "c1",
		address: ADDRESS,
		coords: null,
		lines,
		kept,
	});

function expectNoWrites() {
	expect(providerLookup).not.toHaveBeenCalled();
	expect(consumeQuota).not.toHaveBeenCalled();
	expect(db.tax_address_resolution.upsert).not.toHaveBeenCalled();
	expect(db.tax_rate_set.create).not.toHaveBeenCalled();
}

describe("estimateDocumentTax", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		tx.client.findFirst.mockResolvedValue({ is_tax_exempt: false, tax_group_id: null });
		tx.tax_group.findFirst.mockResolvedValue(WI_STANDARD);
		db.tax_address_resolution.findUnique.mockResolvedValue(CACHED_RESOLUTION);
		db.tax_rate_set.findUnique.mockResolvedValue(LA_CROSSE_ROW);
	});

	it("auto mode: estimates from the cached address rate", async () => {
		expect(await estimate()).toEqual({
			status: "estimate",
			subtotal_cents: 18900,
			tax_cents: 1040,
			total_cents: 19940,
			place: "La Crosse, WI",
		});
		expectNoWrites();
	});

	it("runs in a read-only transaction", async () => {
		await estimate();
		expect(db.$transaction).toHaveBeenCalledTimes(1);
		const sql = (tx.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join("");
		expect(sql).toBe("SET TRANSACTION READ ONLY");
	});

	it("auto mode with a cache miss: unknown, and the provider is never asked", async () => {
		db.tax_address_resolution.findUnique.mockResolvedValue(null);
		expect(await estimate()).toEqual({ status: "unknown" });
		expectNoWrites();
	});

	it("exempt client", async () => {
		tx.client.findFirst.mockResolvedValue({ is_tax_exempt: true, tax_group_id: null });
		expect(await estimate()).toEqual({ status: "exempt" });
	});

	it("manual mode: the org default group, named by the group", async () => {
		orgCtx.mockResolvedValue(MANUAL_ORG);
		expect(await estimate()).toEqual({
			status: "estimate",
			subtotal_cents: 18900,
			tax_cents: 1559,
			total_cents: 20459,
			place: "WI Standard",
		});
		expect(db.tax_address_resolution.findUnique).not.toHaveBeenCalled();
	});

	it("manual mode with no default group: unknown", async () => {
		orgCtx.mockResolvedValue(MANUAL_ORG);
		tx.tax_group.findFirst.mockResolvedValue(null);
		expect(await estimate()).toEqual({ status: "unknown" });
	});

	it("manual mode with a kept container job: the kept rate", async () => {
		orgCtx.mockResolvedValue(MANUAL_ORG);
		const kept = keptRateRef(KEPT_SNAPSHOT, null);
		expect(await estimate([PLAN_LINE], kept)).toEqual({
			status: "estimate",
			subtotal_cents: 18900,
			tax_cents: 1040,
			total_cents: 19940,
			place: "La Crosse, WI",
		});
		expect(db.tax_rate_set.findUnique).toHaveBeenCalled();
		expect(db.tax_address_resolution.findUnique).not.toHaveBeenCalled();
		expectNoWrites();
	});

	it("excludes a non-taxable line from tax", async () => {
		const result = await estimate([
			PLAN_LINE,
			{ total: 60, taxable: false, tax_group_id: null },
		]);
		expect(result).toEqual({
			status: "estimate",
			subtotal_cents: 24900,
			tax_cents: 1040,
			total_cents: 25940,
			place: "La Crosse, WI",
		});
	});

	it("nothing taxable: an estimate with no tax and no place (no rate to name)", async () => {
		expect(await estimate([{ total: 60, taxable: false, tax_group_id: null }])).toEqual({
			status: "estimate",
			subtotal_cents: 6000,
			tax_cents: 0,
			total_cents: 6000,
			place: "",
		});
	});
});

describe("planKeptRate", () => {
	/** Plan p1 belongs to org1; only an org-scoped query finds it. */
	function planWithContainer(container: unknown) {
		db.recurring_plan.findFirst.mockImplementation(async ({ where }: any) =>
			where.id === "p1" && where.organization_id === "org1"
				? { job_container: container }
				: null,
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		tx.client.findFirst.mockResolvedValue({ is_tax_exempt: false, tax_group_id: null });
		tx.tax_group.findFirst.mockResolvedValue(WI_STANDARD);
		db.tax_rate_set.findUnique.mockResolvedValue(LA_CROSSE_ROW);
	});

	it("another org's plan is not found", async () => {
		planWithContainer(null);
		expect(await planKeptRate("org2", "p1")).toEqual({ found: false });
	});

	it("no container job, no snapshot, or a non-v2 snapshot: nothing kept", async () => {
		const prev = { tax_needs_review: false, tax_resolution_id: null };
		for (const container of [
			null,
			{ tax_snapshot: null, ...prev },
			{ tax_snapshot: { version: 1, locked_at: "draft", groups: [] }, ...prev },
		]) {
			planWithContainer(container);
			expect(await planKeptRate("org1", "p1")).toEqual({ found: true, kept: null });
		}
	});

	it("the container job's address rate feeds the estimate", async () => {
		planWithContainer({
			tax_snapshot: KEPT_SNAPSHOT,
			tax_needs_review: true,
			tax_resolution_id: "res-9",
		});
		const found = await planKeptRate("org1", "p1");
		expect(found).toMatchObject({
			found: true,
			kept: { rate_set_id: "rs1", needs_review: true, resolution_id: "res-9" },
		});
		const kept = found.found ? found.kept : null;
		expect(await estimate([PLAN_LINE], kept)).toMatchObject({
			status: "estimate",
			tax_cents: 1040,
			place: "La Crosse, WI",
		});
	});
});
