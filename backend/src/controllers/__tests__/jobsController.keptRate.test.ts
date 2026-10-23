import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, taxMode, orgCtx, loadRateSet, resolveAddressTax, recomputeJobTotals } = vi.hoisted(
	() => {
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
			recomputeJobTotals: vi.fn(),
		};
	},
);

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateJobNumber: vi.fn(async () => "J-0042"),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../../services/disputeService.js", () => ({ hasOpenDispute: vi.fn(async () => false) }));
// The real dropClientTaxTotals; the effective mode and org context are the test's.
vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: taxMode,
	getOrgTaxContext: orgCtx,
}));
vi.mock("../../services/tax/taxResolver.js", () => ({ loadRateSet, resolveAddressTax }));
// The real recompute and holdsKeptRate, with the job recompute observable.
vi.mock("../../lib/recomputeDocumentTotals.js", async (importActual) => {
	const actual = await importActual<typeof import("../../lib/recomputeDocumentTotals.js")>();
	recomputeJobTotals.mockImplementation(actual.recomputeJobTotals);
	return { ...actual, recomputeJobTotals };
});

import type { Request } from "express";
import { insertJob, updateJob } from "../jobsController.js";

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
const ORG_DEFAULT_SNAPSHOT = {
	version: 2,
	locked_at: "draft",
	source: "org_default",
	rounding: "jurisdiction_half_up",
	groups: [],
};
const CLIENT = "11111111-1111-4111-8111-111111111111";
const QUOTE = "22222222-2222-4222-8222-222222222222";
const ADDRESS = "400 Main St, La Crosse, WI 54601";

type Row = Record<string, any>;

const QUOTE_LINE = {
	description: null,
	quantity: 1,
	item_type: null,
	inventory_item_id: null,
	tax_group_id: null,
};

/** An in-memory job table on top of a Q-0010-shaped quote. */
function seed(quoteSnapshot: unknown, job: Row | null = null) {
	const quote: Row = {
		id: QUOTE,
		status: "Sent",
		title: "Furnace replacement",
		description: "Replace furnace",
		address: ADDRESS,
		coords: { lat: 43.8, lon: -91.2 },
		priority: "Medium",
		total: 633.1,
		subtotal: 610,
		tax_rate: 0.055,
		tax_amount: 23.1,
		discount_type: null,
		discount_value: null,
		discount_amount: null,
		tax_snapshot: quoteSnapshot,
		tax_needs_review: false,
		tax_resolution_id: "res-1",
		request_id: null,
		request: null,
		job: null,
		line_items: [
			{ ...QUOTE_LINE, name: "Furnace", unit_price: 420, total: 420, taxable: true },
			{ ...QUOTE_LINE, name: "Labor", unit_price: 190, total: 190, taxable: false },
		],
	};
	const state: { job: Row | null; lines: Row[] } = { job, lines: job?.line_items ?? [] };
	const jobView = () =>
		state.job && {
			...state.job,
			line_items: state.lines,
			quote: state.job.quote_id === QUOTE ? quote : null,
		};
	Object.assign(mockDb, {
		client: {
			findUnique: vi.fn(async () => ({ id: CLIENT })),
			findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
			update: vi.fn(async () => ({})),
		},
		quote: {
			findUnique: vi.fn(async () => quote),
			findFirst: vi.fn(async () => quote),
			update: vi.fn(async () => ({})),
		},
		job: {
			create: vi.fn(async ({ data }: { data: Row }) => {
				state.job = {
					id: "j1",
					tax_snapshot: null,
					tax_source: null,
					tax_needs_review: false,
					tax_resolution_id: null,
					...data,
				};
				return state.job;
			}),
			findFirst: vi.fn(async () => jobView()),
			findUnique: vi.fn(async () => jobView()),
			update: vi.fn(async ({ data }: { data: Row }) => {
				Object.assign(state.job!, data);
				return jobView();
			}),
		},
		job_line_item: {
			createMany: vi.fn(async ({ data }: { data: Row[] }) => {
				state.lines = data.map((d, i) => ({ id: `l${i + 1}`, ...d }));
			}),
			update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
				Object.assign(state.lines.find((l) => l.id === where.id)!, data);
			}),
		},
		job_visit: { findMany: vi.fn(async () => []) },
		tax_group: {
			findMany: vi.fn(async () => []),
			findFirst: vi.fn(async () => WI_STANDARD),
		},
		inventory_item: { findMany: vi.fn(async () => []) },
	});
	return state;
}

const create = (body: object) =>
	insertJob({ body, user: { organization_id: "org1" } } as unknown as Request, {
		dispatcherId: "d1",
	});

describe("insertJob — kept address rate in manual mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		loadRateSet.mockResolvedValue(LA_CROSSE);
	});

	it("a job from a kept-rate quote is taxed server-side at the kept rate", async () => {
		const state = seed(KEPT_SNAPSHOT);

		const result = await create({ client_id: CLIENT, quote_id: QUOTE, tax_amount: 34.65 });

		expect(result.err).toBe("");
		expect(mockDb.job.create.mock.calls[0][0].data.tax_amount).not.toBe(34.65);
		expect(resolveAddressTax).not.toHaveBeenCalled();
		expect(state.job).toMatchObject({ tax_amount: 23.1, tax_source: "provider" });
		expect(state.job!.tax_snapshot).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
		expect(state.lines.map((l) => l.tax_group_id)).toEqual([null, null]);
	});

	it("a manual job with no kept rate keeps the client's totals and is not recomputed", async () => {
		const state = seed(ORG_DEFAULT_SNAPSHOT);

		const result = await create({ client_id: CLIENT, quote_id: QUOTE, tax_amount: 34.65 });

		expect(result.err).toBe("");
		expect(recomputeJobTotals).not.toHaveBeenCalled();
		expect(mockDb.job.update).not.toHaveBeenCalled();
		expect(state.job!.tax_amount).toBe(34.65);
	});
});

describe("updateJob — kept address rate in manual mode", () => {
	const keptJob = (snapshot: unknown) => ({
		id: "j1",
		client_id: CLIENT,
		quote_id: null,
		address: ADDRESS,
		coords: null,
		discount_type: null,
		discount_value: null,
		tax_snapshot: snapshot,
		tax_source: "provider",
		tax_needs_review: false,
		tax_resolution_id: "res-1",
		tax_amount: 23.1,
		line_items: [{ id: "l1", total: 420, tax_group_id: null, taxable: true }],
	});
	const edit = (body: object) =>
		updateJob({ params: { id: "j1" }, body } as unknown as Request, "org1", {
			dispatcherId: "d1",
		});

	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		loadRateSet.mockResolvedValue(LA_CROSSE);
	});

	it("ignores the client's totals on a kept-rate job", async () => {
		const state = seed(null, keptJob(KEPT_SNAPSHOT));

		const result = await edit({ name: "Renamed", tax_amount: 34.65, subtotal: 420 });

		expect(result.err).toBe("");
		for (const [arg] of mockDb.job.update.mock.calls) {
			expect(arg.data).not.toHaveProperty("tax_amount", 34.65);
		}
		expect(state.job!.tax_amount).toBe(23.1);
	});

	it("a discount change lands before the recompute reads it", async () => {
		const state = seed(null, keptJob(KEPT_SNAPSHOT));

		await edit({ discount_type: "amount", discount_value: 20 });

		expect(recomputeJobTotals).toHaveBeenCalledWith("j1", "org1", mockDb);
		// $400 taxable after the $20 discount, at 5.5%.
		expect(state.job!.tax_amount).toBe(22);
		expect(state.job!.tax_snapshot).toMatchObject({ kept_from_auto: true });
	});

	it("a job with no kept rate stores the client's totals as sent", async () => {
		const state = seed(null, keptJob(ORG_DEFAULT_SNAPSHOT));

		await edit({ discount_type: "amount", discount_value: 20, tax_amount: 34.65 });

		expect(recomputeJobTotals).not.toHaveBeenCalled();
		expect(state.job!.tax_amount).toBe(34.65);
	});
});
