import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));
vi.mock("../../services/emailService.js", () => ({}));

import { getRequestsByClientId } from "../requestsController.js";
import { db } from "../../db.js";

const fake = db as unknown as { request: { findMany: ReturnType<typeof vi.fn> } };
const include = () => fake.request.findMany.mock.calls[0][0].include;

beforeEach(() => {
	vi.clearAllMocks();
	fake.request.findMany.mockResolvedValue([]);
});

describe("getRequestsByClientId read scope", () => {
	it("client requests omit quote totals without view_quotes", async () => {
		await getRequestsByClientId("c1", "org-1", { quotes: false });
		expect(include()).not.toHaveProperty("quotes");
	});

	it("client requests list only assigned jobs for an assigned-only caller", async () => {
		await getRequestsByClientId("c1", "org-1", { assignedTechId: "tech-1", quotes: false });
		expect(include().jobs.where).toEqual({
			visits: { some: { visit_techs: { some: { tech_id: "tech-1" } } } },
		});
	});

	it("an unscoped read keeps quotes and every job", async () => {
		await getRequestsByClientId("c1", "org-1", { quotes: true });
		expect(include().quotes.select.total).toBe(true);
		expect(include().jobs.where).toBeUndefined();
	});
});
