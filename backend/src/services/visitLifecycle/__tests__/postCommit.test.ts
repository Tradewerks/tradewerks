import { describe, it, expect, vi, beforeEach } from "vitest";

const visitRow = {
	id: "v1",
	name: "Visit",
	scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
	status: "Completed",
	job_id: "j1",
	job: { id: "j1", job_number: "J-1", client: { name: "Acme" } },
	visit_techs: [
		{ tech_id: "t1", tech: { name: "Ana" } },
		{ tech_id: "t2", tech: { name: "Ben" } },
	],
};

vi.mock("../../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => ({
		job_visit: { findFirst: vi.fn(async () => visitRow) },
		organization: {
			findUnique: vi.fn(async () => ({ wrapping_up_minutes: 15 })),
		},
	})),
}));
vi.mock("../../../controllers/jobVisitsController.js", () => ({
	buildVisitStatusPayload: vi.fn(() => ({})),
}));
vi.mock("../../socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../../lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn(async () => undefined),
}));
vi.mock("../../wrappingUpTimer.js", () => ({
	scheduleWrappingUpClear: vi.fn(),
	cancelWrappingUpTimer: vi.fn(),
}));
vi.mock("../../followupTriggers.js", () => ({
	onVisitCancelled: vi.fn(async () => undefined),
}));
vi.mock("../../../controllers/notificationsController.js", () => ({
	createNotification: vi.fn(async () => undefined),
	notifyDispatchers: vi.fn(async () => []),
}));
vi.mock("../../customerComms/visitEvents.js", () => ({
	notifyTechOnTheWay: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyJobCancelled: vi.fn(async () => undefined),
	skipVisitReminders: vi.fn(async () => undefined),
}));
vi.mock("../autoInvoice.js", () => ({
	maybeAutoInvoiceOnCompletion: vi.fn(async () => undefined),
}));

import { runPostCommit, type PostCommitEffects } from "../postCommit.js";
import * as comms from "../../customerComms/visitEvents.js";
import { emitToOrg } from "../../socketService.js";
import { fireLowStockAlerts } from "../../lowStockAlerts.js";
import { onVisitCancelled } from "../../followupTriggers.js";
import {
	createNotification,
	notifyDispatchers,
} from "../../../controllers/notificationsController.js";
import { maybeAutoInvoiceOnCompletion } from "../autoInvoice.js";

const effects = (over: Partial<PostCommitEffects> = {}): PostCommitEffects => ({
	orgId: "o1",
	visitId: "v1",
	jobId: "j1",
	action: "complete",
	from: "InProgress",
	to: "Completed",
	at: new Date("2027-03-01T16:00:00Z"),
	jobChange: null,
	lowStockItemIds: [],
	autoInvoicePlanId: null,
	wrappingUpTechIds: [],
	activatedTechIds: [],
	cancelledTechIds: [],
	suppressCustomerNotice: false,
	cancellationReason: null,
	...over,
});

beforeEach(() => vi.clearAllMocks());

describe("runPostCommit", () => {
	it("calls notifyJobCompleted exactly once when jobChange.to is Completed", async () => {
		await runPostCommit(
			effects({ jobChange: { from: "InProgress", to: "Completed" } }),
		);
		expect(comms.notifyJobCompleted).toHaveBeenCalledTimes(1);
		expect(comms.notifyJobCompleted).toHaveBeenCalledWith("j1", "o1");
		expect(comms.notifyVisitCompleted).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({ type: "job_finished" }),
			"o1",
			undefined,
		);
		expect(emitToOrg).toHaveBeenCalledWith("o1", "job:updated", {
			jobId: "j1",
			organizationId: "o1",
		});
	});

	it("does not call notifyJobCompleted when the job did not change", async () => {
		await runPostCommit(effects());
		expect(comms.notifyJobCompleted).not.toHaveBeenCalled();
		expect(comms.notifyVisitCompleted).toHaveBeenCalledTimes(1);
	});

	it("suppressCustomerNotice skips notifyVisitCancelled but still notifies techs", async () => {
		await runPostCommit(
			effects({
				action: "cancel",
				from: "Scheduled",
				to: "Cancelled",
				suppressCustomerNotice: true,
				cancelledTechIds: ["t1", "t2"],
				cancellationReason: "Customer called",
			}),
		);
		expect(comms.notifyVisitCancelled).not.toHaveBeenCalled();
		// No notice, but the visit's queued reminders are still dropped.
		expect(comms.skipVisitReminders).toHaveBeenCalledWith(
			"v1",
			"o1",
			"job_cancelled",
		);
		expect(onVisitCancelled).toHaveBeenCalledWith("v1", "o1");
		expect(createNotification).toHaveBeenCalledTimes(2);
		expect(createNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				technicianId: "t1",
				type: "visit_cancelled",
				body: expect.stringContaining("Reason: Customer called"),
			}),
			"o1",
		);
	});

	it("an unsuppressed cancel sends the customer notice and job cancel notice", async () => {
		await runPostCommit(
			effects({
				action: "cancel",
				from: "Scheduled",
				to: "Cancelled",
				jobChange: { from: "Scheduled", to: "Cancelled" },
			}),
		);
		expect(comms.notifyVisitCancelled).toHaveBeenCalledTimes(1);
		expect(comms.skipVisitReminders).not.toHaveBeenCalled();
		expect(comms.notifyJobCancelled).toHaveBeenCalledWith("j1", "o1");
	});

	it("one failing effect does not stop the rest", async () => {
		vi.mocked(emitToOrg).mockImplementation(() => {
			throw new Error("socket down");
		});
		vi.mocked(fireLowStockAlerts).mockRejectedValueOnce(new Error("smtp"));
		vi.mocked(notifyDispatchers).mockRejectedValueOnce(new Error("db"));
		await expect(
			runPostCommit(
				effects({
					lowStockItemIds: ["i1"],
					jobChange: { from: "InProgress", to: "Completed" },
					autoInvoicePlanId: "p1",
				}),
			),
		).resolves.toBeUndefined();
		expect(comms.notifyVisitCompleted).toHaveBeenCalledTimes(1);
		expect(comms.notifyJobCompleted).toHaveBeenCalledTimes(1);
		expect(maybeAutoInvoiceOnCompletion).toHaveBeenCalledWith(
			"o1",
			"v1",
			"p1",
		);
		vi.mocked(emitToOrg).mockReset();
	});

	it("drive tells the customer which tech is on the way; restore sends the reschedule notice", async () => {
		await runPostCommit(
			effects({
				action: "drive",
				from: "Scheduled",
				to: "Driving",
				activatedTechIds: ["t2"],
			}),
		);
		expect(comms.notifyTechOnTheWay).toHaveBeenCalledWith("v1", "t2", "o1");
		// A dispatcher drive with no eligible tech still tells the customer.
		vi.mocked(comms.notifyTechOnTheWay).mockClear();
		await runPostCommit(
			effects({ action: "drive", from: "Scheduled", to: "Driving" }),
		);
		expect(comms.notifyTechOnTheWay).toHaveBeenCalledWith(
			"v1",
			undefined,
			"o1",
		);
		await runPostCommit(
			effects({ action: "restore", from: "Cancelled", to: "Scheduled" }),
		);
		expect(comms.notifyVisitRescheduled).toHaveBeenCalledWith("v1", "o1");
	});

	it("low-stock alerts are not awaited", async () => {
		let release!: () => void;
		vi.mocked(fireLowStockAlerts).mockImplementationOnce(
			() => new Promise<void>((r) => (release = r)),
		);
		await expect(
			runPostCommit(
				effects({
					action: "complete",
					from: "InProgress",
					to: "Completed",
					lowStockItemIds: ["i1"],
				}),
			),
		).resolves.toBeUndefined();
		expect(fireLowStockAlerts).toHaveBeenCalledWith(["i1"], "o1");
		expect(comms.notifyVisitCompleted).toHaveBeenCalledTimes(1);
		release();
	});

	it("delay notifies dispatchers", async () => {
		await runPostCommit(
			effects({ action: "delay", from: "Scheduled", to: "Delayed" }),
			{ dispatcherId: "d1" },
		);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({ type: "visit_delayed" }),
			"o1",
			"d1",
		);
	});
});
