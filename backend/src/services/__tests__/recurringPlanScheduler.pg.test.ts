import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: advisory and row locks only mean anything across real
// connections. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});
vi.mock("../customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
}));
vi.mock("../followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(() => Promise.resolve()),
}));

const DAY = 86_400_000;

describe.runIf(DB_URL)("recurring plan top-up locking against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let topUpPlan: typeof import("../recurringPlanScheduler.js").topUpPlan;
	let orgId: string;
	let planId: string;

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		({ topUpPlan } = await import("../recurringPlanScheduler.js"));
		const org = await db.organization.create({
			data: { name: "PG recurring top-up lock" },
		});
		orgId = org.id;
		const client = await db.client.create({
			data: {
				organization_id: orgId,
				name: "Top-up client",
				address: "1 Main St",
				coords: {},
			},
		});
		// Starts in 30 days with no advance window, so no visit (and no
		// customer message) is due; generation alone shows the run happened.
		const plan = await db.recurring_plan.create({
			data: {
				organization_id: orgId,
				client_id: client.id,
				name: "Weekly check",
				description: "Lock test",
				address: "1 Main St",
				starts_at: new Date(Date.now() + 30 * DAY),
				timezone: "America/Chicago",
				generation_window_days: 60,
				min_advance_days: 0,
				rules: {
					create: {
						frequency: "daily",
						interval: 7,
						arrival_constraint: "anytime",
						finish_constraint: "when_done",
					},
				},
			},
		});
		planId = plan.id;
	});

	afterAll(async () => {
		if (!orgId) return;
		await db.recurring_plan.deleteMany({
			where: { organization_id: orgId },
		});
		await db.client.deleteMany({ where: { organization_id: orgId } });
		await db.organization.delete({ where: { id: orgId } });
	});

	it("skips the plan while another connection holds its advisory lock", async () => {
		const result = await db.$transaction(
			async (holder) => {
				await holder.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${"recurring_topup:" + planId}))::text`;
				return topUpPlan(planId, orgId);
			},
			{ timeout: 30_000 },
		);

		expect(result).toEqual({ generated: 0, visitsCreated: 0 });
		const plan = await db.recurring_plan.findUniqueOrThrow({
			where: { id: planId },
		});
		expect(plan.last_topped_up_at).toBeNull();
		expect(
			await db.recurring_occurrence.count({
				where: { recurring_plan_id: planId },
			}),
		).toBe(0);
	});

	it("runs once the lock is free, through the plan row lock", async () => {
		const result = await topUpPlan(planId, orgId);

		expect(result.generated).toBeGreaterThan(0);
		expect(result.visitsCreated).toBe(0);
		const plan = await db.recurring_plan.findUniqueOrThrow({
			where: { id: planId },
		});
		expect(plan.last_topped_up_at).not.toBeNull();
		expect(
			await db.recurring_occurrence.count({
				where: { recurring_plan_id: planId },
			}),
		).toBe(result.generated);
	});
});
