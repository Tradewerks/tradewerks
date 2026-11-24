import { describe, it, expect, vi } from "vitest";

vi.mock("../../controllers/notificationsController.js", () => ({
	createNotification: vi.fn(async () => undefined),
}));
vi.mock("../socketService.js", () => ({ emitToOrg: vi.fn() }));

import { notifyVisitAssigned } from "../visitAssignedNotice.js";
import { createNotification } from "../../controllers/notificationsController.js";

describe("notifyVisitAssigned", () => {
	it("states the visit time in the given timezone, not the server's", async () => {
		// 15:00 UTC is 09:00 in Chicago on Nov 26.
		await notifyVisitAssigned(
			["t1"],
			"v1",
			"Acme",
			new Date("2026-11-26T15:00:00Z"),
			"org-1",
			"America/Chicago",
		);
		const body = vi.mocked(createNotification).mock.calls[0][0].body;
		expect(body.replace(/[  ]/g, " ")).toContain("Thu, Nov 26, 9:00 AM");
	});
});
