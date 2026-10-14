import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake base db ────────────────────────────────────────────────────────────
// getScopedDb calls db.$extends(...) and, inside its findUnique/findUniqueOrThrow
// reroutes, calls the BASE delegate methods (db[model].findFirst /
// findFirstOrThrow). We capture the extension config so hooks can be driven
// directly, and expose per-model delegate spies for those reroutes.

const h = vi.hoisted(() => {
	const state: { captured: any; baseDelegates: Record<string, any> } = {
		captured: undefined,
		baseDelegates: {},
	};
	const delegateFor = (model: string) =>
		(state.baseDelegates[model] ??= {
			findFirst: vi.fn().mockResolvedValue(null),
			findFirstOrThrow: vi.fn().mockResolvedValue(null),
		});
	const dbProxy: any = new Proxy(
		{
			$extends: (cfg: any) => {
				state.captured = cfg;
				return {};
			},
		},
		{
			get(target: any, prop: string) {
				if (prop in target) return target[prop];
				return delegateFor(prop);
			},
		},
	);
	return { state, delegateFor, dbProxy };
});

const delegateFor = h.delegateFor;

vi.mock("../../db.js", () => ({ db: h.dbProxy }));

import { getScopedDb } from "../context.js";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";

function hooksFor(orgId: string) {
	getScopedDb(orgId);
	return h.state.captured.query.$allModels;
}

// Drives a single extension hook and captures what the "run original op" thunk
// receives (i.e. the final, scope-injected args).
async function runHook(orgId: string, op: string, model: string, args: any) {
	const hooks = hooksFor(orgId);
	const query = vi.fn(async (finalArgs: any) => ({ __ran: true, finalArgs }));
	const result = await hooks[op]({ model, args, query, operation: op });
	return { query, result };
}

const ORG_MODEL = "inventory_item"; // organization_id column
const REL_MODEL = "vehicle_stock_item"; // scoped via vehicle.organization_id
const VISIT_MODEL = "job_visit"; // scoped via job.organization_id
const TIME_MODEL = "visit_tech_time_entry"; // scoped via visit.job.organization_id
const FREE_MODEL = "organization"; // not scoped at all

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(h.state.baseDelegates)) delete h.state.baseDelegates[key];
});

describe("getScopedDb — read scoping", () => {
	it("injects organization_id into findMany for org-scoped models", async () => {
		const { query } = await runHook(ORG_A, "findMany", ORG_MODEL, { where: { is_active: true } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ is_active: true }, { organization_id: ORG_A }] },
		});
	});

	it("injects organization_id into findFirst / count / aggregate", async () => {
		const first = await runHook(ORG_A, "findFirst", ORG_MODEL, {});
		expect(first.query).toHaveBeenCalledWith({ where: { AND: [{}, { organization_id: ORG_A }] } });

		const count = await runHook(ORG_A, "count", ORG_MODEL, { where: {} });
		expect(count.query).toHaveBeenCalledWith({ where: { AND: [{}, { organization_id: ORG_A }] } });

		const agg = await runHook(ORG_A, "aggregate", ORG_MODEL, {});
		expect(agg.query).toHaveBeenCalledWith({ where: { AND: [{}, { organization_id: ORG_A }] } });
	});

	it("injects the relation filter for relation-scoped models (addPartsUsed fix)", async () => {
		const { query } = await runHook(ORG_A, "findFirst", REL_MODEL, { where: { id: "s1" } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ id: "s1" }, { vehicle: { organization_id: ORG_A } }] },
		});
	});

	it("scopes job_visit through job.organization_id", async () => {
		const { query } = await runHook(ORG_A, "findMany", VISIT_MODEL, {});
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{}, { job: { organization_id: ORG_A } }] },
		});
	});

	it("leaves unscoped models untouched", async () => {
		const { query } = await runHook(ORG_A, "findMany", FREE_MODEL, { where: { id: "x" } });
		expect(query).toHaveBeenCalledWith({ where: { id: "x" } });
	});

	// groupBy was unhooked until the labor-cost work needed it, so every grouped
	// aggregate over a scoped model read across tenants. The 20 groupBy calls in
	// reportsController hand-write organization_id, which is why it went unnoticed.
	it("hooks groupBy at all — an unhooked aggregate reads across tenants", () => {
		expect(Object.keys(hooksFor(ORG_A))).toContain("groupBy");
	});

	it("injects organization_id into groupBy for org-scoped models", async () => {
		const { query } = await runHook(ORG_A, "groupBy", ORG_MODEL, {
			by: ["status"],
			_sum: { qty_on_hand: true },
		});
		expect(query).toHaveBeenCalledWith({
			by: ["status"],
			_sum: { qty_on_hand: true },
			where: { AND: [{}, { organization_id: ORG_A }] },
		});
	});

	it("injects the two-hop relation filter into groupBy for visit_tech_time_entry", async () => {
		const { query } = await runHook(ORG_A, "groupBy", TIME_MODEL, {
			by: ["visit_id"],
			_sum: { hours_worked: true },
		});
		expect(query).toHaveBeenCalledWith({
			by: ["visit_id"],
			_sum: { hours_worked: true },
			where: { AND: [{}, { visit: { job: { organization_id: ORG_A } } }] },
		});
	});

	// The registration key is matched by exact string against the lowercase Prisma
	// model name; it had been written `Visit_tech_time_entry`, which matched nothing
	// and injected no filter while looking registered.
	it("scopes visit_tech_time_entry on findMany (lowercase registration key)", async () => {
		const { query } = await runHook(ORG_A, "findMany", TIME_MODEL, {
			where: { clocked_out_at: null },
		});
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ clocked_out_at: null }, { visit: { job: { organization_id: ORG_A } } }] },
		});
	});
});

describe("getScopedDb — update/delete merge org filter into where", () => {
	it("merges organization_id as a sibling of the unique id for update", async () => {
		const { query } = await runHook(ORG_A, "update", ORG_MODEL, { where: { id: "i1" }, data: {} });
		expect(query).toHaveBeenCalledWith({
			where: { id: "i1", organization_id: ORG_A },
			data: {},
		});
	});

	// A separate ownership pre-check query (the prior design) would run on its
	// own connection and 404 on rows written earlier in the caller's own
	// still-open transaction. Merging the filter into this same query avoids
	// that: enforcement is Prisma's own native P2025 on a where-clause mismatch,
	// not a hand-rolled pre-check — so it can't disagree with this same query
	// about what the transaction has and hasn't written yet.
	it("overrides a spoofed organization_id in the where clause rather than trusting the caller's", async () => {
		const { query } = await runHook(ORG_A, "update", ORG_MODEL, {
			where: { id: "i1", organization_id: ORG_B },
			data: {},
		});
		expect(query).toHaveBeenCalledWith({
			where: { id: "i1", organization_id: ORG_A },
			data: {},
		});
	});

	it("merges the relation filter as a sibling for relation-scoped models on delete", async () => {
		const { query } = await runHook(ORG_A, "delete", REL_MODEL, { where: { id: "s1" } });
		expect(query).toHaveBeenCalledWith({
			where: { id: "s1", vehicle: { organization_id: ORG_A } },
		});
	});

	it("does not touch where for unscoped models on update", async () => {
		const { query } = await runHook(ORG_A, "update", FREE_MODEL, { where: { id: "o1" }, data: {} });
		expect(query).toHaveBeenCalledWith({ where: { id: "o1" }, data: {} });
	});
});

describe("getScopedDb — create/createMany force caller org", () => {
	it("overrides a spoofed organization_id on create", async () => {
		const { query } = await runHook(ORG_A, "create", ORG_MODEL, {
			data: { sku: "X", organization_id: ORG_B },
		});
		expect(query).toHaveBeenCalledWith({ data: { sku: "X", organization_id: ORG_A } });
	});

	it("rewrites a relation connect to the caller org on create", async () => {
		const { query } = await runHook(ORG_A, "create", ORG_MODEL, {
			data: { sku: "X", organization: { connect: { id: ORG_B } } },
		});
		expect(query).toHaveBeenCalledWith({
			data: { sku: "X", organization: { connect: { id: ORG_A } } },
		});
	});

	it("forces org on every row of createMany", async () => {
		const { query } = await runHook(ORG_A, "createMany", ORG_MODEL, {
			data: [{ sku: "A", organization_id: ORG_B }, { sku: "B" }],
		});
		expect(query).toHaveBeenCalledWith({
			data: [
				{ sku: "A", organization_id: ORG_A },
				{ sku: "B", organization_id: ORG_A },
			],
		});
	});

	it("does not touch create data for unscoped models", async () => {
		const { query } = await runHook(ORG_A, "create", FREE_MODEL, { data: { name: "Acme" } });
		expect(query).toHaveBeenCalledWith({ data: { name: "Acme" } });
	});
});

describe("getScopedDb — findUnique merges org filter as a sibling", () => {
	// findUnique/findUniqueOrThrow must stay on `query` — the transaction-aware
	// client Prisma already bound this call to — rather than rerouting to a
	// separate model/operation on the base `db`, which runs on its own connection
	// and can't see a still-open transaction's own uncommitted writes: adding a
	// vehicle stock item inside a $transaction and then looking it up here must
	// not 404 on its own just-created row.
	it("merges organization_id as a sibling of the unique id for org-scoped models", async () => {
		const hooks = hooksFor(ORG_A);
		const query = vi.fn().mockResolvedValue({ id: "i1" });
		const res = await hooks.findUnique({
			model: ORG_MODEL,
			args: { where: { id: "i1" }, include: { tags: true } },
			query,
			operation: "findUnique",
		});
		expect(query).toHaveBeenCalledWith({
			where: { id: "i1", organization_id: ORG_A },
			include: { tags: true },
		});
		expect(delegateFor(ORG_MODEL).findFirst).not.toHaveBeenCalled();
		expect(res).toEqual({ id: "i1" });
	});

	it("merges the relation filter as a sibling for relation-scoped models on findUniqueOrThrow", async () => {
		const hooks = hooksFor(ORG_A);
		const query = vi.fn().mockResolvedValue({ id: "s1" });
		await hooks.findUniqueOrThrow({
			model: REL_MODEL,
			args: { where: { id: "s1" } },
			query,
			operation: "findUniqueOrThrow",
		});
		expect(query).toHaveBeenCalledWith({
			where: { id: "s1", vehicle: { organization_id: ORG_A } },
		});
		expect(delegateFor(REL_MODEL).findFirstOrThrow).not.toHaveBeenCalled();
	});

	it("passes findUnique through untouched for unscoped models", async () => {
		const hooks = hooksFor(ORG_A);
		const query = vi.fn(async (a: any) => a);
		await hooks.findUnique({
			model: FREE_MODEL,
			args: { where: { id: "o1" } },
			query,
			operation: "findUnique",
		});
		expect(query).toHaveBeenCalledWith({ where: { id: "o1" } });
		expect(delegateFor(FREE_MODEL).findFirst).not.toHaveBeenCalled();
	});
});

// ── Phase 5: serial + batch tracking models ────────────────────────────────────

describe("getScopedDb — serial/batch tracking registries", () => {
	it("injects organization_id into serial_unit reads (org-scoped)", async () => {
		const { query } = await runHook(ORG_A, "findMany", "serial_unit", { where: { status: "in_warehouse" } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ status: "in_warehouse" }, { organization_id: ORG_A }] },
		});
	});

	it("forces caller org on stock_batch create even when spoofed", async () => {
		const { query } = await runHook(ORG_A, "create", "stock_batch", {
			data: { batch_number: "L1", organization_id: ORG_B },
		});
		expect(query).toHaveBeenCalledWith({
			data: { batch_number: "L1", organization_id: ORG_A },
		});
	});

	it("merges organization_id as a sibling of the unique id for stock_batch update", async () => {
		const { query } = await runHook(ORG_A, "update", "stock_batch", { where: { id: "b1" }, data: {} });
		expect(query).toHaveBeenCalledWith({
			where: { id: "b1", organization_id: ORG_A },
			data: {},
		});
	});

	it("scopes vehicle_stock_batch via vehicle.organization_id", async () => {
		const { query } = await runHook(ORG_A, "findFirst", "vehicle_stock_batch", { where: { id: "vb1" } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ id: "vb1" }, { vehicle: { organization_id: ORG_A } }] },
		});
	});

	it("scopes stock_movement_serial via movement.organization_id", async () => {
		const { query } = await runHook(ORG_A, "findMany", "stock_movement_serial", {});
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{}, { movement: { organization_id: ORG_A } }] },
		});
	});

	it("scopes stock_movement_batch via movement.organization_id", async () => {
		const { query } = await runHook(ORG_A, "findMany", "stock_movement_batch", { where: { qty: { gt: 0 } } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ qty: { gt: 0 } }, { movement: { organization_id: ORG_A } }] },
		});
	});
});

// ── H2 regression: same-key relation collision ─────────────────────────────────
// A shallow { ...where, ...scope } merge would let an injected scope fragment
// OVERWRITE a caller's filter on the SAME relation key (e.g. both `movement`),
// silently dropping the tenant guard OR the caller's predicate. AND-compose keeps
// both. These assert both conditions survive, per relation-scoped model.

describe("getScopedDb — assistant conversation models", () => {
	it("scopes assistant_conversation by its own organization_id", async () => {
		const { query } = await runHook(ORG_A, "findMany", "assistant_conversation", { where: { user_id: "u1" } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ user_id: "u1" }, { organization_id: ORG_A }] },
		});
	});

	it("scopes assistant_message through its conversation", async () => {
		const { query } = await runHook(ORG_A, "findMany", "assistant_message", { where: { conversation_id: "c1" } });
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{ conversation_id: "c1" }, { conversation: { organization_id: ORG_A } }] },
		});
	});

	it("scopes assistant_tool_call two relations deep", async () => {
		const { query } = await runHook(ORG_A, "findMany", "assistant_tool_call", {});
		expect(query).toHaveBeenCalledWith({
			where: { AND: [{}, { message: { conversation: { organization_id: ORG_A } } }] },
		});
	});

	it("forces the caller's org onto a created conversation", async () => {
		// A chat row that could be created into another org would let one tenant
		// write history into another's account.
		const { query } = await runHook(ORG_A, "create", "assistant_conversation", {
			data: { organization_id: ORG_B, user_id: "u1", user_role: "dispatcher" },
		});
		expect(query).toHaveBeenCalledWith({
			data: { organization_id: ORG_A, user_id: "u1", user_role: "dispatcher" },
		});
	});

	it("refuses to update a conversation belonging to another org", async () => {
		const { query } = await runHook(ORG_A, "update", "assistant_conversation", {
			where: { id: "conv-1" },
			data: { title: "x" },
		});
		expect(query).toHaveBeenCalledWith({
			where: { id: "conv-1", organization_id: ORG_A },
			data: { title: "x" },
		});
	});
});

describe("getScopedDb — same-key relation collision (H2)", () => {
	it("keeps BOTH caller movement.to_location_type and injected movement.organization_id", async () => {
		const callerWhere = { movement: { to_location_type: "consumed" } };
		const { query } = await runHook(ORG_A, "findMany", "stock_movement_batch", { where: callerWhere });
		expect(query).toHaveBeenCalledWith({
			where: {
				AND: [
					{ movement: { to_location_type: "consumed" } },
					{ movement: { organization_id: ORG_A } },
				],
			},
		});
	});

	it("keeps BOTH caller and injected filters on stock_movement_serial", async () => {
		const callerWhere = { movement: { reason: "receive" } };
		const { query } = await runHook(ORG_A, "findFirst", "stock_movement_serial", { where: callerWhere });
		expect(query).toHaveBeenCalledWith({
			where: {
				AND: [{ movement: { reason: "receive" } }, { movement: { organization_id: ORG_A } }],
			},
		});
	});

	// Every relation-scoped model must AND-compose so neither the caller predicate
	// nor the org scope is lost, even when they collide on the same relation key.
	const REL_MODELS = [
		"vehicle_stock_item",
		"vehicle_restock_line",
		"vehicle_stock_adjustment_line",
		"vehicle_stock_usage",
		"item_external_mapping",
		"job_visit",
		"vehicle_stock_batch",
		"stock_movement_serial",
		"stock_movement_batch",
		"visit_tech_time_entry",
	];

	for (const model of REL_MODELS) {
		it(`AND-composes caller where with the injected scope for ${model}`, async () => {
			const callerWhere = { id: "x", is_active: true };
			const { query } = await runHook(ORG_A, "findMany", model, { where: callerWhere });
			const finalWhere = query.mock.calls[0][0].where;
			expect(finalWhere.AND).toHaveLength(2);
			// caller predicate preserved verbatim as the first conjunct
			expect(finalWhere.AND[0]).toEqual(callerWhere);
			// injected org scope preserved as the second conjunct (non-empty)
			expect(finalWhere.AND[1]).toBeTruthy();
			expect(Object.keys(finalWhere.AND[1]).length).toBeGreaterThan(0);
		});
	}
});
