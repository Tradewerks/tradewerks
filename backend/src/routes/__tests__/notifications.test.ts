import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("./harness.js");
	return { db: createFakeDb() };
});

import notificationsRouter, { dispatcherNotificationsRouter } from "../notifications.js";
import { db } from "../../db.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;

describe("technician notification routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fake.technician_notification.findMany.mockResolvedValue([]);
	});

	it("rejects reading another technician's notifications", async () => {
		const r = await callRoute(notificationsRouter, "get", "/:id/notifications", {
			user: { uid: "tech-2" },
			params: { id: "tech-1" },
		});
		expect(r.status).toBe(403);
		expect(fake.technician_notification.findMany).not.toHaveBeenCalled();
	});

	it("lists own notifications scoped to the caller's org", async () => {
		const r = await callRoute(notificationsRouter, "get", "/:id/notifications", {
			user: { uid: "tech-1" },
			params: { id: "tech-1" },
		});
		expect(r.status).toBe(200);
		const where = fake.technician_notification.findMany.mock.calls[0][0].where;
		expect(JSON.stringify(where)).toContain('"technician":{"organization_id":"org-1"}');
	});

	it("rejects reading another dispatcher's notifications", async () => {
		const r = await callRoute(dispatcherNotificationsRouter, "get", "/:id/notifications", {
			user: { uid: "disp-2" },
			params: { id: "disp-1" },
		});
		expect(r.status).toBe(403);
		expect(fake.dispatcher_notification.findMany).not.toHaveBeenCalled();
	});
});
