import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/requirePermissions.js", () => ({
	requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
	requireAnyPermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../db.js", async () => ({ db: (await import("./harness.js")).createFakeDb() }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ techId: "tech-1" }),
}));
vi.mock("../../controllers/jobVisitsController.js", () => ({ LIFECYCLE_TRANSITIONS: {} }));
vi.mock("../../controllers/visitTimeEntriesController.js", () => ({}));
vi.mock("../../controllers/vehiclesController.js", () => ({}));
vi.mock("../../controllers/visitFieldLinesController.js", () => ({
	updateFieldLineQuantity: vi.fn(),
}));

import jobVisitsRouter from "../jobVisits.js";
import { updateFieldLineQuantity } from "../../controllers/visitFieldLinesController.js";
import { callRoute } from "./harness.js";

const PATH = "/:id/field-lines/:lineItemId";
const call = (body: unknown) =>
	callRoute(jobVisitsRouter, "patch", PATH, {
		params: { id: "v1", lineItemId: "l1" },
		body,
	});

beforeEach(() => vi.mocked(updateFieldLineQuantity).mockReset());

describe("PATCH /job-visits/:id/field-lines/:lineItemId", () => {
	it("passes only the quantity through; unit_price in the body is never forwarded", async () => {
		vi.mocked(updateFieldLineQuantity).mockResolvedValue({ err: "", item: { id: "v1" } });
		const res = await call({ quantity: 2, unit_price: 0, name: "x" });
		expect(res.status).toBe(200);
		expect(updateFieldLineQuantity).toHaveBeenCalledWith(
			"v1",
			"l1",
			2,
			"org-1",
			expect.objectContaining({ techId: "tech-1" }),
		);
	});

	it.each([
		["FORBIDDEN", 403],
		["WRONG_STATE", 409],
		["CONFLICT", 409],
		["NOT_FOUND", 404],
	])("maps %s to %i", async (code, status) => {
		vi.mocked(updateFieldLineQuantity).mockResolvedValue({ err: "nope", code } as never);
		const res = await call({ quantity: 1 });
		expect(res.status).toBe(status);
		expect(res.body.error.code).toBe(code);
	});

	it("a negative or missing quantity is a 400", async () => {
		expect((await call({ quantity: -1 })).status).toBe(400);
		expect((await call({})).status).toBe(400);
		expect(updateFieldLineQuantity).not.toHaveBeenCalled();
	});
});
