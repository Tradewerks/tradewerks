import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: vi.fn().mockResolvedValue(undefined),
}));

import { updateFieldLineQuantity } from "../visitFieldLinesController.js";
import { getScopedDb, type UserContext } from "../../lib/context.js";
import { recomputeVisitTotals } from "../../lib/recomputeDocumentTotals.js";
import { logActivity } from "../../services/logger.js";

const VISIT_ID = "visit-1";
const LINE_ID = "line-1";
const TECH_ID = "tech-1";
const ORG_ID = "org-1";

const TECH_CTX: UserContext = { techId: TECH_ID };
const DISPATCHER_CTX: UserContext = { dispatcherId: "disp-1" };

function setup(
	opts: {
		status?: string;
		techs?: string[];
		line?: Record<string, unknown> | null;
		/** The status seen under the lock; defaults to `status`. */
		lockedStatus?: string;
		/** Assigned under the lock; defaults to `techs`. */
		lockedTechs?: string[];
		invoiced?: boolean;
		timeEntryLinked?: boolean;
	} = {},
) {
	const locks: string[] = [];
	const line =
		opts.line === null
			? null
			: {
					id: LINE_ID,
					visit_id: VISIT_ID,
					quantity: 1,
					unit_price: 50,
					total: 50,
					fulfillment_status: null,
					...opts.line,
				};
	const lockedTechs = opts.lockedTechs ?? opts.techs ?? [TECH_ID];
	const tx = {
		$queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
			const text = sql.join("?");
			if (text.includes("FROM job_visit v")) {
				locks.push("visit");
				return [{ status: opts.lockedStatus ?? opts.status ?? "InProgress" }];
			}
			locks.push("line");
			return [];
		}),
		job_visit_technician: {
			count: vi.fn(async ({ where }: { where: { tech_id: string } }) =>
				lockedTechs.includes(where.tech_id) ? 1 : 0,
			),
		},
		invoice_visit: { count: vi.fn(async () => (opts.invoiced ? 1 : 0)) },
		visit_tech_time_entry: { count: vi.fn(async () => (opts.timeEntryLinked ? 1 : 0)) },
		job_visit_line_item: {
			findFirst: vi.fn().mockResolvedValue(line),
			update: vi.fn().mockResolvedValue({}),
			delete: vi.fn().mockResolvedValue({}),
		},
	};
	const visit = {
		id: VISIT_ID,
		status: opts.status ?? "In Progress",
		visit_techs: (opts.techs ?? [TECH_ID]).map((tech_id) => ({ tech_id })),
	};
	const sdb = {
		job_visit: { findFirst: vi.fn().mockResolvedValue(visit) },
		$transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
	};
	vi.mocked(getScopedDb).mockReturnValue(sdb as never);
	return { tx, sdb, locks };
}

beforeEach(() => vi.clearAllMocks());

describe("updateFieldLineQuantity", () => {
	it("a technician not assigned to the visit gets 403", async () => {
		const { tx } = setup({ techs: ["someone-else"] });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.code).toBe("FORBIDDEN");
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("ignores unit_price in the body and prices from the row", async () => {
		const { tx } = setup();
		// The controller takes only a quantity; the route test proves a hostile body can't reach it.
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.err).toBe("");
		expect(tx.job_visit_line_item.update).toHaveBeenCalledWith({
			where: { id: LINE_ID },
			data: { quantity: 2, total: 100 },
		});
		expect(recomputeVisitTotals).toHaveBeenCalledTimes(1);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "job_visit.line_quantity_changed" }),
		);
	});

	it("quantity 0 deletes the line and recomputes visit totals", async () => {
		const { tx } = setup();
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 0, ORG_ID, DISPATCHER_CTX);
		expect(res.err).toBe("");
		expect(tx.job_visit_line_item.delete).toHaveBeenCalledWith({ where: { id: LINE_ID } });
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
		expect(recomputeVisitTotals).toHaveBeenCalledWith(VISIT_ID, ORG_ID, tx);
	});

	it("refuses on a Completed visit", async () => {
		const { tx } = setup({ status: "Completed" });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.code).toBe("WRONG_STATE");
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("refuses a stock line that is already used", async () => {
		const { tx } = setup({ line: { fulfillment_status: "used", inventory_item_id: "inv-1" } });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.code).toBe("WRONG_STATE");
		expect(res.err).toBe("Use the parts endpoint for stock lines");
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
		expect(recomputeVisitTotals).not.toHaveBeenCalled();
	});

	it("refuses on a Cancelled visit", async () => {
		const { tx } = setup({ status: "Cancelled" });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.code).toBe("WRONG_STATE");
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("a planned line keeps qty_planned in step with the quantity", async () => {
		const { tx } = setup({ line: { fulfillment_status: "planned", qty_planned: 1 } });
		await updateFieldLineQuantity(VISIT_ID, LINE_ID, 3, ORG_ID, TECH_CTX);
		expect(tx.job_visit_line_item.update).toHaveBeenCalledWith({
			where: { id: LINE_ID },
			data: { quantity: 3, total: 150, qty_planned: 3 },
		});
	});

	it("refuses a voided line", async () => {
		const { tx } = setup({ line: { fulfillment_status: "voided", qty_planned: 2 } });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 3, ORG_ID, TECH_CTX);
		expect(res.code).toBe("WRONG_STATE");
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
		expect(tx.job_visit_line_item.delete).not.toHaveBeenCalled();
	});

	it("locks the visit before the line, the order completion takes", async () => {
		const { locks } = setup();
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.err).toBe("");
		expect(locks).toEqual(["visit", "line"]);
	});

	it("a visit completed after the unlocked read is refused under the lock", async () => {
		const { tx, locks } = setup({ status: "InProgress", lockedStatus: "Completed" });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res).toMatchObject({ code: "WRONG_STATE", err: "Lines can't be changed on a Completed visit" });
		expect(locks).toEqual(["visit"]);
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("a technician unassigned after the unlocked read is refused under the lock", async () => {
		const { tx } = setup({ lockedTechs: [] });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.code).toBe("FORBIDDEN");
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("refuses on a visit that has been invoiced", async () => {
		const { tx } = setup({ invoiced: true });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, DISPATCHER_CTX);
		expect(res).toMatchObject({
			code: "WRONG_STATE",
			err: "Lines can't be changed on a visit that has been invoiced",
		});
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("refuses a labor line", async () => {
		const { tx } = setup({ line: { item_type: "labor" } });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 0, ORG_ID, TECH_CTX);
		expect(res).toMatchObject({ code: "WRONG_STATE", err: "Labor lines follow the time clock." });
		expect(tx.job_visit_line_item.delete).not.toHaveBeenCalled();
	});

	it("refuses a line a time entry points at, whatever its item_type", async () => {
		const { tx } = setup({ line: { item_type: "service" }, timeEntryLinked: true });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 3, ORG_ID, TECH_CTX);
		expect(res).toMatchObject({ code: "WRONG_STATE", err: "Labor lines follow the time clock." });
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("a line that is not on this visit is NOT_FOUND", async () => {
		setup({ line: null });
		const res = await updateFieldLineQuantity(VISIT_ID, LINE_ID, 2, ORG_ID, TECH_CTX);
		expect(res.code).toBe("NOT_FOUND");
	});
});
