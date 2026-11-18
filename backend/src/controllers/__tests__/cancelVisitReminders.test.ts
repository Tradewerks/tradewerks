import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, onVisitCancelled } = vi.hoisted(() => ({
	sdb: {
		job_visit: { findFirst: vi.fn() },
		$transaction: vi.fn(),
	},
	onVisitCancelled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
}));
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => sdb }));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn().mockResolvedValue(true),
}));
vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn(),
	notifyDispatchers: vi.fn(),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn().mockResolvedValue(undefined),
	onVisitRescheduled: vi.fn().mockResolvedValue(undefined),
	onVisitCancelled,
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

import { cancelJobVisit } from "../jobVisitsController.js";

describe("cancelJobVisit", () => {
	beforeEach(() => vi.clearAllMocks());

	it("cancelJobVisit calls onVisitCancelled", async () => {
		const visit = {
			id: "v1",
			job_id: "j1",
			status: "Scheduled",
			job: {
				status: "Scheduled",
				job_number: "J-1",
				client: { name: "Acme" },
			},
			visit_techs: [],
		};
		sdb.job_visit.findFirst.mockResolvedValue(visit);
		sdb.$transaction.mockImplementation(async () => undefined);

		await cancelJobVisit("v1", "customer asked", "org1");

		expect(onVisitCancelled).toHaveBeenCalledWith("v1", "org1");
	});
});
