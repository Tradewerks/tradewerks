import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", async () => {
	const { db } = await import("../../db.js");
	return { getScopedDb: () => db };
});
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: vi.fn(async () => []),
}));
const { recompute, orgCtx, loadRateSet } = vi.hoisted(() => ({
	recompute: vi.fn(),
	orgCtx: vi.fn(),
	loadRateSet: vi.fn(),
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({ recomputeDocumentTotals: recompute }));
vi.mock("../tax/taxMode.js", () => ({ getOrgTaxContext: orgCtx }));
vi.mock("../tax/taxResolver.js", () => ({ loadRateSet }));
vi.mock("../appLogger.js", () => ({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { db } from "../../db.js";
import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { log } from "../appLogger.js";
import { runTaxRateRefresh } from "../taxRateRefreshScheduler.js";

const mockDb = db as any;
const notify = notifyDispatchers as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date("2026-11-01T06:00:00Z");
const EXPIRED = new Date("2026-11-01T00:00:00Z");
const OPEN = { notIn: ["Completed", "Cancelled"] };

const rateSet = (id: string, county: number) => ({
	id,
	state_code: "WI",
	total_rate: 0.05 + county,
	components: [
		{ id: `${id}-s`, jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: "55", rate: 0.05 },
		{ id: `${id}-c`, jurisdiction_type: "county", jurisdiction_name: "DANE", jurisdiction_code: "025", rate: county },
	],
});
const SETS: Record<string, unknown> = { old: rateSet("old", 0.005), new: rateSet("new", 0.006) };

// Each document's snapshot rate set: `current` before its recompute, `next[id]` after.
let current: Record<string, string | null>;
let next: Record<string, string | null>;
const snapshotOf = async ({ where }: { where: { id: string } }) => ({
	tax_snapshot: {
		version: 2,
		groups: [],
		locked_at: "draft",
		...(current[where.id] ? { rate_set_id: current[where.id] } : {}),
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	current = {};
	next = {};
	mockDb.tax_address_resolution.findMany.mockResolvedValue([{ id: "res-1", valid_until: EXPIRED }]);
	mockDb.$queryRaw.mockResolvedValue([{ got: true }]);
	mockDb.tax_address_resolution.updateMany.mockResolvedValue({ count: 1 });
	mockDb.job.findMany.mockResolvedValue([]);
	mockDb.quote.findMany.mockResolvedValue([]);
	mockDb.invoice.findMany.mockResolvedValue([]);
	mockDb.job_visit.findMany.mockResolvedValue([]);
	mockDb.quote.findFirst.mockImplementation(snapshotOf);
	mockDb.job.findFirst.mockImplementation(snapshotOf);
	mockDb.invoice.findFirst.mockImplementation(snapshotOf);
	recompute.mockImplementation(async (_model: string, id: string) => {
		if (id in next) current[id] = next[id];
		return { ok: true };
	});
	orgCtx.mockResolvedValue({ mode: "auto" });
	loadRateSet.mockImplementation(async (id: string) => SETS[id] ?? null);
});

describe("runTaxRateRefresh", () => {
	it("claims an expired resolution, recomputes its drafts and notifies the org once", async () => {
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		current = { q1: "old" };
		next = { q1: "new" };

		expect(await runTaxRateRefresh(NOW)).toBe(1);

		expect(mockDb.tax_address_resolution.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ valid_until: { lt: NOW } }),
			}),
		);
		expect(mockDb.tax_address_resolution.updateMany).toHaveBeenCalledWith({
			where: { id: "res-1", valid_until: EXPIRED },
			data: { valid_until: NOW },
		});
		expect(mockDb.quote.findMany).toHaveBeenCalledWith({
			where: { tax_resolution_id: "res-1", status: "Draft" },
			select: { id: true, organization_id: true },
		});
		expect(recompute).toHaveBeenCalledWith("quote", "q1", "org-1", expect.anything());
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			{
				type: "tax_rate_changed",
				title: "Tax rate changed on 1 draft",
				body: "1 draft 5.5% → 5.6% (Dane County 0.5% → 0.6%)",
				actionUrl: "/dispatch/quotes?status=Draft",
			},
			"org-1",
		);
	});

	it("does nothing when no resolution is due", async () => {
		mockDb.tax_address_resolution.findMany.mockResolvedValue([]);
		expect(await runTaxRateRefresh(NOW)).toBe(0);
		expect(mockDb.tax_address_resolution.updateMany).not.toHaveBeenCalled();
	});

	it("skips a resolution another instance already claimed", async () => {
		mockDb.tax_address_resolution.updateMany.mockResolvedValue({ count: 0 });
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		expect(await runTaxRateRefresh(NOW)).toBe(0);
		expect(recompute).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("skips a resolution whose advisory lock another instance holds (no claim, no recompute)", async () => {
		mockDb.$queryRaw.mockResolvedValue([{ got: false }]);
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		expect(await runTaxRateRefresh(NOW)).toBe(0);
		expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function), {
			timeout: 300_000,
			maxWait: 10_000,
		});
		expect(mockDb.tax_address_resolution.updateMany).not.toHaveBeenCalled();
		expect(mockDb.quote.findMany).not.toHaveBeenCalled();
		expect(recompute).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("takes the lock keyed on the resolution id before claiming", async () => {
		await runTaxRateRefresh(NOW);
		const [strings, key] = mockDb.$queryRaw.mock.calls[0];
		expect(strings.join("?")).toContain("pg_try_advisory_xact_lock(hashtext(");
		expect(key).toBe("tax_refresh:res-1");
		expect(mockDb.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			mockDb.tax_address_resolution.updateMany.mock.invocationCallOrder[0],
		);
	});

	it("leaves drafts of orgs not in effective auto mode alone (no recompute, no lookup charge)", async () => {
		orgCtx.mockResolvedValue({ mode: "manual" });
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		expect(await runTaxRateRefresh(NOW)).toBe(0);
		expect(recompute).not.toHaveBeenCalled();
	});

	it("does not notify when the rate set did not change (same rate, or provider outage → stale)", async () => {
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		current = { q1: "old" };
		next = { q1: "old" };
		await runTaxRateRefresh(NOW);
		expect(recompute).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not count a draft that had no resolved rate before (manual override, fallback)", async () => {
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		current = { q1: null };
		next = { q1: "new" };
		await runTaxRateRefresh(NOW);
		expect(notify).not.toHaveBeenCalled();
	});

	it("notifies each org about its own drafts only", async () => {
		mockDb.quote.findMany.mockResolvedValue([
			{ id: "q1", organization_id: "org-1" },
			{ id: "q2", organization_id: "org-2" },
		]);
		current = { q1: "old", q2: "old" };
		next = { q1: "new", q2: "new" };
		await runTaxRateRefresh(NOW);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Tax rate changed on 1 draft" }), "org-1");
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Tax rate changed on 1 draft" }), "org-2");
	});

	it("recomputes a job's open visits after the job", async () => {
		mockDb.job.findMany.mockResolvedValue([{ id: "j1", organization_id: "org-1" }]);
		mockDb.job_visit.findMany.mockResolvedValue([{ id: "v1" }]);
		await runTaxRateRefresh(NOW);
		expect(mockDb.job.findMany).toHaveBeenCalledWith({
			where: { tax_resolution_id: "res-1", status: OPEN },
			select: { id: true, organization_id: true },
		});
		expect(mockDb.job_visit.findMany).toHaveBeenCalledWith({
			where: { job_id: "j1", status: OPEN },
			select: { id: true },
		});
		expect(recompute.mock.calls.map((c) => [c[0], c[1]])).toEqual([
			["job", "j1"],
			["job_visit", "v1"],
		]);
	});

	it("logs a failing draft and still refreshes and reports the rest", async () => {
		mockDb.quote.findMany.mockResolvedValue([
			{ id: "q1", organization_id: "org-1" },
			{ id: "q2", organization_id: "org-1" },
		]);
		current = { q1: "old", q2: "old" };
		next = { q2: "new" };
		recompute.mockImplementation(async (_m: string, id: string) => {
			if (id === "q1") throw new Error("boom");
			if (id in next) current[id] = next[id];
			return { ok: true };
		});
		await runTaxRateRefresh(NOW);
		expect(log.error).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Tax rate changed on 1 draft" }), "org-1");
	});

	it("skips a draft whose recompute reports locked or not found", async () => {
		mockDb.quote.findMany.mockResolvedValue([{ id: "q1", organization_id: "org-1" }]);
		current = { q1: "old" };
		recompute.mockResolvedValue({ ok: false, reason: "locked" });
		await runTaxRateRefresh(NOW);
		expect(notify).not.toHaveBeenCalled();
	});
});
