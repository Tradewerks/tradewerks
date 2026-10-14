import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst } = vi.hoisted(() => ({
	mockFindFirst: vi.fn(),
}));

vi.mock("../../db.js", () => ({
	db: { technician: { findFirst: mockFindFirst } },
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => ({ technician: { findFirst: mockFindFirst } })),
}));

vi.mock("../../services/mfaService.js", () => ({
	getMfaEnabledUserIds: vi.fn().mockResolvedValue(new Set()),
	isMfaEnabled: vi.fn().mockResolvedValue(false),
}));

import { getTechnicianById } from "../techniciansController.js";

describe("getTechnicianById", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("includes the technician's current_vehicle relation so callers can tell whether a truck is assigned", async () => {
		mockFindFirst.mockResolvedValue({
			id: "tech-1",
			current_vehicle_id: "vehicle-1",
			current_vehicle: { id: "vehicle-1", name: "Truck 12" },
			organization_role: null,
			visit_techs: [],
		});

		const result = await getTechnicianById("tech-1", "org-1");

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					current_vehicle: { select: { id: true, name: true, stored_at_coords: true } },
				}),
			}),
		);
		expect(result?.current_vehicle).toEqual({ id: "vehicle-1", name: "Truck 12" });
	});
});
