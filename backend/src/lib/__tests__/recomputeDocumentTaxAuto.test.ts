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
const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	lockDocumentTaxSnapshot,
	recomputeDocumentTotals,
} from "../recomputeDocumentTotals.js";
import { applyQbAdoption, QB_UNAVAILABLE_REASON } from "../../services/qb/qbAdoption.js";
import { buildInvoicePayload, qbPushFingerprint } from "../../services/qb/qbInvoiceTax.js";

const WI_SET = {
	id: "set-1",
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
			jurisdiction_name: "DANE",
			jurisdiction_code: "025",
			rate: 0.005,
		},
	],
};
const RESOLVED = {
	kind: "rate",
	stale: false,
	resolution_id: "res-1",
	rate_set: WI_SET,
	sourcing: "D",
	reasons: [],
};
const AUTO_ORG = {
	stored_mode: "auto",
	auto_entitled: true,
	mode: "auto",
	registered_states: ["WI"],
	legacy_rate: 0,
	address: "1 Shop Rd, Verona, WI 53593",
};
const DEFAULT_ROW = {
	id: "g-def",
	name: "Default",
	rates: [
		{
			sort_order: 0,
			tax_rate: {
				id: "r1",
				name: "State",
				rate: 0.05,
				jurisdiction: null,
			},
		},
	],
};
const ADDRESS = "200 Martin Luther King Jr Blvd, Madison, WI 53703";

type Line = {
	id: string;
	total: number;
	tax_group_id: string | null;
	taxable: boolean;
};

function quoteTx(
	over: {
		lines?: Line[];
		client?: object;
		snapshot?: unknown;
		prev?: { tax_source: string | null; tax_needs_review: boolean };
	} = {},
) {
	return {
		quote: {
			findFirst: vi.fn(async () => ({
				client_id: "c1",
				// The previous review_reason is read from here (v2 snapshots only).
				tax_snapshot: over.snapshot ?? null,
				discount_type: null,
				discount_value: null,
				tax_source: over.prev?.tax_source ?? null,
				tax_needs_review: over.prev?.tax_needs_review ?? false,
				address: ADDRESS,
				coords: { lat: 43.07, lon: -89.38 },
				line_items: over.lines ?? [
					{ id: "l1", total: 100, tax_group_id: null, taxable: true },
				],
			})),
			update: vi.fn(async () => ({})),
		},
		quote_line_item: { update: vi.fn(async () => ({})) },
		client: {
			findFirst: vi.fn(
				async () =>
					over.client ?? { is_tax_exempt: false, tax_group_id: null },
			),
		},
		tax_group: {
			findMany: vi.fn(async () => []),
			findFirst: vi.fn(async () => DEFAULT_ROW),
		},
	};
}
const asTx = (t: unknown) => t as Prisma.TransactionClient;
const quoteData = (t: ReturnType<typeof quoteTx>) =>
	(t.quote.update.mock.calls[0] as any)[0].data;

describe("recomputeDocumentTotals — auto mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue(RESOLVED);
	});

	it("taxes a no-group line at the resolved rate set and records the source", async () => {
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));

		expect(resolveAddressTax).toHaveBeenCalledWith({
			orgId: "org1",
			address: ADDRESS,
			coords: { lat: 43.07, lon: -89.38 },
			maxAgeMs: undefined,
		});
		const data = quoteData(tx);
		expect(data).toMatchObject({
			tax_amount: 5.5,
			tax_source: "provider",
			tax_resolution_id: "res-1",
			tax_needs_review: false,
		});
		expect(data.tax_snapshot).toMatchObject({
			version: 2,
			source: "provider",
			rate_set_id: "set-1",
			locked_at: "draft",
		});
		// The rate-set id must never reach line.tax_group_id (an FK to tax_group).
		expect(
			(tx.quote_line_item.update.mock.calls[0] as any)[0].data
				.tax_group_id,
		).toBeNull();
	});

	it("skips the provider when no line is taxable", async () => {
		const tx = quoteTx({
			lines: [
				{ id: "l1", total: 100, tax_group_id: null, taxable: false },
			],
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(quoteData(tx)).toMatchObject({
			tax_amount: 0,
			tax_source: null,
			tax_needs_review: false,
		});
	});

	it("skips the provider for a tax-exempt client", async () => {
		const tx = quoteTx({
			client: { is_tax_exempt: true, tax_group_id: null },
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
	});

	it("skips the provider when every taxable line has an explicit group", async () => {
		const tx = quoteTx({
			lines: [
				{ id: "l1", total: 100, tax_group_id: "g-def", taxable: true },
			],
		});
		tx.tax_group.findMany.mockResolvedValue([DEFAULT_ROW] as never);
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(quoteData(tx).tax_source).toBe("manual_override");
	});

	it("never resolves a locked document", async () => {
		const tx = quoteTx({
			snapshot: {
				version: 1,
				locked_at: "2026-10-01T00:00:00.000Z",
				groups: [],
			},
		});
		const r = await recomputeDocumentTotals(
			"quote",
			"q1",
			"org1",
			asTx(tx),
		);
		expect(r).toEqual({ ok: false, reason: "locked" });
		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(orgCtx).not.toHaveBeenCalled();
	});

	it("re-resolves at lock with the 7-day age limit", async () => {
		const tx = quoteTx();
		await lockDocumentTaxSnapshot(
			"quote",
			"q1",
			"org1",
			asTx(tx),
			new Date("2026-10-14T00:00:00Z"),
		);
		expect(resolveAddressTax).toHaveBeenCalledWith(
			expect.objectContaining({ maxAgeMs: 7 * 24 * 3600 * 1000 }),
		);
		expect(quoteData(tx).tax_snapshot.locked_at).toBe(
			"2026-10-14T00:00:00.000Z",
		);
	});

	it("locks with cached_stale + review when the re-resolve fails, never blocking", async () => {
		resolveAddressTax.mockResolvedValue({
			...RESOLVED,
			stale: true,
			reasons: ["down; using the rate looked up on 2026-10-02"],
		});
		const tx = quoteTx();
		await expect(
			lockDocumentTaxSnapshot("quote", "q1", "org1", asTx(tx)),
		).resolves.toBeUndefined();
		expect(quoteData(tx)).toMatchObject({
			tax_source: "cached_stale",
			tax_needs_review: true,
			tax_amount: 5.5,
		});
		expect(quoteData(tx).tax_snapshot.review_reason).toMatch(/2026-10-02/);
	});

	it("clears a stale acknowledgment when a review newly appears", async () => {
		resolveAddressTax.mockResolvedValue({
			kind: "none",
			ambiguous: true,
			resolution_id: "res-9",
			reasons: ["PO box"],
		});
		const tx = quoteTx({
			prev: { tax_source: "provider", tax_needs_review: false },
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(quoteData(tx)).toMatchObject({
			tax_source: "org_default",
			tax_needs_review: true,
			tax_review_ack_by: null,
			tax_review_ack_at: null,
		});
	});

	describe("acknowledgment across a changed review reason (same source)", () => {
		const MN_SET = { ...WI_SET, id: "set-mn", state_code: "MN" };
		const draftWithReason = (reason: string) => ({
			version: 2,
			locked_at: "draft",
			source: "provider",
			rate_set_id: "set-il",
			review_reason: reason,
			rounding: "line_floor",
			groups: [],
		});
		const prev = { tax_source: "provider", tax_needs_review: true };

		it("clears the acknowledgment when the reason changes", async () => {
			resolveAddressTax.mockResolvedValue({
				...RESOLVED,
				rate_set: MN_SET,
			});
			const tx = quoteTx({
				prev,
				snapshot: draftWithReason("Not registered to collect in IL"),
			});
			await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
			expect(quoteData(tx)).toMatchObject({
				tax_source: "provider",
				tax_needs_review: true,
				tax_review_ack_by: null,
				tax_review_ack_at: null,
			});
			expect(quoteData(tx).tax_snapshot.review_reason).toBe(
				"Not registered to collect in MN",
			);
		});

		it("keeps the acknowledgment when the reason is unchanged", async () => {
			resolveAddressTax.mockResolvedValue({
				...RESOLVED,
				rate_set: MN_SET,
			});
			const tx = quoteTx({
				prev,
				snapshot: draftWithReason("Not registered to collect in MN"),
			});
			await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
			const data = quoteData(tx);
			expect(data.tax_needs_review).toBe(true);
			expect(data).not.toHaveProperty("tax_review_ack_by");
			expect(data).not.toHaveProperty("tax_review_ack_at");
		});
	});

	// Review Focus 5
	it("taxes as manual when the plan no longer includes tax_auto, without stamping the default", async () => {
		orgCtx.mockResolvedValue({
			...AUTO_ORG,
			stored_mode: "manual",
			mode: "manual",
		});
		const manualTx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(manualTx));
		const manualTax = quoteData(manualTx).tax_amount;

		vi.clearAllMocks();
		orgCtx.mockResolvedValue({
			...AUTO_ORG,
			auto_entitled: false,
			mode: "manual",
		});
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(quoteData(tx)).toMatchObject({
			tax_source: "org_default",
			tax_needs_review: false,
			tax_amount: 5,
		});
		expect(quoteData(tx).tax_amount).toBe(manualTax);
		// A lapsed entitlement is not the dispatcher's choice: stamping here would read as
		// manual_override once tax_auto returns.
		expect(
			(tx.quote_line_item.update.mock.calls[0] as any)[0].data
				.tax_group_id,
		).toBeNull();
	});

	it("manual mode stamps the org default onto a taxable ungrouped line, as today", async () => {
		orgCtx.mockResolvedValue({
			...AUTO_ORG,
			stored_mode: "manual",
			mode: "manual",
		});
		const tx = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(
			(tx.quote_line_item.update.mock.calls[0] as any)[0].data
				.tax_group_id,
		).toBe("g-def");
	});

	it("resolves a job visit from the cache only", async () => {
		const tx = {
			job_visit: {
				findFirst: vi.fn(async () => ({
					tax_snapshot: null,
					discount_type: null,
					discount_value: null,
					line_items: [
						{ id: "v1", total: 100, tax_group_id: null, taxable: true },
					],
					job: {
						client_id: "c1",
						address: ADDRESS,
						coords: null,
					},
				})),
				update: vi.fn(async () => ({})),
			},
			job_visit_line_item: { update: vi.fn(async () => ({})) },
			client: {
				findFirst: vi.fn(async () => ({
					is_tax_exempt: false,
					tax_group_id: null,
				})),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => DEFAULT_ROW),
			},
		};
		await recomputeDocumentTotals("job_visit", "v", "org1", asTx(tx));
		expect(resolveAddressTax).toHaveBeenCalledWith(
			expect.objectContaining({ cacheOnly: true }),
		);
		const quote = quoteTx();
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(quote));
		expect(resolveAddressTax).toHaveBeenLastCalledWith(
			expect.not.objectContaining({ cacheOnly: true }),
		);
	});

	it("manual mode stamps the org default onto non-taxable and zero-total ungrouped lines, as today", async () => {
		orgCtx.mockResolvedValue({
			...AUTO_ORG,
			stored_mode: "manual",
			mode: "manual",
		});
		const tx = quoteTx({
			lines: [
				{ id: "l1", total: 100, tax_group_id: null, taxable: false },
				{ id: "l2", total: 0, tax_group_id: null, taxable: true },
			],
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		const lineData = tx.quote_line_item.update.mock.calls.map(
			(c) => (c as any)[0].data,
		);
		expect(lineData.map((d) => d.tax_group_id)).toEqual(["g-def", "g-def"]);
		expect(quoteData(tx)).toMatchObject({
			tax_amount: 0,
			tax_source: null,
			tax_needs_review: false,
		});
	});

	it("falls back without throwing when the resolver itself throws (e.g. a DB error)", async () => {
		resolveAddressTax.mockRejectedValue(new Error("P2002 on address_key"));
		const tx = quoteTx();
		await expect(
			lockDocumentTaxSnapshot("quote", "q1", "org1", asTx(tx)),
		).resolves.toBeUndefined();
		expect(logError).toHaveBeenCalledTimes(1);
		expect(quoteData(tx)).toMatchObject({
			tax_source: "org_default",
			tax_needs_review: true,
			tax_resolution_id: null,
			tax_amount: 5,
		});
		expect(quoteData(tx).tax_snapshot.review_reason).toBe(
			"Tax rate lookup failed",
		);
	});
});

describe("recomputeDocumentTotals — line taxable is the dispatcher's", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue(RESOLVED);
	});

	it("leaves an uncategorised non-taxable line untaxed and never returns blocks", async () => {
		const tx = quoteTx({
			lines: [
				{ id: "l1", total: 100, tax_group_id: null, taxable: false },
				{ id: "l2", total: 50, tax_group_id: null, taxable: true },
			],
		});
		const result = await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));

		expect(result).toEqual({ ok: true });
		const lineData = (id: string) =>
			(tx.quote_line_item.update.mock.calls as any[]).find((c) => c[0].where.id === id)[0]
				.data;
		expect(lineData("l1")).toMatchObject({ tax_amount: 0 });
		expect(lineData("l1")).not.toHaveProperty("taxable");
		expect(lineData("l2")).not.toHaveProperty("taxable");
		const data = quoteData(tx);
		expect(data.tax_amount).toBe(2.75);
		expect(data.tax_snapshot).not.toHaveProperty("lines");
		expect(data.tax_snapshot).not.toHaveProperty("taxability_blocks");
	});

	it("locks without returning anything", async () => {
		const tx = quoteTx();
		await expect(lockDocumentTaxSnapshot("quote", "q1", "org1", asTx(tx))).resolves.toBeUndefined();
	});

	// The exemption zeroes tax without rewriting the stored flags, so lifting it restores tax.
	it("zeroes tax for an exempt client without touching any line's stored taxable", async () => {
		const tx = quoteTx({
			client: { is_tax_exempt: true, tax_group_id: null },
			lines: [
				{ id: "l1", total: 100, tax_group_id: null, taxable: true },
				{ id: "l2", total: 40, tax_group_id: null, taxable: true },
			],
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		const writes = (tx.quote_line_item.update.mock.calls as any[]).map((c) => c[0].data);
		expect(writes).toHaveLength(2);
		for (const w of writes) {
			expect(w).toMatchObject({ tax_amount: 0 });
			expect(w).not.toHaveProperty("taxable");
		}
		expect(quoteData(tx).tax_amount).toBe(0);
	});
});

describe("recomputeDocumentTotals — invoices", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue(RESOLVED);
	});

	function invoiceTx(
		over: {
			jobs?: unknown[];
			adjusts?: string | null;
			original?: unknown;
		} = {},
	) {
		return {
			invoice: {
				findFirst: vi.fn(async ({ where }: any) =>
					where.id === "orig"
						? over.original
						: {
								client_id: "c1",
								tax_snapshot: null,
								discount_type: null,
								discount_value: null,
								amount_paid: 0,
								adjusts_invoice_id: over.adjusts ?? null,
								tax_source: null,
								tax_needs_review: false,
								line_items: [
									{
										id: "l1",
										total: -100,
										tax_group_id: null,
										taxable: true,
									},
								],
								jobs: over.jobs ?? [
									{ job: { address: ADDRESS, coords: null } },
								],
								client: {
									address: "1 Client Way, Onalaska, WI 54650",
									coords: null,
								},
							},
				),
				update: vi.fn(async () => ({})),
			},
			invoice_line_item: { update: vi.fn(async () => ({})) },
			client: {
				findFirst: vi.fn(async () => ({
					is_tax_exempt: false,
					tax_group_id: null,
				})),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => null),
			},
		};
	}

	it("uses the first linked job's address, else the client's", async () => {
		await recomputeDocumentTotals(
			"invoice",
			"i1",
			"org1",
			asTx(invoiceTx()),
		);
		expect(resolveAddressTax).toHaveBeenLastCalledWith(
			expect.objectContaining({ address: ADDRESS }),
		);
		await recomputeDocumentTotals(
			"invoice",
			"i1",
			"org1",
			asTx(invoiceTx({ jobs: [] })),
		);
		expect(resolveAddressTax).toHaveBeenLastCalledWith(
			expect.objectContaining({
				address: "1 Client Way, Onalaska, WI 54650",
			}),
		);
	});

	// Review Focus 1
	it("taxes a credit adjustment at the original invoice's rate set, without a lookup", async () => {
		loadRateSet.mockResolvedValue(WI_SET);
		const tx = invoiceTx({
			adjusts: "orig",
			original: {
				tax_resolution_id: "res-orig",
				tax_snapshot: {
					version: 2,
					locked_at: "2026-09-01T00:00:00.000Z",
					source: "provider",
					rate_set_id: "set-1",
					rounding: "line_floor",
					groups: [],
				},
			},
		});
		await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(loadRateSet).toHaveBeenCalledWith("set-1");
		const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
		expect(data).toMatchObject({
			tax_amount: -5.5,
			tax_source: "provider",
			tax_resolution_id: "res-orig",
			tax_needs_review: false,
		});
		const originalLookup = tx.invoice.findFirst.mock.calls.find(
			(c) => (c as any)[0].where.id === "orig",
		) as any;
		expect(originalLookup[0].where).toEqual({
			id: "orig",
			organization_id: "org1",
		});
	});

	it("gives a credit inheriting a stale original rate a review reason", async () => {
		loadRateSet.mockResolvedValue(WI_SET);
		const tx = invoiceTx({
			adjusts: "orig",
			original: {
				tax_resolution_id: "res-orig",
				tax_snapshot: {
					version: 2,
					locked_at: "2026-09-01T00:00:00.000Z",
					source: "cached_stale",
					rate_set_id: "set-1",
					rounding: "line_floor",
					groups: [],
				},
			},
		});
		await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
		expect(data).toMatchObject({
			tax_source: "cached_stale",
			tax_needs_review: true,
		});
		expect(data.tax_snapshot.review_reason).toBe(
			"Original invoice used a stale rate",
		);
	});

	describe("credit adjustment whose original rate cannot be inherited", () => {
		const NOT_INHERITED = "Original invoice's rate could not be inherited";
		const cases: [string, unknown][] = [
			[
				"a v1 (pre-1a) original",
				{
					version: 1,
					locked_at: "2026-09-01T00:00:00.000Z",
					groups: [],
				},
			],
			[
				"a v2 original taxed at the org default (no rate set)",
				{
					version: 2,
					locked_at: "2026-09-01T00:00:00.000Z",
					source: "org_default",
					rounding: "line_floor",
					groups: [],
				},
			],
		];

		it.each(cases)(
			"looks up fresh and flags review for %s",
			async (_label, snapshot) => {
				const tx = invoiceTx({
					adjusts: "orig",
					original: {
						tax_resolution_id: null,
						tax_snapshot: snapshot,
					},
				});
				await lockDocumentTaxSnapshot(
					"invoice",
					"adj",
					"org1",
					asTx(tx),
				);
				expect(resolveAddressTax).toHaveBeenCalledTimes(1);
				expect(loadRateSet).not.toHaveBeenCalled();
				const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
				expect(data).toMatchObject({
					tax_source: "provider",
					tax_needs_review: true,
					tax_amount: -5.5,
				});
				expect(data.tax_snapshot.review_reason).toBe(NOT_INHERITED);
			},
		);

		it("appends the reason to any other review reason", async () => {
			resolveAddressTax.mockResolvedValue({
				...RESOLVED,
				rate_set: { ...WI_SET, state_code: "MN" },
			});
			const tx = invoiceTx({
				adjusts: "orig",
				original: {
					tax_resolution_id: null,
					tax_snapshot: {
						version: 1,
						locked_at: "2026-09-01T00:00:00.000Z",
						groups: [],
					},
				},
			});
			await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
			const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
			expect(data.tax_snapshot.review_reason).toBe(
				`Not registered to collect in MN; ${NOT_INHERITED}`,
			);
		});

		it("manual mode is unchanged: no lookup, no review", async () => {
			orgCtx.mockResolvedValue({
				...AUTO_ORG,
				stored_mode: "manual",
				mode: "manual",
			});
			const tx = invoiceTx({
				adjusts: "orig",
				original: { tax_resolution_id: null, tax_snapshot: null },
			});
			tx.tax_group.findFirst.mockResolvedValue(DEFAULT_ROW as never);
			await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
			expect(resolveAddressTax).not.toHaveBeenCalled();
			const data = (tx.invoice.update.mock.calls[0] as any)[0].data;
			expect(data).toMatchObject({
				tax_source: "org_default",
				tax_needs_review: false,
			});
		});
	});

	it("orders linked jobs by created_at so the address matches the QuickBooks push", async () => {
		const tx = invoiceTx();
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		const select = (tx.invoice.findFirst.mock.calls[0] as any)[0].select;
		expect(select.jobs).toMatchObject({
			take: 1,
			orderBy: { job: { created_at: "asc" } },
		});
	});

	it("takes the client's address and coords together when the first job's address is blank", async () => {
		const tx = invoiceTx({
			jobs: [{ job: { address: "", coords: { lat: 1, lon: 2 } } }],
		});
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		expect(resolveAddressTax).toHaveBeenLastCalledWith(
			expect.objectContaining({
				address: "1 Client Way, Onalaska, WI 54650",
				coords: null,
			}),
		);
	});
});

describe("recomputeDocumentTotals — rounding mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue(RESOLVED);
	});

	// WI 5% + Dane 0.5%: per line floor is 16 + 1 = 17 (51 total); per rate half-up is
	// 49.95 → 50 and 4.995 → 5 (55 total).
	const THREE_LINES: Line[] = ["l1", "l2", "l3"].map((id) => ({
		id,
		total: 3.33,
		tax_group_id: null,
		taxable: true,
	}));
	const lineTax = (t: ReturnType<typeof quoteTx>) =>
		t.quote_line_item.update.mock.calls.map((c) => [
			(c as any)[0].where.id,
			(c as any)[0].data.tax_amount,
		]);

	it("writes jurisdiction_half_up for a document with no snapshot yet", async () => {
		const tx = quoteTx({ lines: THREE_LINES });
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		const data = quoteData(tx);
		expect(data.tax_amount).toBe(0.55);
		expect(data.total).toBe(10.54);
		expect(data.tax_snapshot.rounding).toBe("jurisdiction_half_up");
		expect(data.tax_snapshot.total_tax_cents).toBe(55);
		expect(lineTax(tx)).toEqual([
			["l1", 0.19],
			["l2", 0.19],
			["l3", 0.17],
		]);
	});

	it("keeps line_floor for a draft whose stored v2 snapshot is line_floor", async () => {
		const tx = quoteTx({
			lines: THREE_LINES,
			snapshot: { version: 2, locked_at: "draft", rounding: "line_floor", groups: [] },
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		const data = quoteData(tx);
		expect(data.tax_amount).toBe(0.51);
		expect(data.tax_snapshot.rounding).toBe("line_floor");
		expect(lineTax(tx).map(([, t]) => t)).toEqual([0.17, 0.17, 0.17]);
	});

	it("keeps line_floor for a draft whose stored snapshot is v1", async () => {
		const tx = quoteTx({
			lines: THREE_LINES,
			snapshot: { version: 1, locked_at: "draft", groups: [] },
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(quoteData(tx).tax_amount).toBe(0.51);
		expect(quoteData(tx).tax_snapshot.rounding).toBe("line_floor");
	});

	it("keeps jurisdiction_half_up once written", async () => {
		const tx = quoteTx({
			lines: THREE_LINES,
			snapshot: {
				version: 2,
				locked_at: "draft",
				rounding: "jurisdiction_half_up",
				groups: [],
			},
		});
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(quoteData(tx).tax_amount).toBe(0.55);
		expect(quoteData(tx).tax_snapshot.rounding).toBe("jurisdiction_half_up");
	});

	it("applies half-up in manual mode too", async () => {
		orgCtx.mockResolvedValue({ ...AUTO_ORG, stored_mode: "manual", mode: "manual" });
		const tx = quoteTx({ lines: THREE_LINES });
		await recomputeDocumentTotals("quote", "q1", "org1", asTx(tx));
		expect(resolveAddressTax).not.toHaveBeenCalled();
		// Default group 5%: floor would be 48.
		expect(quoteData(tx).tax_amount).toBe(0.5);
		expect(quoteData(tx).tax_snapshot.rounding).toBe("jurisdiction_half_up");
	});
});

describe("recomputeDocumentTotals — adjustment inherits the original's rounding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue(RESOLVED);
		loadRateSet.mockResolvedValue(WI_SET);
	});

	// Three -$3.33 credits at WI 5% + 0.5%: line floor -51, per-rate half-up -55.
	function adjustmentTx(original: unknown) {
		return {
			invoice: {
				findFirst: vi.fn(async ({ where }: any) =>
					where.id === "orig"
						? original
						: {
								client_id: "c1",
								tax_snapshot: null,
								discount_type: null,
								discount_value: null,
								amount_paid: 0,
								adjusts_invoice_id: "orig",
								tax_source: null,
								tax_needs_review: false,
								line_items: ["l1", "l2", "l3"].map((id) => ({
									id,
									total: -3.33,
									tax_group_id: null,
									taxable: true,
								})),
								jobs: [{ job: { address: ADDRESS, coords: null } }],
								client: { address: ADDRESS, coords: null },
							},
				),
				update: vi.fn(async () => ({})),
			},
			invoice_line_item: { update: vi.fn(async () => ({})) },
			client: {
				findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			},
			tax_group: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
		};
	}
	const lockedOriginal = (rounding: string) => ({
		tax_resolution_id: "res-orig",
		tax_snapshot: {
			version: 2,
			locked_at: "2026-09-01T00:00:00.000Z",
			source: "provider",
			rate_set_id: "set-1",
			rounding,
			groups: [],
		},
	});
	const written = (tx: ReturnType<typeof adjustmentTx>) =>
		(tx.invoice.update.mock.calls[0] as any)[0].data;

	it("keeps line_floor when the original was line_floor", async () => {
		const tx = adjustmentTx(lockedOriginal("line_floor"));
		await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
		expect(written(tx).tax_amount).toBe(-0.51);
		expect(written(tx).tax_snapshot.rounding).toBe("line_floor");
		const lookup = tx.invoice.findFirst.mock.calls.find(
			(c) => Object.keys((c as any)[0].select ?? {}).join() === "tax_snapshot",
		) as any;
		expect(lookup[0].where).toEqual({ id: "orig", organization_id: "org1" });
	});

	it("uses half-up when the original was half-up", async () => {
		const tx = adjustmentTx(lockedOriginal("jurisdiction_half_up"));
		await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
		expect(written(tx).tax_amount).toBe(-0.55);
		expect(written(tx).tax_snapshot.rounding).toBe("jurisdiction_half_up");
	});

	it("falls back to half-up when the original has no snapshot", async () => {
		const tx = adjustmentTx({ tax_resolution_id: null, tax_snapshot: null });
		await lockDocumentTaxSnapshot("invoice", "adj", "org1", asTx(tx));
		expect(written(tx).tax_snapshot.rounding).toBe("jurisdiction_half_up");
	});
});

describe("recomputeDocumentTotals — adopted QuickBooks tax", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(AUTO_ORG);
		resolveAddressTax.mockResolvedValue(RESOLVED);
	});

	const LOCK = new Date("2026-10-19T12:00:00.000Z");
	const ACK_AT = new Date("2026-10-18T09:00:00.000Z");

	/** A stored invoice row: reads return it whatever the select, writes merge into it. */
	function statefulTx() {
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
			tax_review_ack_by: null,
			tax_review_ack_at: null,
			recurring_plan_id: null,
			line_items: [line],
			jobs: [
				{ job: { address: ADDRESS, coords: null, recurring_plan_id: null } },
			],
			client: { is_tax_exempt: false, address: "1 Client Way, Onalaska, WI 54650", coords: null },
		};
		return {
			row,
			line,
			invoice: {
				findFirst: vi.fn(async () => row),
				update: vi.fn(async ({ data }: any) => Object.assign(row, data)),
			},
			invoice_line_item: { update: vi.fn(async ({ data }: any) => Object.assign(line, data)) },
			organization: { findUnique: vi.fn(async () => ({ qb_realm_id: "realm1" })) },
			client: {
				findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			},
			tax_group: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => null),
			},
		};
	}

	/** What confirmQuickBooksTax does once QuickBooks answered with `qbTaxCents`. */
	async function adopt(tx: ReturnType<typeof statefulTx>, qbTaxCents: number) {
		const { lines, shipAddr, clientExempt } = buildInvoicePayload(tx.row as any, null);
		const fingerprint = qbPushFingerprint(lines, shipAddr, clientExempt);
		await applyQbAdoption(asTx(tx), "i1", "org1", { qbTaxCents, fingerprint });
		return fingerprint;
	}

	async function adoptedDraft(qbTaxCents = 612) {
		const tx = statefulTx();
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		const fingerprint = await adopt(tx, qbTaxCents);
		Object.assign(tx.row, { tax_review_ack_by: "u1", tax_review_ack_at: ACK_AT });
		vi.clearAllMocks();
		return { tx, fingerprint };
	}

	const withRate = (rate: number, over: object = {}) => ({
		...RESOLVED,
		rate_set: {
			...WI_SET,
			id: "set-2",
			total_rate: rate,
			components: [{ ...WI_SET.components[0], rate }],
		},
		...over,
	});

	it("keeps the adoption and its acknowledgment when nothing QuickBooks taxes changed", async () => {
		const { tx, fingerprint } = await adoptedDraft();
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(tx.row).toMatchObject({
			tax_amount: 6.12,
			total: 106.12,
			balance_due: 106.12,
			tax_source: "qb_ast",
			tax_needs_review: true,
			tax_review_ack_by: "u1",
			tax_review_ack_at: ACK_AT,
		});
		expect(tx.row.tax_snapshot).toMatchObject({
			source: "qb_ast",
			qb_tax_cents: 612,
			qb_fingerprint: fingerprint,
			qb_review: true,
			review_reason: "QuickBooks calculated $6.12 (you estimated $5.50)",
			total_tax_cents: 550,
		});
	});

	it("drops the adoption and clears its review when a line is edited", async () => {
		const { tx } = await adoptedDraft();
		Object.assign(tx.line, { total: 200, unit_price: 200 });
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(tx.row).toMatchObject({
			tax_amount: 11,
			total: 211,
			balance_due: 211,
			tax_source: "provider",
			tax_needs_review: false,
		});
		expect(tx.row.tax_snapshot.source).toBe("provider");
		for (const k of ["qb_tax_cents", "qb_fingerprint", "qb_review", "review_reason"]) {
			expect(tx.row.tax_snapshot).not.toHaveProperty(k);
		}
	});

	it("lets the resolver's own review decide once the adoption is dropped", async () => {
		const { tx } = await adoptedDraft();
		resolveAddressTax.mockResolvedValue({ ...RESOLVED, stale: true, reasons: ["Rate is stale"] });
		Object.assign(tx.line, { total: 200, unit_price: 200 });
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(tx.row.tax_needs_review).toBe(true);
		expect(tx.row.tax_snapshot.review_reason).toContain("Rate is stale");
		expect(tx.row.tax_snapshot.review_reason).not.toContain("QuickBooks");
		expect(tx.row.tax_snapshot).not.toHaveProperty("qb_review");
	});

	it("carries the QuickBooks figure into the locked snapshot", async () => {
		const { tx } = await adoptedDraft();
		await lockDocumentTaxSnapshot("invoice", "i1", "org1", asTx(tx), LOCK);

		expect(tx.row).toMatchObject({ tax_amount: 6.12, total: 106.12, tax_source: "qb_ast" });
		expect(tx.row.tax_snapshot).toMatchObject({
			locked_at: LOCK.toISOString(),
			source: "qb_ast",
			qb_tax_cents: 612,
		});
	});

	it("keeps the QuickBooks figure when the lock re-resolves our estimate to a new rate", async () => {
		const { tx } = await adoptedDraft();
		resolveAddressTax.mockResolvedValue(withRate(0.06, { resolution_id: "res-2" }));
		await lockDocumentTaxSnapshot("invoice", "i1", "org1", asTx(tx), LOCK);

		expect(tx.row.tax_snapshot).toMatchObject({
			locked_at: LOCK.toISOString(),
			total_tax_cents: 600,
			rate_set_id: "set-2",
			qb_tax_cents: 612,
			review_reason: "QuickBooks calculated $6.12 (you estimated $6.00)",
		});
		expect(tx.row).toMatchObject({
			tax_amount: 6.12,
			total: 106.12,
			tax_review_ack_by: "u1",
			tax_review_ack_at: ACK_AT,
		});
	});

	it("hands the review slot back to the resolver once our estimate meets QuickBooks' figure", async () => {
		const { tx } = await adoptedDraft();
		resolveAddressTax.mockResolvedValue(
			withRate(0.0612, { stale: true, reasons: ["Rate is stale"] }),
		);
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(tx.row).toMatchObject({
			tax_amount: 6.12,
			tax_source: "qb_ast",
			tax_needs_review: true,
			tax_review_ack_at: null,
		});
		expect(tx.row.tax_snapshot.qb_review).toBe(false);
		expect(tx.row.tax_snapshot.review_reason).toContain("Rate is stale");
	});

	it("keeps a QuickBooks-unavailable review through recompute and lock", async () => {
		const tx = statefulTx();
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		Object.assign(tx.row, {
			tax_needs_review: true,
			tax_review_ack_by: "u1",
			tax_review_ack_at: ACK_AT,
			tax_snapshot: {
				...tx.row.tax_snapshot,
				review_reason: QB_UNAVAILABLE_REASON,
				qb_review: true,
			},
		});

		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		await lockDocumentTaxSnapshot("invoice", "i1", "org1", asTx(tx), LOCK);

		expect(tx.row).toMatchObject({
			tax_amount: 5.5,
			tax_source: "provider",
			tax_needs_review: true,
			tax_review_ack_at: ACK_AT,
		});
		expect(tx.row.tax_snapshot).toMatchObject({
			locked_at: LOCK.toISOString(),
			source: "provider",
			review_reason: QB_UNAVAILABLE_REASON,
			qb_review: true,
		});
		expect(tx.row.tax_snapshot).not.toHaveProperty("qb_tax_cents");
	});

	it("keeps an unavailable review over a still-valid earlier adoption", async () => {
		const { tx } = await adoptedDraft();
		tx.row.tax_snapshot = {
			...tx.row.tax_snapshot,
			review_reason: QB_UNAVAILABLE_REASON,
			qb_review: true,
		};
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(tx.row).toMatchObject({
			tax_amount: 6.12,
			tax_source: "qb_ast",
			tax_needs_review: true,
		});
		expect(tx.row.tax_snapshot).toMatchObject({
			qb_tax_cents: 612,
			review_reason: QB_UNAVAILABLE_REASON,
		});
	});

	it("leaves an invoice with no QuickBooks state on the plain path", async () => {
		const tx = statefulTx();
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));
		await recomputeDocumentTotals("invoice", "i1", "org1", asTx(tx));

		expect(tx.organization.findUnique).not.toHaveBeenCalled();
		expect(tx.invoice.update).toHaveBeenCalledTimes(2);
		expect(tx.row).toMatchObject({ tax_amount: 5.5, total: 105.5, tax_source: "provider" });
		for (const k of ["qb_tax_cents", "qb_fingerprint", "qb_review"]) {
			expect(tx.row.tax_snapshot).not.toHaveProperty(k);
		}
	});
});
