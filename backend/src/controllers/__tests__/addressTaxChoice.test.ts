import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, taxMode, orgCtx, loadRateSet, resolveAddressTax, logActivity } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb: Record<string, any> = {
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return {
		mockDb,
		taxMode: vi.fn(async () => "manual"),
		orgCtx: vi.fn(),
		loadRateSet: vi.fn(),
		resolveAddressTax: vi.fn(),
		logActivity: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateJobNumber: vi.fn(),
	generateQuoteNumber: vi.fn(),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));
vi.mock("../../lib/geocode.js", () => ({ fillCoords: vi.fn(async () => null) }));
vi.mock("../../services/logger.js", () => ({
	logActivity,
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn(() => ({ emit: vi.fn() })),
	emitToOrg: vi.fn(),
}));
vi.mock("../../services/entitlementService.js", () => ({ isModuleOn: vi.fn() }));
vi.mock("../../services/disputeService.js", () => ({
	hasOpenDispute: vi.fn(async () => false),
	openDisputeStatusChangeRefusal: vi.fn(async () => null),
}));
vi.mock("../../services/quickbooksService.js", () => ({ getOrgRealmId: vi.fn() }));
vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: taxMode,
	getOrgTaxContext: orgCtx,
}));
vi.mock("../../services/tax/taxResolver.js", () => ({ loadRateSet, resolveAddressTax }));

import type { Request } from "express";
import { updateQuote } from "../quotesController.js";
import { updateJob } from "../jobsController.js";
import { updateClient } from "../clientsController.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { applyAddressTaxChoice, isAddressTaxChoiceRefusal } from "../../lib/addressTaxChoice.js";

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
const groupRow = (id: string, name: string, rate: number, extra: object = {}) => ({
	id,
	name,
	organization_id: "org1",
	is_active: true,
	is_default: false,
	rates: [{ sort_order: 0, tax_rate: { id: `${id}-r`, name, rate, jurisdiction: null } }],
	...extra,
});
const WI_STANDARD = groupRow("g-def", "WI Standard", 0.0825, { is_default: true });
const CHICAGO = groupRow("33333333-3333-4333-8333-333333333333", "Chicago", 0.1025);
const FOREIGN = groupRow("44444444-4444-4444-8444-444444444444", "Elsewhere", 0.05, {
	organization_id: "org2",
});
const INACTIVE = groupRow("55555555-5555-4555-8555-555555555555", "Old", 0.05, {
	is_active: false,
});
const GROUPS = [WI_STANDARD, CHICAGO, FOREIGN, INACTIVE];

const KEPT = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs1",
	sourcing: "D",
	rounding: "jurisdiction_half_up",
	kept_from_auto: true,
	groups: [],
};
const LOCKED_KEPT = { ...KEPT, locked_at: "2026-10-01T00:00:00.000Z" };
const ORG_DEFAULT = {
	version: 2,
	locked_at: "draft",
	source: "org_default",
	rounding: "jurisdiction_half_up",
	groups: [],
};
const OLD_ADDRESS = "400 Main St, La Crosse, WI 54601";
const NEW_ADDRESS = "100 N State St, Chicago, IL 60602";

type Row = Record<string, any>;
const merge = (rows: Row[], id: string, data: Row) => Object.assign(rows.find((r) => r.id === id)!, data);
const taxRow = (snapshot: unknown, tax = 23.1) => ({
	tax_snapshot: snapshot,
	tax_source: "provider",
	tax_needs_review: false,
	tax_resolution_id: "res-1",
	tax_amount: tax,
	discount_type: null,
	discount_value: null,
});
/** Q-0010: one taxable $420 line, one non-taxable $190 line. */
const lines = (prefix: string) => [
	{ id: `${prefix}1`, total: 420, tax_group_id: null, taxable: true },
	{ id: `${prefix}2`, total: 190, tax_group_id: null, taxable: false },
];

/** A small in-memory org: one client, its quote, job, visits and invoices. */
function seed(o: {
	quoteSnapshot?: unknown;
	jobSnapshot?: unknown;
	visits?: Row[];
	invoices?: Row[];
}) {
	const client: Row = {
		id: "c1",
		name: "Acme",
		address: OLD_ADDRESS,
		coords: null,
		is_tax_exempt: false,
		tax_group_id: null,
	};
	const quote: Row = {
		id: "q1",
		quote_number: "Q-0010",
		status: "Draft",
		client_id: "c1",
		address: OLD_ADDRESS,
		coords: null,
		job: null,
		request_id: null,
		...taxRow(o.quoteSnapshot ?? null),
	};
	const job: Row = {
		id: "j1",
		job_number: "J-0001",
		status: "Scheduled",
		client_id: "c1",
		quote_id: null,
		address: OLD_ADDRESS,
		coords: null,
		created_at: new Date("2026-10-01"),
		...taxRow(o.jobSnapshot ?? null),
	};
	const visits: Row[] = o.visits ?? [];
	const invoices: Row[] = o.invoices ?? [];
	const lineRows: Record<string, Row[]> = {
		q1: lines("ql"),
		j1: lines("jl"),
		...Object.fromEntries(visits.map((v) => [v.id, lines(`${v.id}-l`)])),
		...Object.fromEntries(invoices.map((i) => [i.id, lines(`${i.id}-l`)])),
	};
	const allLines = () => Object.values(lineRows).flat();
	const lineDelegate = (key: string) => ({
		update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) =>
			merge(allLines(), where.id, data),
		),
		findMany: vi.fn(async ({ where }: { where: Row }) =>
			(lineRows[where[key]] ?? []).filter(
				(l) => l.taxable === where.taxable && l.tax_group_id === where.tax_group_id,
			),
		),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			for (const l of allLines().filter((x) => where.id.in.includes(x.id))) {
				Object.assign(l, data);
			}
		}),
	});
	const jobView = () => ({ ...job, quote: null, line_items: lineRows.j1 });
	const invoiceView = (inv: Row) => {
		const linked = inv.job_ids.includes("j1") ? [{ job_id: "j1", job: jobView() }] : [];
		return { ...inv, jobs: linked, client, line_items: lineRows[inv.id] };
	};
	Object.assign(mockDb, {
		client: {
			findFirst: vi.fn(async () => client),
			update: vi.fn(async ({ data }: { data: Row }) => Object.assign(client, data)),
		},
		quote: {
			findFirst: vi.fn(async () => ({ ...quote, line_items: lineRows.q1 })),
			update: vi.fn(async ({ data }: { data: Row }) => Object.assign(quote, data)),
		},
		job: {
			findFirst: vi.fn(async () => jobView()),
			update: vi.fn(async ({ data }: { data: Row }) => {
				Object.assign(job, data);
				return jobView();
			}),
		},
		job_visit: {
			findMany: vi.fn(async ({ where }: { where: Row }) =>
				visits.filter((v) => !where.status.notIn.includes(v.status)),
			),
			findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
				const v = visits.find((x) => x.id === where.id)!;
				return { ...v, job: jobView(), line_items: lineRows[v.id] };
			}),
			update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) =>
				merge(visits, where.id, data),
			),
		},
		invoice: {
			findMany: vi.fn(async ({ where }: { where: Row }) =>
				invoices
					.filter((i) => i.status === where.status)
					.filter((i) =>
						where.jobs.none ? i.job_ids.length === 0 : i.job_ids.includes("j1"),
					)
					.map(invoiceView),
			),
			findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
				invoiceView(invoices.find((i) => i.id === where.id)!),
			),
			update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) =>
				merge(invoices, where.id, data),
			),
		},
		quote_line_item: lineDelegate("quote_id"),
		job_line_item: lineDelegate("job_id"),
		job_visit_line_item: lineDelegate("visit_id"),
		invoice_line_item: lineDelegate("invoice_id"),
		tax_group: {
			findMany: vi.fn(async ({ where }: { where: Row }) =>
				GROUPS.filter((g) => where.id.in.includes(g.id)),
			),
			findFirst: vi.fn(async ({ where }: { where: Row }) =>
				where.is_default
					? WI_STANDARD
					: (GROUPS.find(
							(g) =>
								g.id === where.id &&
								g.organization_id === where.organization_id &&
								g.is_active === where.is_active,
						) ?? null),
			),
		},
	});
	return { client, quote, job, visits, invoices, lineRows };
}

const editQuote = (body: object) =>
	updateQuote({ params: { id: "q1" }, body } as unknown as Request, "org1", {
		dispatcherId: "d1",
	});
const editJob = (body: object) =>
	updateJob({ params: { id: "j1" }, body } as unknown as Request, "org1", { dispatcherId: "d1" });
const editClient = (body: object) => updateClient("c1", body, "org1", { dispatcherId: "d1" });

const choiceLogs = () =>
	logActivity.mock.calls
		.map(([p]) => p)
		.filter((p) => String(p.event_type).endsWith(".tax_address_choice"));

beforeEach(() => {
	vi.clearAllMocks();
	taxMode.mockResolvedValue("manual");
	orgCtx.mockResolvedValue(MANUAL_ORG);
	loadRateSet.mockResolvedValue(LA_CROSSE);
});

describe("updateQuote — address change on a kept-rate quote", () => {
	it("refuses without a choice, before any write", async () => {
		const s = seed({ quoteSnapshot: KEPT });

		const result = await editQuote({ address: NEW_ADDRESS });

		expect(isAddressTaxChoiceRefusal(result)).toBe(true);
		expect(result).toMatchObject({
			code: "ADDRESS_TAX_CHOICE_REQUIRED",
			err: "The address changed on a document taxed at a kept address rate. Choose which tax to use.",
			details: {
				rate_label: "La Crosse, WI",
				rate: 0.055,
				documents: [{ kind: "quote", id: "q1", number: "Q-0010" }],
			},
		});
		expect(mockDb.quote.update).not.toHaveBeenCalled();
		expect(s.quote.address).toBe(OLD_ADDRESS);
		expect(resolveAddressTax).not.toHaveBeenCalled();
	});

	it("an empty address is rejected and nothing is written", async () => {
		// The quote schema requires a non-empty address, so "" never reaches the gate.
		const s = seed({ quoteSnapshot: KEPT });

		const result = await editQuote({ address: "" });

		expect(result.err).toMatch(/Validation failed/);
		expect(mockDb.quote.update).not.toHaveBeenCalled();
		expect(s.quote.address).toBe(OLD_ADDRESS);
	});

	it('"keep" saves the address, keeps the tax and logs the choice', async () => {
		const s = seed({ quoteSnapshot: KEPT });

		const result = await editQuote({ address: NEW_ADDRESS, address_tax_choice: "keep" });

		expect(result.err).toBe("");
		expect(s.quote.address).toBe(NEW_ADDRESS);
		expect(s.quote.tax_amount).toBe(23.1);
		expect(s.quote.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
		expect(choiceLogs()).toEqual([
			expect.objectContaining({
				event_type: "quote.tax_address_choice",
				action: "updated",
				entity_type: "quote",
				entity_id: "q1",
				actor_type: "dispatcher",
				actor_id: "d1",
				reason: "Tax kept at La Crosse, WI rate after address change",
			}),
		]);
		expect(resolveAddressTax).not.toHaveBeenCalled();
	});

	it('"default" re-taxes at the org default group', async () => {
		const s = seed({ quoteSnapshot: KEPT });

		const result = await editQuote({
			address: NEW_ADDRESS,
			address_tax_choice: "default",
			tax_amount: 23.1,
		});

		expect(result.err).toBe("");
		expect(s.quote.address).toBe(NEW_ADDRESS);
		expect(s.quote.tax_amount).toBe(34.65);
		expect(s.quote.tax_source).toBe("org_default");
		expect(s.quote.tax_snapshot).toMatchObject({ source: "org_default" });
		expect(s.quote.tax_snapshot).not.toHaveProperty("kept_from_auto", true);
		expect(choiceLogs()[0].reason).toBe("Tax moved to WI Standard after address change");
		expect(resolveAddressTax).not.toHaveBeenCalled();
	});

	it("{ group_id } stamps the chosen group on the ungrouped taxable lines", async () => {
		const s = seed({ quoteSnapshot: KEPT });

		const result = await editQuote({
			address: NEW_ADDRESS,
			address_tax_choice: { group_id: CHICAGO.id },
		});

		expect(result.err).toBe("");
		expect(s.lineRows.q1[0].tax_group_id).toBe(CHICAGO.id);
		// $420 at 10.25%.
		expect(s.quote.tax_amount).toBe(43.05);
		expect(choiceLogs()[0].reason).toBe("Tax moved to Chicago after address change");
	});

	it.each([
		["a foreign", FOREIGN.id],
		["an inactive", INACTIVE.id],
	])("%s group_id is refused", async (_label, groupId) => {
		const s = seed({ quoteSnapshot: KEPT });

		const result = await editQuote({
			address: NEW_ADDRESS,
			address_tax_choice: { group_id: groupId },
		});

		expect(result.err).toBe("Choose an active tax group");
		expect(s.lineRows.q1[0].tax_group_id).toBeNull();
		expect(choiceLogs()).toEqual([]);
	});

	it("auto mode is not asked", async () => {
		taxMode.mockResolvedValue("auto");
		seed({ quoteSnapshot: KEPT });
		resolveAddressTax.mockResolvedValue({
			kind: "none",
			ambiguous: false,
			resolution_id: null,
			reasons: [],
		});
		orgCtx.mockResolvedValue({ ...MANUAL_ORG, stored_mode: "auto", mode: "auto" });

		const result = await editQuote({ address: NEW_ADDRESS });

		expect(isAddressTaxChoiceRefusal(result)).toBe(false);
		expect(result.err).toBe("");
	});

	it("a manual-mode quote with no kept rate is not asked", async () => {
		const s = seed({ quoteSnapshot: ORG_DEFAULT });

		const result = await editQuote({ address: NEW_ADDRESS });

		expect(result.err).toBe("");
		expect(s.quote.address).toBe(NEW_ADDRESS);
	});

	it("an unchanged address is not asked", async () => {
		seed({ quoteSnapshot: KEPT });

		const result = await editQuote({ address: OLD_ADDRESS, title: "Renamed" });

		expect(result.err).toBe("");
		expect(choiceLogs()).toEqual([]);
	});
});

describe("updateJob — the choice covers the job, its open visits and its draft invoices", () => {
	const family = () =>
		seed({
			jobSnapshot: KEPT,
			visits: [
				{ id: "v1", status: "Scheduled", ...taxRow(null) },
				{ id: "v2", status: "Completed", ...taxRow(KEPT) },
			],
			invoices: [
				{ id: "inv1", invoice_number: "INV-0011", status: "Draft", job_ids: ["j1"], amount_paid: 0, adjusts_invoice_id: null, ...taxRow(null) },
				{ id: "inv2", invoice_number: "INV-0012", status: "Issued", job_ids: ["j1"], amount_paid: 0, adjusts_invoice_id: null, ...taxRow(LOCKED_KEPT) },
			],
		});

	it("refuses without a choice and names the family", async () => {
		const s = family();

		const result = await editJob({ address: NEW_ADDRESS });

		expect(result).toMatchObject({
			code: "ADDRESS_TAX_CHOICE_REQUIRED",
			details: {
				rate_label: "La Crosse, WI",
				documents: [
					{ kind: "job", id: "j1", number: "J-0001" },
					{ kind: "job_visit", id: "v1", number: null },
					{ kind: "invoice", id: "inv1", number: "INV-0011" },
				],
			},
		});
		expect(mockDb.job.update).not.toHaveBeenCalled();
		expect(s.job.address).toBe(OLD_ADDRESS);
	});

	it("an empty address is no change: not asked, not re-taxed, not logged", async () => {
		const s = family();

		const result = await editJob({ address: "", address_tax_choice: "default" });

		expect(result.err).toBe("");
		expect(s.job.address).toBe(OLD_ADDRESS);
		expect(s.job.tax_amount).toBe(23.1);
		expect(s.visits[0].tax_snapshot).toBeNull();
		expect(mockDb.invoice.update).not.toHaveBeenCalled();
		expect(choiceLogs()).toEqual([]);

		const bare = await editJob({ address: "" });
		expect(isAddressTaxChoiceRefusal(bare)).toBe(false);
	});

	it('"default" moves the job, the open visit and the draft invoice; issued stays', async () => {
		const s = family();

		const result = await editJob({ address: NEW_ADDRESS, address_tax_choice: "default" });

		expect(result.err).toBe("");
		expect(s.job.address).toBe(NEW_ADDRESS);
		expect(s.job).toMatchObject({ tax_amount: 34.65, tax_source: "org_default" });
		expect(s.visits[0].tax_snapshot).toMatchObject({ source: "org_default" });
		expect(s.visits[0].tax_amount).toBe(34.65);
		expect(s.invoices[0]).toMatchObject({ tax_amount: 34.65, tax_source: "org_default" });
		// Untouched: the completed visit and the issued invoice.
		expect(s.visits[1].tax_snapshot).toBe(KEPT);
		expect(s.invoices[1].tax_snapshot).toBe(LOCKED_KEPT);
		expect(mockDb.invoice.update).not.toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "inv2" } }),
		);
		expect(choiceLogs().map((p) => [p.event_type, p.entity_id])).toEqual([
			["job.tax_address_choice", "j1"],
			["job_visit.tax_address_choice", "v1"],
			["invoice.tax_address_choice", "inv1"],
		]);
	});

	it("a completed job keeps its tax; its open visit and draft invoice still move", async () => {
		const s = family();
		s.job.status = "Completed";

		const refused = await editJob({ address: NEW_ADDRESS });
		expect(refused).toMatchObject({
			details: {
				documents: [
					{ kind: "job_visit", id: "v1", number: null },
					{ kind: "invoice", id: "inv1", number: "INV-0011" },
				],
			},
		});

		const result = await editJob({ address: NEW_ADDRESS, address_tax_choice: "default" });

		expect(result.err).toBe("");
		expect(s.job.tax_amount).toBe(23.1);
		expect(s.job.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
		expect(s.lineRows.j1.map((l) => l.tax_group_id)).toEqual([null, null]);
		expect(s.visits[0].tax_amount).toBe(34.65);
		expect(s.invoices[0]).toMatchObject({ tax_amount: 34.65, tax_source: "org_default" });
		expect(choiceLogs().map((p) => p.entity_id)).toEqual(["v1", "inv1"]);
	});

	it("a manual job with no kept family is not asked", async () => {
		const s = seed({ jobSnapshot: ORG_DEFAULT });

		const result = await editJob({ address: NEW_ADDRESS });

		expect(result.err).toBe("");
		expect(s.job.address).toBe(NEW_ADDRESS);
	});
});

describe("updateClient — job-less draft invoices taxed at the client address", () => {
	it("refuses without a choice, then saves with \"keep\"", async () => {
		const s = seed({
			invoices: [
				{ id: "inv3", invoice_number: "INV-0013", status: "Draft", job_ids: [], amount_paid: 0, adjusts_invoice_id: null, ...taxRow(KEPT) },
			],
		});

		const refused = await editClient({ address: NEW_ADDRESS });
		expect(refused).toMatchObject({
			code: "ADDRESS_TAX_CHOICE_REQUIRED",
			details: { documents: [{ kind: "invoice", id: "inv3", number: "INV-0013" }] },
		});
		expect(mockDb.client.update).not.toHaveBeenCalled();
		expect(s.client.address).toBe(OLD_ADDRESS);

		const kept = await editClient({ address: NEW_ADDRESS, address_tax_choice: "keep" });
		expect(kept.err).toBe("");
		expect(s.client.address).toBe(NEW_ADDRESS);
		expect(s.invoices[0].tax_amount).toBe(23.1);
		expect(choiceLogs()).toEqual([
			expect.objectContaining({
				event_type: "invoice.tax_address_choice",
				entity_id: "inv3",
				reason: "Tax kept at La Crosse, WI rate after address change",
			}),
		]);
	});

	it("a draft issued between the check and the write is left alone", async () => {
		const s = seed({
			invoices: [
				{ id: "inv3", invoice_number: "INV-0013", status: "Draft", job_ids: [], amount_paid: 0, adjusts_invoice_id: null, ...taxRow(KEPT) },
			],
		});
		mockDb.client.update.mockImplementation(async ({ data }: { data: Row }) => {
			Object.assign(s.invoices[0], { status: "Issued", tax_snapshot: LOCKED_KEPT });
			return Object.assign(s.client, data);
		});

		const result = await editClient({ address: NEW_ADDRESS, address_tax_choice: "default" });

		expect(result.err).toBe("");
		expect(s.client.address).toBe(NEW_ADDRESS);
		expect(s.invoices[0]).toMatchObject({ tax_amount: 23.1, tax_snapshot: LOCKED_KEPT });
		expect(mockDb.invoice.update).not.toHaveBeenCalled();
		expect(choiceLogs()).toEqual([]);
	});

	it("a client with no kept job-less drafts is not asked", async () => {
		const s = seed({
			invoices: [
				{ id: "inv4", invoice_number: "INV-0014", status: "Draft", job_ids: [], amount_paid: 0, adjusts_invoice_id: null, ...taxRow(ORG_DEFAULT) },
			],
		});

		const result = await editClient({ address: NEW_ADDRESS });

		expect(result.err).toBe("");
		expect(s.client.address).toBe(NEW_ADDRESS);
	});
});

describe("applyAddressTaxChoice — a member locked since the family was read", () => {
	it("is not stamped and not logged; the others still move", async () => {
		const s = seed({
			quoteSnapshot: LOCKED_KEPT,
			jobSnapshot: KEPT,
		});

		await applyAddressTaxChoice(
			mockDb as unknown as Prisma.TransactionClient,
			"org1",
			[
				{ kind: "quote", id: "q1", number: "Q-0010" },
				{ kind: "job", id: "j1", number: "J-0001" },
			],
			{ group_id: CHICAGO.id },
			"La Crosse, WI",
			{ type: "dispatcher", id: "d1" },
		);

		expect(s.lineRows.q1[0].tax_group_id).toBeNull();
		expect(s.quote.tax_snapshot).toBe(LOCKED_KEPT);
		expect(s.lineRows.j1[0].tax_group_id).toBe(CHICAGO.id);
		expect(s.job.tax_amount).toBe(43.05);
		expect(choiceLogs().map((p) => p.entity_id)).toEqual(["j1"]);
	});
});
