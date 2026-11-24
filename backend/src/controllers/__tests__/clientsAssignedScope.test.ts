import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("../../routes/__tests__/harness.js")).createFakeDb(),
}));
vi.mock("../../services/emailService.js", () => ({}));

import { getClientById } from "../clientsController.js";
import { db } from "../../db.js";

const fake = db as unknown as { client: { findFirst: ReturnType<typeof vi.fn> } };

beforeEach(() => {
	vi.clearAllMocks();
	fake.client.findFirst.mockResolvedValue(null);
});

describe("getClientById read scope", () => {
	it("an assigned-only caller gets only their jobs, no job totals and no quotes", async () => {
		await getClientById("c1", "org-1", { assignedTechId: "tech-1", quotes: false });
		const { include } = fake.client.findFirst.mock.calls[0][0];
		expect(include.jobs.where).toEqual({
			visits: { some: { visit_techs: { some: { tech_id: "tech-1" } } } },
		});
		expect(include.jobs.select.actual_total).toBe(false);
		expect(include).not.toHaveProperty("quotes");
	});

	it("no scope keeps the full include", async () => {
		await getClientById("c1", "org-1");
		const { include } = fake.client.findFirst.mock.calls[0][0];
		expect(include.jobs.where).toBeUndefined();
		expect(include.jobs.select.actual_total).toBe(true);
		expect(include.quotes.select.total).toBe(true);
	});
});
