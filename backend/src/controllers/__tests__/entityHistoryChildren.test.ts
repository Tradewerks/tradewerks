import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});

import { db } from "../../db.js";
import { getEntityHistory, parentBreadcrumb, PARENT_ID_PATH } from "../logsController.js";
import { leaves, clausesWith, makeLogRow as row, type FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;

beforeEach(() => {
	vi.clearAllMocks();
	fake.log.findMany.mockResolvedValue([]);
	fake.log.count.mockResolvedValue(0);
});

describe("getEntityHistory — deleted children via parent breadcrumb (review P2-7 / L2)", () => {
	it("stamps parentBreadcrumb in the documented { old, new } shape", () => {
		expect(parentBreadcrumb("job", "job-1")).toEqual({
			_parent_type: { old: null, new: "job" },
			_parent_id: { old: null, new: "job-1" },
		});
		expect(PARENT_ID_PATH).toEqual(["_parent_id", "new"]);
	});

	it("ORs a changes->_parent_id->new JSON filter for every child type of the group", async () => {
		fake.job_visit.findMany.mockResolvedValue([{ id: "visit-1" }]);
		fake.job_line_item.findMany.mockResolvedValue([]);
		fake.job_note.findMany.mockResolvedValue([]);
		fake.log.findMany.mockResolvedValue([
			row({ id: "a", event_type: "job_visit.deleted", action: "deleted", entity_type: "job_visit", entity_id: "gone", changes: { name: { old: "V", new: null }, ...parentBreadcrumb("job", "job-1") } }),
			row({ id: "b" }),
		]);
		fake.log.count.mockResolvedValue(2);

		const r = await getEntityHistory("org-1", "job", "job-1", 20);
		expect(r.err).toBe("");
		expect(r.rows.map((x) => x.id)).toEqual(["a", "b"]);
		expect(r.total).toBe(2);
		expect(r.hasMore).toBe(false);

		const where = fake.log.findMany.mock.calls.at(-1)![0].where;
		const all = leaves(where);
		// live children still matched by id
		expect(all).toEqual(expect.arrayContaining([{ entity_type: "job_visit" }, { entity_id: { in: ["visit-1"] } }]));
		// deleted children matched through the breadcrumb, one clause per child type
		const breadcrumbClauses = clausesWith(where, ["entity_type", "changes"]);
		// quote/request are the job's lineage; their clause matches nothing but is harmless
		expect(breadcrumbClauses.map((c) => c.entity_type).sort()).toEqual([
			"job_line_item",
			"job_note",
			"job_visit",
			"quote",
			"request",
		]);
		for (const c of breadcrumbClauses) {
			expect(c.changes).toEqual({ path: ["_parent_id", "new"], equals: "job-1" });
		}
		// org scope still applies
		expect(all).toEqual(expect.arrayContaining([{ organization_id: "org-1" }]));
		// count uses the same filter so total/hasMore stay consistent
		expect(fake.log.count.mock.calls[0][0].where).toEqual(where);
	});

	it("matches a deleted child's earlier rows by the id on its breadcrumbed delete row", async () => {
		fake.vehicle_stock_item.findMany.mockResolvedValue([]);
		fake.vehicle_stock_adjustment.findMany.mockResolvedValue([]);
		fake.vehicle_restock_request.findMany.mockResolvedValue([]);
		fake.vehicle_restock_record.findMany.mockResolvedValue([]);
		fake.vehicle_maintenance_record.findMany.mockResolvedValue([]);
		fake.vehicle_maintenance_reminder.findMany.mockResolvedValue([]);
		fake.log.findMany.mockResolvedValueOnce([{ entity_type: "vehicle_maintenance_reminder", entity_id: "rem-gone" }]);

		await getEntityHistory("org-1", "vehicle", "veh-1", 20);
		const where = fake.log.findMany.mock.calls.at(-1)![0].where;
		expect(clausesWith(where, ["entity_type", "entity_id"])).toEqual(
			expect.arrayContaining([{ entity_type: "vehicle_maintenance_reminder", entity_id: "rem-gone" }]),
		);
	});

	it("invoice group matches deleted payments/notes through the breadcrumb", async () => {
		fake.invoice_note.findMany.mockResolvedValue([]);
		fake.invoice_payment.findMany.mockResolvedValue([]);
		await getEntityHistory("org-1", "invoice", "inv-1", 20);
		const where = fake.log.findMany.mock.calls[0][0].where;
		expect(clausesWith(where, ["entity_type", "changes"])).toEqual(
			expect.arrayContaining([
				{ entity_type: "invoice_payment", changes: { path: ["_parent_id", "new"], equals: "inv-1" } },
				{ entity_type: "invoice_note", changes: { path: ["_parent_id", "new"], equals: "inv-1" } },
			]),
		);
	});

	it("project group matches deleted jobs that were attached to the project", async () => {
		fake.job.findMany.mockResolvedValue([]);
		fake.project_note.findMany.mockResolvedValue([]);
		await getEntityHistory("org-1", "project", "proj-1", 20);
		const where = fake.log.findMany.mock.calls.at(-1)![0].where;
		expect(clausesWith(where, ["entity_type", "changes"])).toEqual(expect.arrayContaining([
			{ entity_type: "job", changes: { path: ["_parent_id", "new"], equals: "proj-1" } },
			{ entity_type: "project_note", changes: { path: ["_parent_id", "new"], equals: "proj-1" } },
		]));
	});

	it("recurring_plan group matches deleted notes/occurrences through the breadcrumb", async () => {
		fake.recurring_plan_note.findMany.mockResolvedValue([]);
		fake.recurring_occurrence.findMany.mockResolvedValue([]);
		await getEntityHistory("org-1", "recurring_plan", "plan-1", 20);
		const where = fake.log.findMany.mock.calls[0][0].where;
		expect(clausesWith(where, ["entity_type", "changes"])).toEqual(
			expect.arrayContaining([
				{ entity_type: "recurring_plan_note", changes: { path: ["_parent_id", "new"], equals: "plan-1" } },
				{ entity_type: "recurring_occurrence", changes: { path: ["_parent_id", "new"], equals: "plan-1" } },
			]),
		);
	});
});
