import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
	process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
	process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", () => ({ db: {} }));

import { planPurge, type PurgeCatalog, type PurgeEdge, type OnDelete } from "../orgPurge.js";

const table = (name: string, columns: string[] = []) => ({
	name,
	pk: ["id"],
	columns: new Set(["id", ...columns]),
});
const edge = (child: string, childCol: string, parent: string, onDelete: OnDelete, childNullable: boolean): PurgeEdge => ({
	child,
	childCol,
	parent,
	parentCol: "id",
	onDelete,
	childNullable,
});
const catalog = (tables: ReturnType<typeof table>[], edges: PurgeEdge[]): PurgeCatalog => ({
	tables: new Map(tables.map((t) => [t.name, t])),
	edges,
});

const before = (order: string[], a: string, b: string) => order.indexOf(a) < order.indexOf(b);

describe("planPurge", () => {
	const base = [
		table("organization"),
		table("client", ["organization_id"]),
		table("job", ["organization_id"]),
		table("job_visit"),
		table("visit_photo"),
		table("shift", ["org_id"]),
		table("plan"),
		table("global_note"),
	];
	const edges = [
		edge("client", "organization_id", "organization", "restrict", false),
		edge("job", "organization_id", "organization", "restrict", true),
		edge("job", "client_id", "client", "restrict", false),
		edge("job_visit", "job_id", "job", "cascade", false),
		// Nullable but CASCADE: the schema says the photo goes with its visit.
		edge("visit_photo", "visit_id", "job_visit", "cascade", true),
		// Global table pointing in: neither deleted nor blocking once detached.
		edge("global_note", "job_id", "job", "restrict", true),
		edge("client", "plan_id", "plan", "restrict", false),
	];

	it("takes org-tagged tables (organization_id or org_id) and everything that cannot outlive them", () => {
		const plan = planPurge(catalog(base, edges));
		expect(plan.tables).toEqual(["organization", "client", "job", "job_visit", "shift", "visit_photo"]);
		expect(plan.seeds).toEqual(
			expect.arrayContaining([
				{ table: "client", column: "organization_id" },
				{ table: "shift", column: "org_id" },
			]),
		);
		// Parents are never pulled in: deleting a client must not delete its plan.
		expect(plan.tables).not.toContain("plan");
		expect(plan.tables).not.toContain("global_note");
	});

	it("detaches outside rows that point in through a nullable RESTRICT key", () => {
		const plan = planPurge(catalog(base, edges));
		expect(plan.detachEdges.map((e) => `${e.child}.${e.childCol}`)).toEqual(["global_note.job_id"]);
	});

	it("deletes children before parents and the organization last", () => {
		const { deleteOrder } = planPurge(catalog(base, edges));
		expect(deleteOrder[deleteOrder.length - 1]).toBe("organization");
		expect(before(deleteOrder, "job", "client")).toBe(true);
		expect(before(deleteOrder, "job_visit", "job")).toBe(true);
		expect(before(deleteOrder, "visit_photo", "job_visit")).toBe(true);
	});

	it("does not follow a nullable SET NULL key: Postgres clears it", () => {
		const plan = planPurge(
			catalog(
				[table("organization"), table("job", ["organization_id"]), table("bookmark")],
				[
					edge("job", "organization_id", "organization", "restrict", false),
					edge("bookmark", "job_id", "job", "set_null", true),
				],
			),
		);
		expect(plan.tables).not.toContain("bookmark");
		expect(plan.detachEdges).toEqual([]);
	});

	it("breaks a cycle by nulling its nullable RESTRICT key first", () => {
		const plan = planPurge(
			catalog(
				[table("organization"), table("invoice", ["organization_id"]), table("revision", ["organization_id"])],
				[
					edge("invoice", "organization_id", "organization", "restrict", false),
					edge("revision", "organization_id", "organization", "restrict", false),
					edge("revision", "invoice_id", "invoice", "restrict", false),
					edge("invoice", "current_revision_id", "revision", "restrict", true),
				],
			),
		);
		expect(plan.cycleBreaks.map((e) => `${e.child}.${e.childCol}`)).toEqual(["invoice.current_revision_id"]);
		expect(before(plan.deleteOrder, "revision", "invoice")).toBe(true);
	});

	it("ignores self-references, which one DELETE statement handles", () => {
		const plan = planPurge(
			catalog(
				[table("organization"), table("invoice", ["organization_id"])],
				[
					edge("invoice", "organization_id", "organization", "restrict", false),
					edge("invoice", "revised_from_id", "invoice", "restrict", true),
				],
			),
		);
		expect(plan.cycleBreaks).toEqual([]);
		expect(plan.deleteOrder).toEqual(["invoice", "organization"]);
	});

	it("refuses a cycle of NOT NULL keys instead of guessing", () => {
		expect(() =>
			planPurge(
				catalog(
					[table("organization"), table("a", ["organization_id"]), table("b", ["organization_id"])],
					[edge("a", "b_id", "b", "restrict", false), edge("b", "a_id", "a", "restrict", false)],
				),
			),
		).toThrow(/unbreakable FK cycle among a, b/);
	});
});
