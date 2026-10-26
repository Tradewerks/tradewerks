import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", () => ({
	db: { $extends: vi.fn() },
	generateInvoiceNumber: vi.fn().mockResolvedValue("INV-0001"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
}));

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeDocumentTotals: vi.fn().mockResolvedValue(true),
	lockDocumentTaxSnapshot: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { createInvoiceRecord, type CreateInvoicePayload } from "../invoiceService.js";
import { recomputeDocumentTotals } from "../../lib/recomputeDocumentTotals.js";
import type { Prisma } from "../../../generated/prisma/client.js";

const ORG = "org-1";
const CLIENT = "client-1";
const JOB = "job-1";
const VISIT = "visit-1";

type LineItem = {
	total: number;
	source_job_id: string | null;
	source_visit_id: string | null;
};

/**
 * Minimal in-memory stand-in for the Prisma transaction client: enough of
 * invoice / invoice_job / invoice_visit / invoice_line_item for the create path
 * plus syncBilledAmounts, so the billed_amount writes can be read back.
 */
const makeTx = (lineItems: LineItem[]) => {
	const jobLinks: Array<{ job_id: string; billed_amount: number | null }> = [];
	const visitLinks: Array<{ visit_id: string; billed_amount: number | null }> = [];

	const tx = {
		client: {
			findFirst: vi.fn().mockResolvedValue({ id: CLIENT, is_tax_exempt: false, tax_group_id: null }),
			update: vi.fn(),
		},
		recurring_plan: { findFirst: vi.fn() },
		job: { findMany: vi.fn().mockResolvedValue([{ id: JOB, client_id: CLIENT }]) },
		job_visit: {
			findMany: vi.fn().mockResolvedValue([{ id: VISIT, job: { client_id: CLIENT } }]),
		},
		invoice: {
			create: vi.fn().mockResolvedValue({ id: "inv-1" }),
			findFirst: vi.fn().mockResolvedValue({ id: "inv-1" }),
			// No credit adjustments: the chain is this invoice alone.
			findMany: vi.fn().mockResolvedValue([]),
		},
		invoice_line_item: {
			createMany: vi.fn().mockResolvedValue({ count: lineItems.length }),
			findMany: vi.fn().mockResolvedValue(lineItems),
		},
		invoice_job: {
			createMany: vi.fn().mockImplementation(({ data }: { data: typeof jobLinks }) => {
				jobLinks.push(...data);
				return { count: data.length };
			}),
			findMany: vi.fn().mockImplementation(() => jobLinks.map(({ job_id }) => ({ job_id }))),
			update: vi.fn().mockImplementation(({ where, data }: { where: { invoice_id_job_id: { job_id: string } }; data: { billed_amount: number } }) => {
				const row = jobLinks.find((l) => l.job_id === where.invoice_id_job_id.job_id)!;
				row.billed_amount = data.billed_amount;
				return row;
			}),
		},
		invoice_visit: {
			createMany: vi.fn().mockImplementation(({ data }: { data: typeof visitLinks }) => {
				visitLinks.push(...data);
				return { count: data.length };
			}),
			findMany: vi.fn().mockImplementation(() => visitLinks.map(({ visit_id }) => ({ visit_id }))),
			update: vi.fn().mockImplementation(({ where, data }: { where: { invoice_id_visit_id: { visit_id: string } }; data: { billed_amount: number } }) => {
				const row = visitLinks.find((l) => l.visit_id === where.invoice_id_visit_id.visit_id)!;
				row.billed_amount = data.billed_amount;
				return row;
			}),
		},
	};

	return { tx: tx as unknown as Prisma.TransactionClient, jobLinks, visitLinks };
};

const line = (
	total: number,
	source: { job?: string; visit?: string } = {},
): LineItem => ({
	total,
	source_job_id: source.job ?? null,
	source_visit_id: source.visit ?? null,
});

const payload = (overrides: Partial<CreateInvoicePayload> = {}): CreateInvoicePayload => ({
	client_id: CLIENT,
	line_items: [{ name: "Part", quantity: 1, unit_price: 100, total: 100 }],
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createInvoiceRecord billed_amount", () => {
	it("derives a visit's billed_amount from its attributed line items", async () => {
		const { tx, visitLinks } = makeTx([line(300, { visit: VISIT, job: JOB })]);

		await createInvoiceRecord(
			payload({ visit_billings: [{ visit_id: VISIT, billed_amount: 999 }] }),
			ORG,
			null,
			tx,
		);

		expect(visitLinks[0].billed_amount).toBe(300);
	});

	it("ignores an inflated job billed_amount from the caller", async () => {
		const { tx, jobLinks } = makeTx([line(250, { job: JOB })]);

		await createInvoiceRecord(
			payload({ job_billings: [{ job_id: JOB, billed_amount: 10000 }] }),
			ORG,
			null,
			tx,
		);

		expect(jobLinks[0].billed_amount).toBe(250);
	});

	it("does not let the same money be billed on both a job and its visit", async () => {
		// The caller claims 500 on the job and 500 on its visit for one 500 line.
		// Only the visit carries it: a job row counts lines with no source visit.
		const { tx, jobLinks, visitLinks } = makeTx([line(500, { job: JOB, visit: VISIT })]);

		await createInvoiceRecord(
			payload({
				job_billings: [{ job_id: JOB, billed_amount: 500 }],
				visit_billings: [{ visit_id: VISIT, billed_amount: 500 }],
			}),
			ORG,
			null,
			tx,
		);

		expect(visitLinks[0].billed_amount).toBe(500);
		expect(jobLinks[0].billed_amount).toBe(0);
	});

	it("keeps traceability-only job links null", async () => {
		const { tx, jobLinks } = makeTx([line(100, { visit: VISIT, job: JOB })]);

		await createInvoiceRecord(
			payload({
				job_ids: [JOB],
				visit_billings: [{ visit_id: VISIT, billed_amount: 100 }],
			}),
			ORG,
			null,
			tx,
		);

		expect(jobLinks).toEqual([{ invoice_id: "inv-1", job_id: JOB, billed_amount: null }]);
	});

	it("bills a job link that is also listed in job_ids", async () => {
		const { tx, jobLinks } = makeTx([line(400, { job: JOB })]);

		await createInvoiceRecord(
			payload({ job_ids: [JOB], job_billings: [{ job_id: JOB, billed_amount: 400 }] }),
			ORG,
			null,
			tx,
		);

		expect(jobLinks).toHaveLength(1);
		expect(jobLinks[0].billed_amount).toBe(400);
	});
});

// Recompute reads the service address from the earliest linked job, so every link
// must exist before it runs.
describe("createInvoiceRecord tax recompute ordering", () => {
	const linksAtRecompute = (jobLinks: unknown[], visitLinks: unknown[]) => {
		const seen: Array<{ jobs: number; visits: number }> = [];
		vi.mocked(recomputeDocumentTotals).mockImplementation(async () => {
			seen.push({ jobs: jobLinks.length, visits: visitLinks.length });
			return true as never;
		});
		return seen;
	};

	it("recomputes after billed job and visit links exist", async () => {
		const { tx, jobLinks, visitLinks } = makeTx([line(500, { job: JOB, visit: VISIT })]);
		const seen = linksAtRecompute(jobLinks, visitLinks);

		await createInvoiceRecord(
			payload({
				job_billings: [{ job_id: JOB, billed_amount: 500 }],
				visit_billings: [{ visit_id: VISIT, billed_amount: 500 }],
			}),
			ORG,
			null,
			tx,
		);

		expect(seen).toEqual([{ jobs: 1, visits: 1 }]);
	});

	it("recomputes after traceability-only job links exist", async () => {
		const { tx, jobLinks, visitLinks } = makeTx([line(100, { visit: VISIT, job: JOB })]);
		const seen = linksAtRecompute(jobLinks, visitLinks);

		await createInvoiceRecord(
			payload({
				job_ids: [JOB],
				visit_billings: [{ visit_id: VISIT, billed_amount: 100 }],
			}),
			ORG,
			null,
			tx,
		);

		expect(seen).toEqual([{ jobs: 1, visits: 1 }]);
	});
});

describe("createInvoiceRecord tax group ownership", () => {
	it("refuses a line whose tax_group_id belongs to another organization", async () => {
		const { tx } = makeTx([]);
		const findMany = vi.fn().mockResolvedValue([{ id: "g-own" }]);
		Object.assign(tx, { tax_group: { findMany } });

		await expect(
			createInvoiceRecord(
				payload({
					line_items: [
						{ name: "Part", quantity: 1, unit_price: 100, tax_group_id: "g-own" },
						{ name: "Labor", quantity: 1, unit_price: 50, tax_group_id: "g-foreign" },
					],
				}),
				ORG,
				null,
				tx,
			),
		).rejects.toThrow("Tax group not found: g-foreign");
		expect(findMany).toHaveBeenCalledWith({
			where: { id: { in: ["g-own", "g-foreign"] }, organization_id: ORG },
			select: { id: true },
		});
		expect(tx.invoice_line_item.createMany).not.toHaveBeenCalled();
	});
});
