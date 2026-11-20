import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the rollup is a sum over rows plus a write on another table.
// Scratch/CI database only, never dev.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

vi.mock("../../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));

describe.runIf(DB_URL)("job.actual_total rollup against Postgres", () => {
	let db: typeof import("../../../db.js").db;
	let recompute: typeof import("../../../lib/recomputeDocumentTotals.js");
	let rollup: typeof import("../jobRollup.js");
	const orgIds: string[] = [];

	beforeAll(async () => {
		({ db } = await import("../../../db.js"));
		recompute = await import("../../../lib/recomputeDocumentTotals.js");
		rollup = await import("../jobRollup.js");
	}, 60_000);

	afterAll(async () => {
		if (!orgIds.length) return;
		const mine = { organization_id: { in: orgIds } };
		await db.job_visit_line_item.deleteMany({
			where: { visit: { job: mine } },
		});
		await db.job_visit.deleteMany({ where: { job: mine } });
		await db.job.deleteMany({ where: mine });
		await db.client.deleteMany({ where: mine });
		await db.organization.deleteMany({ where: { id: { in: orgIds } } });
	});

	async function seed(label: string, status: "Completed" | "Scheduled") {
		const org = await db.organization.create({
			data: { name: `PG rollup ${label}` },
		});
		orgIds.push(org.id);
		const client = await db.client.create({
			data: {
				organization_id: org.id,
				name: `Client ${label}`,
				address: "1 Main St",
				coords: {},
			},
		});
		const job = await db.job.create({
			data: {
				organization_id: org.id,
				client_id: client.id,
				job_number: `J-${label}`,
				name: "Tune-up",
				description: "Seasonal",
				address: "1 Main St",
				coords: {},
				status: "InProgress",
			},
		});
		const visit = await db.job_visit.create({
			data: {
				job_id: job.id,
				name: "Visit",
				status,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
				scheduled_end_at: new Date("2027-03-01T16:00:00Z"),
			},
		});
		const line = await db.job_visit_line_item.create({
			data: {
				visit_id: visit.id,
				name: "Labor",
				quantity: 1,
				unit_price: 100,
				total: 100,
				source: "field_addition",
				item_type: "labor",
				sort_order: 0,
			},
		});
		return {
			orgId: org.id,
			jobId: job.id,
			visitId: visit.id,
			lineId: line.id,
		};
	}

	async function editLineAndRecompute(
		orgId: string,
		visitId: string,
		lineId: string,
	) {
		await db.job_visit_line_item.update({
			where: { id: lineId },
			data: { unit_price: 250, total: 250 },
		});
		await db.$transaction((tx) =>
			recompute.recomputeVisitTotals(visitId, orgId, tx),
		);
	}

	it("editing a line on a Completed visit moves job.actual_total", async () => {
		const { orgId, jobId, visitId, lineId } = await seed(
			"done",
			"Completed",
		);
		await editLineAndRecompute(orgId, visitId, lineId);
		const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
		const visit = await db.job_visit.findUniqueOrThrow({
			where: { id: visitId },
		});
		// A bare org has no tax rate configured, so the total is the line itself.
		expect(Number(visit.total)).toBe(250);
		expect(Number(job.actual_total)).toBe(Number(visit.total));
	});

	it("editing a line on an open visit leaves job.actual_total alone", async () => {
		const { orgId, jobId, visitId, lineId } = await seed(
			"open",
			"Scheduled",
		);
		await editLineAndRecompute(orgId, visitId, lineId);
		const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
		expect(job.actual_total).toBeNull();
	});

	it("recomputeJobActualTotal sums only Completed visits and returns the sum", async () => {
		const { jobId, visitId } = await seed("sum", "Completed");
		await db.job_visit.update({
			where: { id: visitId },
			data: { total: 40 },
		});
		await db.job_visit.create({
			data: {
				job_id: jobId,
				name: "Open",
				status: "Scheduled",
				total: 999,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: new Date("2027-03-02T15:00:00Z"),
				scheduled_end_at: new Date("2027-03-02T16:00:00Z"),
			},
		});
		const sum = await db.$transaction((tx) =>
			rollup.recomputeJobActualTotal(tx, jobId),
		);
		expect(sum).toBe(40);
		expect(
			Number(
				(await db.job.findUniqueOrThrow({ where: { id: jobId } }))
					.actual_total,
			),
		).toBe(40);
	});

	it("two visits settling at once both land in actual_total: the job is locked before the sum", async () => {
		const { jobId, visitId: a } = await seed("race", "Completed");
		await db.job_visit.update({ where: { id: a }, data: { total: 0 } });
		const b = await db.job_visit.create({
			data: {
				job_id: jobId,
				name: "Second",
				status: "Completed",
				total: 0,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: new Date("2027-03-03T15:00:00Z"),
				scheduled_end_at: new Date("2027-03-03T16:00:00Z"),
			},
		});

		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let summed!: () => void;
		const firstSummed = new Promise<void>((r) => (summed = r));
		const first = db.$transaction(
			async (tx) => {
				await tx.job_visit.update({
					where: { id: a },
					data: { total: 100 },
				});
				await rollup.recomputeJobActualTotal(tx, jobId);
				summed();
				await gate;
			},
			{ timeout: 20_000 },
		);
		await firstSummed;
		// Without the job lock this sum runs now, misses the first visit's
		// uncommitted 100, and its later write drops it.
		const second = db.$transaction(
			async (tx) => {
				await tx.job_visit.update({
					where: { id: b.id },
					data: { total: 50 },
				});
				await rollup.recomputeJobActualTotal(tx, jobId);
			},
			{ timeout: 20_000 },
		);
		for (let i = 0; i < 200; i++) {
			const [{ n }] = await db.$queryRaw<{ n: number }[]>`
				SELECT count(*)::int AS n FROM pg_stat_activity
				WHERE datname = current_database() AND wait_event_type = 'Lock'`;
			if (n > 0) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		release();
		await Promise.all([first, second]);

		const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
		expect(Number(job.actual_total)).toBe(150);
	});
});
