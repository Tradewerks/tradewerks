import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		client: { findUnique: vi.fn(), update: vi.fn() },
		quote: { findUnique: vi.fn(), update: vi.fn() },
		request: { findUnique: vi.fn(), update: vi.fn() },
		recurring_plan: { findFirst: vi.fn() },
		job: { create: vi.fn(), findUnique: vi.fn() },
		job_line_item: { createMany: vi.fn() },
		technician: { findMany: vi.fn() },
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateJobNumber: vi.fn(async () => "J-0042"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn(() => ({ emit: vi.fn() })),
}));

vi.mock("../../services/tax/taxMode.js", () => ({
	getEffectiveTaxMode: vi.fn(async () => "manual"),
	dropClientTaxTotals: <T,>(p: T) => p,
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeJobTotals: vi.fn(async () => ({ ok: true })),
	holdsKeptRate: vi.fn(async () => false),
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { insertJob } from "../jobsController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const CLIENT = "3f1c2a8e-9b4d-4c6a-8e2f-1a2b3c4d5e6f";
const OTHER_CLIENT = "9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const PLAN = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";

const create = (body: Record<string, unknown> = {}) =>
	insertJob(
		{
			body: {
				client_id: CLIENT,
				name: "Maintenance",
				description: "Seasonal tune-up",
				address: "1 Main St",
				coords: { lat: 30.2, lon: -97.7 },
				recurring_plan_id: PLAN,
				...body,
			},
			user: { organization_id: "org1" },
		} as unknown as Request,
		{ dispatcherId: "d1" },
	);

/**
 * The job write trusted recurring_plan_id, and getScopedDb does not check
 * creates against foreign parents. Another org's plan id attached to the job,
 * and the job detail include then served that plan back to the wrong org.
 */
describe("job create with a recurring_plan_id", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.client.findUnique).mockResolvedValue({ id: CLIENT });
		mockFn(db.job.create).mockResolvedValue({
			id: "j1",
			job_number: "J-0042",
			name: "Maintenance",
			priority: "Medium",
			status: "Unscheduled",
			client_id: CLIENT,
		});
		mockFn(db.job.findUnique).mockResolvedValue({ id: "j1" });
	});

	it("refuses a recurring_plan_id the caller's org cannot see", async () => {
		mockFn(db.recurring_plan.findFirst).mockResolvedValue(null);

		const result = await create();

		expect(result.err).toBe("Recurring plan not found");
		expect(result.code).toBe("NOT_FOUND");
		expect(db.recurring_plan.findFirst).toHaveBeenCalledWith({
			where: { id: PLAN },
			select: { id: true, client_id: true },
		});
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("refuses a plan that belongs to another client", async () => {
		mockFn(db.recurring_plan.findFirst).mockResolvedValue({
			id: PLAN,
			client_id: OTHER_CLIENT,
		});

		const result = await create();

		expect(result.err).toBe("This recurring plan belongs to a different client.");
		expect(result.code).toBeUndefined();
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("attaches a plan owned by the same client", async () => {
		mockFn(db.recurring_plan.findFirst).mockResolvedValue({ id: PLAN, client_id: CLIENT });

		const result = await create();

		expect(result.err).toBe("");
		expect(mockFn(db.job.create).mock.calls[0][0].data.recurring_plan_id).toBe(PLAN);
	});

	it("skips the plan lookup when no plan is given", async () => {
		const result = await create({ recurring_plan_id: undefined });

		expect(result.err).toBe("");
		expect(db.recurring_plan.findFirst).not.toHaveBeenCalled();
		expect(mockFn(db.job.create).mock.calls[0][0].data.recurring_plan_id).toBeNull();
	});
});
