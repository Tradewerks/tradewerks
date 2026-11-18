import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, sdb, createNotification } = vi.hoisted(() => {
	const sdb = {
		job_visit: { findFirst: vi.fn(), findUnique: vi.fn() },
		$transaction: vi.fn(),
	};
	return {
		sdb,
		mockDb: { organization: { findUniqueOrThrow: vi.fn() } },
		createNotification: vi.fn(),
	};
});

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
}));
vi.mock("../../db.js", () => ({ db: mockDb }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => sdb }));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn().mockResolvedValue(true),
}));
vi.mock("../notificationsController.js", () => ({
	createNotification,
	notifyDispatchers: vi.fn(),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn().mockResolvedValue(undefined),
	onVisitRescheduled: vi.fn().mockResolvedValue(undefined),
	onVisitCancelled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { updateJobVisit } from "../jobVisitsController.js";

describe("updateJobVisit visit_changed notice", () => {
	beforeEach(() => vi.clearAllMocks());

	it("the visit_changed tech notification formats the new time in the org timezone", async () => {
		const existing = {
			id: "v1",
			scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
			job: { client: { name: "Acme" }, recurring_plan_id: null },
			line_items: [],
			visit_techs: [{ tech_id: "t1" }],
		};
		const updated = {
			...existing,
			scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
		};
		sdb.job_visit.findFirst.mockResolvedValue(existing);
		sdb.$transaction.mockImplementation(async () => updated);
		mockDb.organization.findUniqueOrThrow.mockResolvedValue({
			timezone: "Pacific/Auckland",
		});

		await updateJobVisit(
			{
				params: { id: "v1" },
				body: { scheduled_start_at: "2026-11-19T01:00:00.000Z" },
			} as never,
			"org1",
		);

		expect(createNotification).toHaveBeenCalledTimes(1);
		// 2026-11-19T01:00Z is 2:00 PM NZDT on Thursday the 19th.
		expect(createNotification.mock.calls[0][0].body).toContain(
			"Thursday, November 19 at 2:00 PM",
		);
	});
});
