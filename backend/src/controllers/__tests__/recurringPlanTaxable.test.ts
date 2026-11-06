import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	insertRecurringPlan,
	updateRecurringPlan,
	updateRecurringPlanLineItems,
	generateVisitFromOccurrence,
} from "../recurringPlansController.js";
import { createRecurringPlanSchema } from "../../lib/validate/recurringPlans.js";
import { getScopedDb } from "../../lib/context.js";

vi.mock("../../db.js", () => ({
	db: {},
	generateJobNumber: vi.fn().mockResolvedValue("J-0001"),
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
const { holdsKeptRate, recomputeVisitTotals } = vi.hoisted(() => ({
	holdsKeptRate: vi.fn(async () => false),
	recomputeVisitTotals: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({ holdsKeptRate, recomputeVisitTotals }));

const ORG = "org-1";
const ITEM = "11111111-1111-4111-8111-111111111111";
const LINE = "44444444-4444-4444-8444-444444444444";
const PLAN = { id: "plan-1", organization_id: ORG };

/** One non-taxable inventory item (ITEM) and optionally one stored plan line. */
function makeSdb(existing: { id: string }[] = []) {
	const lineItem = {
		create: vi.fn().mockResolvedValue({}),
		update: vi.fn().mockResolvedValue({}),
		delete: vi.fn().mockResolvedValue({}),
	};
	const tx = {
		inventory_item: {
			findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
				Promise.resolve(
					where.id.in.filter((id) => id === ITEM).map((id) => ({ id, taxable: false })),
				),
			),
		},
		vehicle: { findMany: vi.fn().mockResolvedValue([]) },
		recurring_plan_line_item: lineItem,
		recurring_plan: { findUnique: vi.fn().mockResolvedValue({ ...PLAN, line_items: [] }) },
	};
	const sdb = {
		recurring_plan: {
			findFirst: vi.fn().mockResolvedValue({ ...PLAN, line_items: existing }),
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		$transaction: vi.fn((cb: any) => cb(tx)),
	};
	return { sdb, lineItem };
}

const line = (over: Record<string, unknown> = {}) => ({
	name: "Filter",
	quantity: 1,
	unit_price: 10,
	...over,
});

describe("recurring plan line taxable", () => {
	beforeEach(() => vi.clearAllMocks());

	it("create schema keeps an explicit taxable:false", () => {
		const parsed = createRecurringPlanSchema.parse({
			client_id: "55555555-5555-4555-8555-555555555555",
			name: "P",
			description: "d",
			address: "a",
			coords: { lat: 1, lon: 1 },
			starts_at: "2026-10-21T00:00:00.000Z",
			rule: {
				frequency: "daily",
				interval: 1,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
			},
			line_items: [line({ taxable: false })],
		});
		expect(parsed.line_items?.[0].taxable).toBe(false);
	});

	it("update writes taxable:false to an existing line", async () => {
		const { sdb, lineItem } = makeSdb([{ id: LINE }]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(getScopedDb).mockReturnValue(sdb as any);
		const r = await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: [line({ id: LINE, taxable: false })] },
			ORG,
		);
		expect(r.err).toBe("");
		expect(lineItem.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ taxable: false }) }),
		);
	});

	it("update omitting taxable leaves an existing line's value alone", async () => {
		const { sdb, lineItem } = makeSdb([{ id: LINE }]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(getScopedDb).mockReturnValue(sdb as any);
		await updateRecurringPlanLineItems("job-1", { line_items: [line({ id: LINE })] }, ORG);
		expect(lineItem.update.mock.calls[0][0].data).not.toHaveProperty("taxable");
	});

	it("explicit taxable:true beats a non-taxable inventory item on a new line", async () => {
		const { sdb, lineItem } = makeSdb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(getScopedDb).mockReturnValue(sdb as any);
		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: [line({ inventory_item_id: ITEM, taxable: true })] },
			ORG,
		);
		expect(lineItem.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ taxable: true }) }),
		);
	});

	it("new line omitting taxable takes the inventory default", async () => {
		const { sdb, lineItem } = makeSdb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(getScopedDb).mockReturnValue(sdb as any);
		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: [line({ inventory_item_id: ITEM })] },
			ORG,
		);
		expect(lineItem.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ taxable: false }) }),
		);
	});
});

const GROUP = "77777777-7777-4777-8777-777777777777";
const CLIENT = "55555555-5555-4555-8555-555555555555";

/** Every unlisted model method resolves to a bare row, so only the calls under test need shaping. */
function proxyTx(overrides: Record<string, Record<string, unknown>>) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const models: Record<string, any> = {};
	return new Proxy(models, {
		get(t, model: string) {
			if (!t[model]) {
				t[model] = new Proxy(overrides[model] ?? {}, {
					get(m, fn: string) {
						if (!(fn in m)) m[fn] = vi.fn().mockResolvedValue({ id: "row-1" });
						return m[fn];
					},
				});
			}
			return t[model];
		},
	});
}

const body = (lines: unknown[]) => ({
	client_id: CLIENT,
	name: "P",
	description: "d",
	address: "a",
	coords: { lat: 1, lon: 1 },
	starts_at: "2026-10-21T00:00:00.000Z",
	generation_window_days: 1,
	rule: {
		frequency: "daily",
		interval: 1,
		arrival_constraint: "anytime",
		finish_constraint: "when_done",
	},
	line_items: lines,
});

const nonTaxableItems = {
	findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
		Promise.resolve(where.id.in.map((id) => ({ id, taxable: false }))),
	),
};

function createTx() {
	const createMany = vi.fn().mockResolvedValue({});
	const tx = proxyTx({
		client: { findUnique: vi.fn().mockResolvedValue({ id: CLIENT, organization_id: ORG }) },
		inventory_item: nonTaxableItems,
		tax_group: { count: vi.fn().mockResolvedValue(1) },
		recurring_plan_line_item: { createMany },
		recurring_plan: {
			create: vi.fn().mockResolvedValue({ id: "plan-1" }),
			findUnique: vi.fn().mockResolvedValue({
				id: "plan-1",
				starts_at: new Date(),
				ends_at: null,
				timezone: "UTC",
				rules: [
					{
						frequency: "daily",
						interval: 1,
						by_weekday: [],
						by_month_day: null,
						by_month: null,
						arrival_constraint: "anytime",
						finish_constraint: "when_done",
						arrival_time: null,
						arrival_window_start: null,
						arrival_window_end: null,
						finish_time: null,
					},
				],
			}),
		},
		recurring_occurrence: { findFirst: vi.fn().mockResolvedValue({ id: "occ" }) },
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sdb = { $transaction: vi.fn((cb: any) => cb(tx)) };
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	vi.mocked(getScopedDb).mockReturnValue(sdb as any);
	return createMany;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const create = (lines: unknown[]) => insertRecurringPlan({ body: body(lines) } as any, ORG);

describe("insertRecurringPlan line taxable + tax group", () => {
	beforeEach(() => vi.clearAllMocks());

	it("stores explicit taxable:false and the tax group", async () => {
		const createMany = createTx();
		const r = await create([line({ taxable: false, tax_group_id: GROUP })]);
		expect(r.err).toBe("");
		expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
			taxable: false,
			tax_group_id: GROUP,
		});
	});

	it("explicit taxable:true beats a non-taxable inventory item", async () => {
		const createMany = createTx();
		await create([line({ inventory_item_id: ITEM, taxable: true })]);
		expect(createMany.mock.calls[0][0].data[0].taxable).toBe(true);
	});

	it("omitted taxable takes the inventory default", async () => {
		const createMany = createTx();
		await create([line({ inventory_item_id: ITEM })]);
		expect(createMany.mock.calls[0][0].data[0].taxable).toBe(false);
	});
});

describe("updateRecurringPlan line taxable + tax group", () => {
	beforeEach(() => vi.clearAllMocks());

	function updateTx() {
		const lineItem = {
			create: vi.fn().mockResolvedValue({}),
			update: vi.fn().mockResolvedValue({}),
			delete: vi.fn().mockResolvedValue({}),
		};
		const tx = proxyTx({
			inventory_item: nonTaxableItems,
			tax_group: { count: vi.fn().mockResolvedValue(1) },
			recurring_plan_line_item: lineItem,
			recurring_plan: {
				update: vi.fn().mockResolvedValue({ id: "plan-1" }),
				findUnique: vi.fn().mockResolvedValue({ ...PLAN, line_items: [] }),
			},
		});
		const sdb = {
			recurring_plan: {
				findFirst: vi.fn().mockResolvedValue({
					...PLAN,
					job_container: { id: "job-1" },
					rules: [],
					invoice_schedule: null,
					line_items: [{ id: LINE }],
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(getScopedDb).mockReturnValue(sdb as any);
		return lineItem;
	}

	it("writes taxable:false and tax_group_id on an existing line; omitted leaves both", async () => {
		const lineItem = updateTx();
		const r = await updateRecurringPlan(
			"job-1",
			{ line_items: [line({ id: LINE, taxable: false, tax_group_id: GROUP })] },
			ORG,
		);
		expect(r.err).toBe("");
		expect(lineItem.update.mock.calls[0][0].data).toMatchObject({
			taxable: false,
			tax_group_id: GROUP,
		});

		lineItem.update.mockClear();
		await updateRecurringPlan("job-1", { line_items: [line({ id: LINE })] }, ORG);
		const data = lineItem.update.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("taxable");
		expect(data).not.toHaveProperty("tax_group_id");
	});

	it("new line: explicit taxable:true beats a non-taxable item", async () => {
		const lineItem = updateTx();
		await updateRecurringPlan(
			"job-1",
			{ line_items: [line({ inventory_item_id: ITEM, taxable: true })] },
			ORG,
		);
		expect(lineItem.create.mock.calls[0][0].data.taxable).toBe(true);
	});
});

function occurrenceSdb(visitCreate: ReturnType<typeof vi.fn>) {
	const tx = proxyTx({ job_visit: { create: visitCreate } });
	return {
		tx,
		sdb: {
			recurring_occurrence: {
				findUnique: vi.fn().mockResolvedValue({
					id: "occ",
					status: "planned",
					job_visit_id: null,
					occurrence_start_at: new Date(),
					occurrence_end_at: new Date(),
					recurring_plan: {
						id: "plan-1",
						organization_id: ORG,
						job_container: { id: "job-1", tax_rate: 0 },
						rules: [{ arrival_constraint: "anytime", finish_constraint: "when_done" }],
						line_items: [
							{
								name: "Filter",
								description: null,
								quantity: 1,
								unit_price: 10,
								item_type: "material",
								taxable: false,
								tax_group_id: GROUP,
								inventory_item_id: null,
							},
						],
					},
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		},
	};
}

describe("generateVisitFromOccurrence", () => {
	beforeEach(() => vi.clearAllMocks());

	const generate = (visitCreate: ReturnType<typeof vi.fn>) => {
		const { sdb, tx } = occurrenceSdb(visitCreate);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(getScopedDb).mockReturnValue(sdb as any);
		return { tx, done: generateVisitFromOccurrence("occ", ORG) };
	};

	it("carries taxable and tax_group_id from the plan line", async () => {
		const visitCreate = vi.fn().mockResolvedValue({ id: "visit-1" });
		await generate(visitCreate).done;
		const created = visitCreate.mock.calls[0][0].data.line_items.createMany.data[0];
		expect(created).toMatchObject({ taxable: false, tax_group_id: GROUP });
	});

	it("recomputes the visit when the container job holds a kept rate", async () => {
		holdsKeptRate.mockResolvedValueOnce(true);
		const { tx, done } = generate(vi.fn().mockResolvedValue({ id: "visit-1" }));
		const result = await done;
		expect(result.err).toBe("");
		// The proxy tx defeats deep equality; identity is the point anyway.
		const [model, jobId, keptTx] = holdsKeptRate.mock.calls[0] as unknown[];
		expect([model, jobId, keptTx === tx]).toEqual(["job", "job-1", true]);
		const [visitId, org, visitTx] = recomputeVisitTotals.mock.calls[0] as unknown[];
		expect([visitId, org, visitTx === tx]).toEqual(["visit-1", ORG, true]);
	});

	it("leaves the visit alone on a container job with no kept rate", async () => {
		const result = await generate(vi.fn().mockResolvedValue({ id: "visit-1" })).done;
		expect(result.err).toBe("");
		expect(recomputeVisitTotals).not.toHaveBeenCalled();
	});
});
