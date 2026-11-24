import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	updateRecurringPlan,
	resumeRecurringPlan,
	cancelRecurringPlan,
} from "../recurringPlansController.js";
import { getScopedDb } from "../../lib/context.js";

vi.mock("../../db.js", () => ({ db: {}, generateJobNumber: vi.fn() }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const RULE = {
	frequency: "daily",
	interval: 1,
	arrival_constraint: "anytime",
	finish_constraint: "when_done",
};

function makeSdb(status: string) {
	const plan = { id: "plan-1", organization_id: "org-1", status, rules: [{ id: "rule-1" }], line_items: [] };
	const tx = {
		recurring_plan: {
			update: vi.fn().mockResolvedValue({ ...plan, generation_window_days: 30 }),
			// The final read includes `client`; generateOccurrencesForPlan's doesn't.
			findUnique: vi.fn(({ include }: { include: Record<string, unknown> }) => {
				if (!include.client) throw new Error("REGENERATED");
				return Promise.resolve(plan);
			}),
		},
		recurring_rule: { update: vi.fn() },
		recurring_rule_weekday: { deleteMany: vi.fn(), createMany: vi.fn() },
		// Plan lock + legacy repair (no legacy rows) before the rule is rewritten.
		$queryRaw: vi.fn().mockResolvedValue([{ id: "plan-1" }]),
		recurring_occurrence: { deleteMany: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
		log: { create: vi.fn().mockResolvedValue({ id: "log-1", event_type: "recurring_plan.updated" }) },
	};
	const sdb = {
		recurring_plan: { findFirst: vi.fn().mockResolvedValue({ ...plan, job_container: { id: "job-1" } }) },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		$transaction: vi.fn((cb: any) => cb(tx)),
	};
	vi.mocked(getScopedDb).mockReturnValue(sdb as never);
	return sdb;
}

describe("recurring plan status", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses to resume a cancelled plan", async () => {
		const sdb = makeSdb("Cancelled");
		expect((await resumeRecurringPlan("job-1", "org-1")).err).toMatch(/cancelled plan/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("cancelling an already cancelled plan changes nothing", async () => {
		const sdb = makeSdb("Cancelled");
		expect((await cancelRecurringPlan("job-1", "org-1")).err).toBe("");
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("regenerates occurrences when an active plan's rule changes without a status", async () => {
		makeSdb("Active");
		await expect(updateRecurringPlan("job-1", { rule: RULE }, "org-1")).rejects.toThrow("REGENERATED");
	});

	it("doesn't regenerate occurrences for a cancelled plan", async () => {
		makeSdb("Cancelled");
		expect((await updateRecurringPlan("job-1", { rule: RULE }, "org-1")).err).toBe("");
	});
});
