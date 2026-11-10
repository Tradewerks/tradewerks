import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Server } from "socket.io";
import { db } from "../../db.js";
import {
	createNotification,
	DISPATCHER_NOTIFICATION_PERMISSIONS,
	notifyDispatchers,
	setSocketIo,
} from "../notificationsController.js";

vi.mock("../../db.js", () => ({
	db: {
		technician_notification: { create: vi.fn() },
		dispatcher: { findMany: vi.fn() },
		dispatcher_notification: { create: vi.fn() },
	},
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: () => db }));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockDb = vi.mocked(db);
const TECH = "tech-1";
const ROW = { id: "notif-1", technician_id: TECH, type: "field_purchase_reviewed" };

describe("createNotification", () => {
	let emitMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		emitMock = vi.fn();
		// Stub Server: only the `to().emit()` chain notificationsController exercises.
		setSocketIo({ to: () => ({ emit: emitMock }) } as unknown as Server);
	});

	it("returns the notification it created even when the push fails", async () => {
		// The push is best-effort; the row is the record. Reporting a created row as
		// a failure tells the caller nothing reached the technician when the durable
		// half did.
		mockDb.technician_notification.create.mockResolvedValue(ROW);
		emitMock.mockImplementation(() => {
			throw new Error("socket gone");
		});

		const created = await createNotification({
			technicianId: TECH,
			type: "field_purchase_reviewed",
			title: "Purchase approved",
			body: "Your receipt was approved.",
		}, "org-1");

		expect(created).not.toBeNull();
	});

	it("returns null when the database write itself fails", async () => {
		mockDb.technician_notification.create.mockRejectedValue(new Error("db gone"));

		const created = await createNotification({
			technicianId: TECH,
			type: "field_purchase_reviewed",
			title: "Purchase approved",
			body: "Your receipt was approved.",
		}, "org-1");

		expect(created).toBeNull();
	});
});

describe("notifyDispatchers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setSocketIo({ to: () => ({ emit: vi.fn() }) } as unknown as Server);
	});

	it("skips muted, unpermitted and excluded dispatchers, notifies the rest", async () => {
		mockDb.dispatcher.findMany.mockResolvedValue([{ id: "disp-1" }, { id: "disp-2" }] as never);
		mockDb.dispatcher_notification.create.mockResolvedValue({ id: "n" } as never);

		await notifyDispatchers(
			{ type: "job_finished", title: "Job finished", body: "J-0001 is done." },
			"org-1",
			"disp-3",
		);

		const where = mockDb.dispatcher.findMany.mock.calls[0]![0]!.where;
		expect(where).toEqual({
			deactivated_at: null,
			NOT: { muted_notification_types: { has: "job_finished" } },
			OR: [{ role: "admin" }, { organization_role: { permissions: { has: "view_jobs" } } }],
			id: { not: "disp-3" },
		});
		const ids = mockDb.dispatcher_notification.create.mock.calls.map((c) => c[0].data.dispatcher_id);
		expect(ids).toEqual(["disp-1", "disp-2"]);
	});
});

describe("notifyDispatchers recipients (build plan 2)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("never selects deactivated dispatchers", async () => {
		mockDb.dispatcher.findMany.mockResolvedValue([] as never);
		await notifyDispatchers({ type: "usage_limit_warning", title: "t", body: "b" }, "org-1");
		expect(mockDb.dispatcher.findMany.mock.calls[0]![0]!.where).toMatchObject({ deactivated_at: null });
	});
});

describe("tax notification permissions", () => {
	it("routes tax rate changes and QuickBooks tax code prompts to manage_taxes", () => {
		expect(DISPATCHER_NOTIFICATION_PERMISSIONS.tax_rate_changed).toBe("manage_taxes");
		expect(DISPATCHER_NOTIFICATION_PERMISSIONS.qb_tax_code_needed).toBe("manage_taxes");
	});
});
