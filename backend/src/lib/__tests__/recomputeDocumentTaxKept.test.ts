import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "../../../generated/prisma/client.js";

const { orgCtx, resolveAddressTax, loadRateSet } = vi.hoisted(() => ({
	orgCtx: vi.fn(),
	resolveAddressTax: vi.fn(),
	loadRateSet: vi.fn(),
}));
vi.mock("../../services/tax/taxMode.js", () => ({ getOrgTaxContext: orgCtx }));
vi.mock("../../services/tax/taxResolver.js", () => ({
	resolveAddressTax,
	loadRateSet,
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { holdsKeptRate, recomputeDocumentTotals } from "../recomputeDocumentTotals.js";
import { keptRateRef } from "../documentTaxPlan.js";
import { applyQbAdoption } from "../../services/qb/qbAdoption.js";
import { buildInvoicePayload, qbPushFingerprint } from "../../services/qb/qbInvoiceTax.js";

const LA_CROSSE = {
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
const ADDRESS = "400 Main St, La Crosse, WI 54601";
const KEPT_SNAPSHOT = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs1",
	sourcing: "D",
	rounding: "jurisdiction_half_up",
	groups: [],
};

/** Q-0010: one taxable $420 line, one non-taxable $190 line, taxed at La Crosse 5.5% in auto mode. */
function quoteTx(snapshot: unknown = KEPT_SNAPSHOT) {
	return {
		quote: {
			findFirst: vi.fn(async () => ({
				client_id: "c1",
				tax_snapshot: snapshot,
				discount_type: null,
				discount_value: null,
				tax_source: "provider",
				tax_needs_review: false,
				tax_resolution_id: "res-1",
				address: ADDRESS,
				coords: null,
				line_items: [
					{ id: "l1", total: 420, tax_group_id: null, taxable: true },
					{ id: "l2", total: 190, tax_group_id: null, taxable: false },
				],
			})),
			update: vi.fn(async () => ({})),
		},
		quote_line_item: { update: vi.fn(async () => ({})) },
		client: {
			findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
		},
		tax_group: {
			findMany: vi.fn(async () => []),
			findFirst: vi.fn(async () => WI_STANDARD),
		},
	};
}
const asTx = (t: unknown) => t as Prisma.TransactionClient;
const quoteData = (t: ReturnType<typeof quoteTx>) =>
	(t.quote.update.mock.calls[0] as any)[0].data;
const lineGroups = (t: ReturnType<typeof quoteTx>) =>
	t.quote_line_item.update.mock.calls.map((c) => (c as any)[0].data.tax_group_id);

describe("recomputeDocumentTotals — kept address rate in manual mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		loadRateSet.mockResolvedValue(LA_CROSSE);
	});

	it("keeps taxing the ungrouped taxable line at the address rate, with no lookup", async () => {
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));

		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(loadRateSet).toHaveBeenCalledWith("rs1");
		const data = quoteData(tx);
		expect(data).toMatchObject({
			tax_amount: 23.1,
			tax_source: "provider",
			tax_resolution_id: "res-1",
			tax_needs_review: false,
		});
		expect(data.tax_snapshot).toMatchObject({
			source: "provider",
			rate_set_id: "rs1",
			sourcing: "D",
			kept_from_auto: true,
		});
		expect(data.tax_snapshot.groups.map((g: any) => g.id)).toEqual(["rs1"]);
	});

	it("does not stamp a group onto the ungrouped lines", async () => {
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(lineGroups(tx)).toEqual([null, null]);
	});

	it("keeps it again on the next save (the kept snapshot still reads as kept)", async () => {
		const first = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(first));
		const second = quoteTx(quoteData(first).tax_snapshot);
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(second));
		expect(quoteData(second)).toMatchObject({ tax_amount: 23.1, tax_source: "provider" });
		expect(quoteData(second).tax_snapshot.kept_from_auto).toBe(true);
	});

	it("dropKeptRate falls to the org default", async () => {
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx), undefined, {
			dropKeptRate: true,
		});
		expect(loadRateSet).not.toHaveBeenCalled();
		const data = quoteData(tx);
		expect(data).toMatchObject({ tax_amount: 34.65, tax_source: "org_default" });
		expect(data.tax_snapshot).not.toHaveProperty("kept_from_auto");
		expect(data.tax_snapshot).not.toHaveProperty("rate_set_id");
		expect(lineGroups(tx)).toEqual(["g-def", "g-def"]);
	});

	it("falls to the org default with a review when the kept rate set is gone", async () => {
		loadRateSet.mockResolvedValue(null);
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		const data = quoteData(tx);
		expect(data).toMatchObject({
			tax_amount: 34.65,
			tax_source: "org_default",
			tax_needs_review: true,
		});
		expect(data.tax_snapshot.review_reason).toBe(
			"The kept address rate is no longer available",
		);
		expect(data.tax_snapshot).not.toHaveProperty("kept_from_auto");
	});

	it("leaves a locked quote alone", async () => {
		const locked = { ...KEPT_SNAPSHOT, locked_at: "2026-10-01T00:00:00.000Z" };
		const tx = quoteTx(locked);
		const result = await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(result).toEqual({ ok: false, reason: "locked" });
		expect(tx.quote.update).not.toHaveBeenCalled();
		expect(loadRateSet).not.toHaveBeenCalled();
	});

	it("auto mode ignores the kept rate and looks the address up", async () => {
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue({
			kind: "rate",
			stale: false,
			resolution_id: "res-2",
			rate_set: { ...LA_CROSSE, id: "rs2" },
			sourcing: "D",
			reasons: [],
		});
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).toHaveBeenCalled();
		expect(loadRateSet).not.toHaveBeenCalled();
		expect(quoteData(tx).tax_snapshot).toMatchObject({ rate_set_id: "rs2" });
		expect(quoteData(tx).tax_snapshot).not.toHaveProperty("kept_from_auto");
	});

	// Review Focus 5
	it("an adopted invoice keeps the address rate for its groups in manual mode", async () => {
		const line: Record<string, any> = {
			id: "l1",
			total: 100,
			quantity: 1,
			unit_price: 100,
			name: "Furnace repair",
			description: null,
			tax_group_id: null,
			taxable: true,
			item_type: null,
			tax_amount: 0,
			inventory_item: null,
		};
		const row: Record<string, any> = {
			id: "i1",
			client_id: "c1",
			tax_snapshot: null,
			discount_type: null,
			discount_value: null,
			discount_amount: 0,
			amount_paid: 0,
			adjusts_invoice_id: null,
			tax_source: null,
			tax_needs_review: false,
			tax_resolution_id: null,
			tax_review_ack_by: null,
			tax_review_ack_at: null,
			recurring_plan_id: null,
			line_items: [line],
			jobs: [{ job: { address: ADDRESS, coords: null, recurring_plan_id: null } }],
			client: { is_tax_exempt: false, address: ADDRESS, coords: null },
		};
		const tx = {
			invoice: {
				findFirst: vi.fn(async () => row),
				update: vi.fn(async ({ data }: any) => Object.assign(row, data)),
			},
			invoice_line_item: {
				update: vi.fn(async ({ data }: any) => Object.assign(line, data)),
			},
			organization: { findUnique: vi.fn(async () => ({ qb_realm_id: "realm1" })) },
			client: {
				findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => WI_STANDARD),
			},
		};

		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue({
			kind: "rate",
			stale: false,
			resolution_id: "res-1",
			rate_set: LA_CROSSE,
			sourcing: "D",
			reasons: [],
		});
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		const payload = buildInvoicePayload(row as any, null);
		const fingerprint = qbPushFingerprint(payload.lines, payload.shipAddr, payload.clientExempt);
		await applyQbAdoption(asTx(tx), "i1", "org1", { qbTaxCents: 550, fingerprint });
		expect(row.tax_snapshot).toMatchObject({ source: "qb_ast", rate_set_id: "rs1" });

		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(loadRateSet).toHaveBeenCalledWith("rs1");
		expect(row.tax_snapshot.groups.map((g: any) => g.id)).toEqual(["rs1"]);
		expect(row.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
		expect(row.tax_snapshot.total_tax_cents).toBe(550);
		expect(line.tax_group_id).toBeNull();
	});
});

describe("keptRateRef", () => {
	it("reads a v2 address-rate snapshot; qb_ast reads as provider", () => {
		expect(
			keptRateRef(KEPT_SNAPSHOT, { tax_needs_review: false, tax_resolution_id: "res-1" }),
		).toEqual({
			rate_set_id: "rs1",
			source: "provider",
			needs_review: false,
			review_reason: null,
			resolution_id: "res-1",
			sourcing: "D",
		});
		expect(
			keptRateRef({ ...KEPT_SNAPSHOT, source: "qb_ast" }, null)?.source,
		).toBe("provider");
	});

	it("derives the review without a prev row from the reason or a stale source", () => {
		expect(keptRateRef({ ...KEPT_SNAPSHOT, source: "cached_stale" }, null)?.needs_review).toBe(
			true,
		);
		expect(
			keptRateRef({ ...KEPT_SNAPSHOT, review_reason: "Not registered to collect in IL" }, null),
		).toMatchObject({ needs_review: true, review_reason: "Not registered to collect in IL" });
	});

	it("is null for anything not taxed at an address rate", () => {
		expect(keptRateRef(null, null)).toBeNull();
		expect(keptRateRef({ ...KEPT_SNAPSHOT, source: "org_default" }, null)).toBeNull();
		expect(keptRateRef({ ...KEPT_SNAPSHOT, rate_set_id: undefined }, null)).toBeNull();
		expect(keptRateRef({ ...KEPT_SNAPSHOT, version: 1 }, null)).toBeNull();
	});
});

describe("keptRateRef — QuickBooks review", () => {
	it("a QuickBooks review neither names the rate's reason nor flags the rate", () => {
		expect(
			keptRateRef(
				{ ...KEPT_SNAPSHOT, qb_review: true, review_reason: "<QB delta>" },
				{ tax_needs_review: true, tax_resolution_id: null },
			),
		).toMatchObject({ review_reason: null, needs_review: false });
	});
});

const PARENT_PREV = { tax_needs_review: false, tax_resolution_id: "res-1" };

/** A job with one taxable $420 and one non-taxable $190 line, converted from Q-0010. */
function jobTx(own: unknown, quote: Record<string, unknown> | null) {
	const row = {
		client_id: "c1",
		tax_snapshot: own,
		discount_type: null,
		discount_value: null,
		tax_source: null,
		tax_needs_review: false,
		tax_resolution_id: null,
		address: ADDRESS,
		coords: null,
		line_items: [
			{ id: "l1", total: 420, tax_group_id: null, taxable: true },
			{ id: "l2", total: 190, tax_group_id: null, taxable: false },
		],
		quote,
	};
	return {
		job: {
			findFirst: vi.fn(async () => row),
			update: vi.fn(async () => ({})),
		},
		job_line_item: { update: vi.fn(async () => ({})) },
		client: {
			findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
		},
		tax_group: {
			findMany: vi.fn(async () => []),
			findFirst: vi.fn(async () => WI_STANDARD),
		},
	};
}
const jobData = (t: ReturnType<typeof jobTx>) => (t.job.update.mock.calls[0] as any)[0].data;

describe("recomputeDocumentTotals — a child inherits its parent's kept rate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		loadRateSet.mockResolvedValue(LA_CROSSE);
	});

	it("job with no snapshot of its own takes the quote's kept rate", async () => {
		const tx = jobTx(null, { tax_snapshot: KEPT_SNAPSHOT, ...PARENT_PREV });
		await recomputeDocumentTotals("job", "j1", "org1", asTx(tx));

		expect(resolveAddressTax).not.toHaveBeenCalled();
		const data = jobData(tx);
		expect(data).toMatchObject({
			tax_amount: 23.1,
			tax_source: "provider",
			tax_resolution_id: "res-1",
			tax_needs_review: false,
		});
		expect(data.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
		expect(tx.job_line_item.update.mock.calls.map((c) => (c as any)[0].data.tax_group_id)).toEqual(
			[null, null],
		);
	});

	it("the quote's review carries onto the job", async () => {
		const tx = jobTx(null, {
			tax_snapshot: { ...KEPT_SNAPSHOT, review_reason: "Not registered to collect in IL" },
			tax_needs_review: true,
			tax_resolution_id: "res-1",
		});
		await recomputeDocumentTotals("job", "j1", "org1", asTx(tx));
		const data = jobData(tx);
		expect(data.tax_needs_review).toBe(true);
		expect(data.tax_snapshot.review_reason).toBe("Not registered to collect in IL");
	});

	it("a job with a snapshot of its own ignores the quote", async () => {
		const own = { version: 2, locked_at: "draft", source: "org_default", groups: [] };
		const tx = jobTx(own, { tax_snapshot: KEPT_SNAPSHOT, ...PARENT_PREV });
		await recomputeDocumentTotals("job", "j1", "org1", asTx(tx));
		expect(loadRateSet).not.toHaveBeenCalled();
		expect(jobData(tx)).toMatchObject({ tax_amount: 34.65, tax_source: "org_default" });
	});

	it("a new visit with no snapshot takes its job's kept rate", async () => {
		const tx = {
			job_visit: {
				findFirst: vi.fn(async () => ({
					tax_snapshot: null,
					discount_type: null,
					discount_value: null,
					line_items: [{ id: "v1", total: 100, tax_group_id: null, taxable: true }],
					job: {
						client_id: "c1",
						address: ADDRESS,
						coords: null,
						tax_snapshot: { ...KEPT_SNAPSHOT, kept_from_auto: true },
						...PARENT_PREV,
					},
				})),
				update: vi.fn(async () => ({})),
			},
			job_visit_line_item: { update: vi.fn(async () => ({})) },
			client: {
				findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => WI_STANDARD),
			},
		};
		await recomputeDocumentTotals("job_visit", "v1", "org1", asTx(tx));
		const data = (tx.job_visit.update.mock.calls[0] as any)[0].data;
		expect(data.tax_amount).toBe(5.5);
		expect(data.tax_rate).toBe(0.055);
		expect(data.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
	});

	it("a visit whose job has no snapshot yet takes the job's quote's kept rate", async () => {
		const tx = {
			job_visit: {
				findFirst: vi.fn(async () => ({
					tax_snapshot: null,
					discount_type: null,
					discount_value: null,
					line_items: [{ id: "v1", total: 100, tax_group_id: null, taxable: true }],
					job: {
						client_id: "c1",
						address: ADDRESS,
						coords: null,
						tax_snapshot: null,
						tax_needs_review: false,
						tax_resolution_id: null,
						quote: {
							tax_snapshot: { ...KEPT_SNAPSHOT, review_reason: "Not registered to collect in IL" },
							tax_needs_review: true,
							tax_resolution_id: "res-1",
						},
					},
				})),
				update: vi.fn(async () => ({})),
			},
			job_visit_line_item: { update: vi.fn(async () => ({})) },
			client: {
				findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => WI_STANDARD),
			},
		};
		await recomputeDocumentTotals("job_visit", "v1", "org1", asTx(tx));
		const data = (tx.job_visit.update.mock.calls[0] as any)[0].data;
		expect(data.tax_amount).toBe(5.5);
		expect(data.tax_snapshot).toMatchObject({
			rate_set_id: "rs1",
			kept_from_auto: true,
			review_reason: "Not registered to collect in IL",
		});
	});

	function invoiceTx(adjusts: string | null) {
		return {
			invoice: {
				findFirst: vi.fn(async () => ({
					client_id: "c1",
					tax_snapshot: null,
					discount_type: null,
					discount_value: null,
					amount_paid: 0,
					adjusts_invoice_id: adjusts,
					tax_source: null,
					tax_needs_review: false,
					tax_resolution_id: null,
					line_items: [{ id: "i1", total: 420, tax_group_id: null, taxable: true }],
					jobs: [
						{
							job: {
								address: ADDRESS,
								coords: null,
								tax_snapshot: { ...KEPT_SNAPSHOT, kept_from_auto: true },
								...PARENT_PREV,
							},
						},
					],
					client: { address: ADDRESS, coords: null },
				})),
				update: vi.fn(async () => ({})),
			},
			invoice_line_item: { update: vi.fn(async () => ({})) },
			client: {
				findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => WI_STANDARD),
			},
		};
	}

	it("an invoice created from that job takes the job's kept rate", async () => {
		const tx = invoiceTx(null);
		await recomputeDocumentTotals("invoice", "inv1", "org1", asTx(tx));
		const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
		expect(data).toMatchObject({ tax_amount: 23.1, tax_source: "provider" });
		expect(data.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
	});

	it("an adjustment invoice does not inherit from its job", async () => {
		const tx = invoiceTx("orig-1");
		await recomputeDocumentTotals("invoice", "inv1", "org1", asTx(tx));
		expect(loadRateSet).not.toHaveBeenCalled();
		const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
		expect(data.tax_snapshot).not.toHaveProperty("kept_from_auto");
	});
});

describe("holdsKeptRate", () => {
	const tx = (row: unknown) => asTx({ job: { findFirst: vi.fn(async () => row) } });

	it("reads the job's own snapshot first, else its quote's", async () => {
		expect(await holdsKeptRate("job", "j1", tx({ tax_snapshot: KEPT_SNAPSHOT, quote: null }))).toBe(
			true,
		);
		const viaQuote = tx({ tax_snapshot: null, quote: { tax_snapshot: KEPT_SNAPSHOT } });
		expect(await holdsKeptRate("job", "j1", viaQuote)).toBe(true);
		expect(
			await holdsKeptRate(
				"job",
				"j1",
				tx({
					tax_snapshot: { version: 2, locked_at: "draft", source: "org_default", groups: [] },
					quote: { tax_snapshot: KEPT_SNAPSHOT },
				}),
			),
		).toBe(false);
		expect(await holdsKeptRate("job", "j1", tx({ tax_snapshot: null, quote: null }))).toBe(false);
		expect(await holdsKeptRate("job", "j1", tx(null))).toBe(false);
	});
});
