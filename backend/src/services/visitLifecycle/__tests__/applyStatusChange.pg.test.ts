import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the race guard is a row lock plus a re-checked WHERE, and the
// side effects are rows in other tables. Scratch/CI database only, never dev.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

vi.mock("../../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));
vi.mock("../../followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(),
	onVisitRescheduled: vi.fn(),
	onVisitCancelled: vi.fn(),
}));
vi.mock("../../lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../wrappingUpTimer.js", () => ({
	scheduleWrappingUpClear: vi.fn(),
	cancelWrappingUpTimer: vi.fn(),
}));
vi.mock("../../../controllers/notificationsController.js", () => ({
	createNotification: vi.fn().mockResolvedValue(undefined),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyJobCancelled: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
}));

type VisitStatus =
	| "Scheduled"
	| "Driving"
	| "OnSite"
	| "InProgress"
	| "Paused"
	| "Completed"
	| "Cancelled";

describe.runIf(DB_URL)("visit lifecycle service against Postgres", () => {
	let db: typeof import("../../../db.js").db;
	let svc: typeof import("../index.js");
	let comms: typeof import("../../customerComms/visitEvents.js");
	const orgIds: string[] = [];
	const dispatcher = { dispatcherId: undefined as string | undefined };

	beforeAll(async () => {
		({ db } = await import("../../../db.js"));
		svc = await import("../index.js");
		comms = await import("../../customerComms/visitEvents.js");
	}, 60_000);

	afterAll(async () => {
		if (!orgIds.length) return;
		const mine = { organization_id: { in: orgIds } };
		await db.log.deleteMany({ where: mine });
		await db.invoice.deleteMany({ where: mine });
		await db.stock_movement.deleteMany({ where: mine });
		await db.visit_tech_time_entry.deleteMany({
			where: { visit: { job: mine } },
		});
		await db.job_visit_line_item.deleteMany({
			where: { visit: { job: mine } },
		});
		await db.job_visit.deleteMany({ where: { job: mine } });
		await db.job.deleteMany({ where: mine });
		await db.invoice_schedule.deleteMany({
			where: { recurring_plan: mine },
		});
		await db.recurring_plan.deleteMany({ where: mine });
		await db.inventory_item.deleteMany({ where: mine });
		await db.client.deleteMany({ where: mine });
		await db.technician.deleteMany({ where: mine });
		await db.organization.deleteMany({ where: { id: { in: orgIds } } });
	});

	async function seedOrg(label: string) {
		const org = await db.organization.create({
			data: { name: `PG lifecycle ${label}` },
		});
		orgIds.push(org.id);
		const tech = (name: string) =>
			db.technician.create({
				data: {
					organization_id: org.id,
					name,
					email: `${label}-${name}-${org.id}@lifecycle.test`,
					phone: "555-0100",
					password: "x",
					title: "Tech",
					description: "",
					hire_date: new Date("2025-01-01"),
					hourly_rate: 60,
					status: "Working",
				},
			});
		const [a, b] = await Promise.all([tech("Ana"), tech("Ben")]);
		const client = await db.client.create({
			data: {
				organization_id: org.id,
				name: `Client ${label}`,
				address: "1 Main St",
				coords: {},
			},
		});
		return { orgId: org.id, clientId: client.id, a, b };
	}

	async function seedJob(
		orgId: string,
		clientId: string,
		label: string,
		opts: { planId?: string; status?: "Scheduled" | "InProgress" } = {},
	) {
		return db.job.create({
			data: {
				organization_id: orgId,
				client_id: clientId,
				job_number: `J-${label}-${Math.random().toString(36).slice(2, 8)}`,
				name: "Tune-up",
				description: "Seasonal",
				address: "1 Main St",
				coords: {},
				status: opts.status ?? "InProgress",
				...(opts.planId ? { recurring_plan_id: opts.planId } : {}),
			},
		});
	}

	async function seedVisit(
		jobId: string,
		status: VisitStatus,
		techs: {
			id: string;
			status: "Assigned" | "EnRoute" | "OnSite" | "Done";
		}[],
	) {
		const visit = await db.job_visit.create({
			data: {
				job_id: jobId,
				name: "Visit",
				status,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
				scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
				scheduled_end_at: new Date("2027-03-01T16:00:00Z"),
			},
		});
		for (const t of techs) {
			await db.job_visit_technician.create({
				data: {
					visit_id: visit.id,
					tech_id: t.id,
					tech_status: t.status,
				},
			});
		}
		return visit;
	}

	async function seedPlan(orgId: string, clientId: string, label: string) {
		const plan = await db.recurring_plan.create({
			data: {
				organization_id: orgId,
				client_id: clientId,
				name: `Plan ${label}`,
				description: "Quarterly",
				address: "1 Main St",
				starts_at: new Date("2027-01-01T00:00:00Z"),
			},
		});
		await db.invoice_schedule.create({
			data: {
				recurring_plan_id: plan.id,
				frequency: "on_visit_completion",
				billing_basis: "fixed_amount",
				fixed_amount: 100,
			},
		});
		return plan;
	}

	const apply = (
		orgId: string,
		args: Omit<
			Parameters<typeof import("../index.js").applyStatusChange>[1],
			"orgId"
		>,
	) => db.$transaction((tx) => svc.applyStatusChange(tx, { orgId, ...args }));

	const lockWaiters = async () =>
		Number(
			(
				await db.$queryRaw<{ n: bigint }[]>`
					SELECT count(*) AS n FROM pg_stat_activity
					WHERE datname = current_database() AND wait_event_type = 'Lock'`
			)[0].n,
		);

	/**
	 * Deterministic race: A writes and holds its tx open; B starts and is let
	 * run until it is blocked on a row lock A holds; then A commits.
	 */
	async function raceWhileHeld<A, B>(
		first: (
			tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
		) => Promise<A>,
		second: () => Promise<B>,
	): Promise<[A, PromiseSettledResult<B>]> {
		let secondRun!: Promise<PromiseSettledResult<B>>;
		const a = await db.$transaction(
			async (tx) => {
				const res = await first(tx);
				const baseline = await lockWaiters();
				secondRun = second().then(
					(value) => ({ status: "fulfilled", value }) as const,
					(reason) => ({ status: "rejected", reason }) as const,
				);
				const deadline = Date.now() + 5_000;
				while (
					(await lockWaiters()) <= baseline &&
					Date.now() < deadline
				)
					await new Promise((r) => setTimeout(r, 25));
				return res;
			},
			{ timeout: 15_000 },
		);
		return [a, await secondRun];
	}

	const techRow = (visitId: string, techId: string) =>
		db.job_visit_technician.findUniqueOrThrow({
			where: { visit_id_tech_id: { visit_id: visitId, tech_id: techId } },
		});

	it("tech completes a plan visit billed on_visit_completion → one invoice", async () => {
		const { orgId, clientId, a } = await seedOrg("inv1");
		const plan = await seedPlan(orgId, clientId, "inv1");
		const job = await seedJob(orgId, clientId, "inv1", { planId: plan.id });
		const visit = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
		]);

		const effects = await apply(orgId, {
			visitId: visit.id,
			action: "complete",
			context: { techId: a.id },
		});
		expect(effects.autoInvoicePlanId).toBe(plan.id);
		await svc.runPostCommit(effects, { techId: a.id });

		expect(
			await db.invoice.count({ where: { recurring_plan_id: plan.id } }),
		).toBe(1);
	});

	it("reopen then complete again creates no second invoice and deducts stock once", async () => {
		const { orgId, clientId, a } = await seedOrg("reopen");
		const plan = await seedPlan(orgId, clientId, "reopen");
		const job = await seedJob(orgId, clientId, "reopen", {
			planId: plan.id,
		});
		const visit = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
		]);
		const item = await db.inventory_item.create({
			data: {
				organization_id: orgId,
				name: "Filter",
				description: "20x25x1",
				quantity: 10,
			},
		});
		await db.job_visit_line_item.create({
			data: {
				visit_id: visit.id,
				name: "Filter",
				quantity: 2,
				unit_price: 15,
				total: 30,
				source: "field_addition",
				item_type: "material",
				sort_order: 1,
				inventory_item_id: item.id,
			},
		});

		const first = await apply(orgId, {
			visitId: visit.id,
			action: "complete",
			context: { techId: a.id },
		});
		await svc.runPostCommit(first);

		const reopened = await apply(orgId, {
			visitId: visit.id,
			action: "reopen",
			context: { dispatcherId: dispatcher.dispatcherId ?? "d-1" },
		});
		expect(reopened.to).toBe("InProgress");
		expect(
			(await db.job_visit.findUniqueOrThrow({ where: { id: visit.id } }))
				.actual_end_at,
		).toBeNull();

		const second = await apply(orgId, {
			visitId: visit.id,
			action: "complete",
			context: { techId: a.id },
		});
		await svc.runPostCommit(second);

		expect(
			await db.invoice.count({ where: { recurring_plan_id: plan.id } }),
		).toBe(1);
		expect(
			await db.stock_movement.count({ where: { visit_id: visit.id } }),
		).toBe(1);
	});

	it("two concurrent completes: one succeeds, the other is refused with a 409, side effects once", async () => {
		const { orgId, clientId, a, b } = await seedOrg("race");
		const job = await seedJob(orgId, clientId, "race");
		const visit = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
			{ id: b.id, status: "OnSite" },
		]);
		await db.visit_tech_time_entry.create({
			data: {
				visit_id: visit.id,
				tech_id: a.id,
				clocked_in_at: new Date(Date.now() - 3_600_000),
			},
		});

		// B blocks on A's visit row lock before it reads; once A commits, B
		// reads Completed and the transition check refuses it.
		const [won, lost] = await raceWhileHeld(
			(tx) =>
				svc.applyStatusChange(tx, {
					orgId,
					visitId: visit.id,
					action: "complete",
					context: { techId: a.id },
				}),
			() =>
				apply(orgId, {
					visitId: visit.id,
					action: "complete",
					context: { techId: b.id },
				}),
		);
		expect(won.to).toBe("Completed");
		expect(lost.status).toBe("rejected");
		const reason = (lost as PromiseRejectedResult).reason;
		expect(reason).toBeInstanceOf(svc.LifecycleRefusal);
		expect(reason.code).toBe("WRONG_STATE");

		expect(
			await db.job_visit_line_item.count({
				where: { visit_id: visit.id, item_type: "labor" },
			}),
		).toBe(1);
		expect(
			await db.log.count({
				where: {
					organization_id: orgId,
					entity_id: visit.id,
					event_type: "job_visit.updated",
				},
			}),
		).toBe(1);
	});

	it("concurrent completes of the two visits of one job leave it Completed, reported once", async () => {
		const { orgId, clientId, a, b } = await seedOrg("jobrace");
		const job = await seedJob(orgId, clientId, "jobrace");
		const v1 = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
		]);
		const v2 = await seedVisit(job.id, "InProgress", [
			{ id: b.id, status: "OnSite" },
		]);

		// Without the job lock B would derive from a snapshot where v1 is
		// still InProgress, and the job would stay InProgress forever.
		const [first, second] = await raceWhileHeld(
			(tx) =>
				svc.applyStatusChange(tx, {
					orgId,
					visitId: v1.id,
					action: "complete",
					context: { techId: a.id },
				}),
			() =>
				apply(orgId, {
					visitId: v2.id,
					action: "complete",
					context: { techId: b.id },
				}),
		);
		expect(second.status).toBe("fulfilled");
		const changes = [
			first.jobChange,
			(second as PromiseFulfilledResult<typeof first>).value.jobChange,
		].filter((c) => c?.to === "Completed");
		expect(changes).toHaveLength(1);

		const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
		expect(after.status).toBe("Completed");
		expect(after.completed_at).not.toBeNull();
	});

	it("complete with two techs clocked in closes both entries and marks both Done", async () => {
		const { orgId, clientId, a, b } = await seedOrg("two");
		const job = await seedJob(orgId, clientId, "two");
		// Ben was added mid-visit and clocked in before his row moved off Assigned.
		const visit = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
			{ id: b.id, status: "Assigned" },
		]);
		const inAt = new Date(Date.now() - 2 * 3_600_000);
		await db.visit_tech_time_entry.createMany({
			data: [
				{ visit_id: visit.id, tech_id: a.id, clocked_in_at: inAt },
				{ visit_id: visit.id, tech_id: b.id, clocked_in_at: inAt },
			],
		});

		const effects = await apply(orgId, {
			visitId: visit.id,
			action: "complete",
			context: { techId: a.id },
		});

		expect(
			await db.visit_tech_time_entry.count({
				where: { visit_id: visit.id, clocked_out_at: null },
			}),
		).toBe(0);
		expect(
			await db.job_visit_line_item.count({
				where: { visit_id: visit.id, item_type: "labor" },
			}),
		).toBe(2);
		expect((await techRow(visit.id, a.id)).tech_status).toBe("Done");
		expect((await techRow(visit.id, b.id)).tech_status).toBe("Done");
		expect(new Set(effects.wrappingUpTechIds)).toEqual(
			new Set([a.id, b.id]),
		);
		const statuses = await db.technician.findMany({
			where: { id: { in: [a.id, b.id] } },
			select: { status: true },
		});
		expect(statuses.every((t) => t.status === "WrappingUp")).toBe(true);
	});

	it("cancel of a Completed visit is refused", async () => {
		const { orgId, clientId, a } = await seedOrg("cancelDone");
		const job = await seedJob(orgId, clientId, "cancelDone");
		const visit = await seedVisit(job.id, "Completed", [
			{ id: a.id, status: "Done" },
		]);
		await expect(
			apply(orgId, {
				visitId: visit.id,
				action: "cancel",
				context: { dispatcherId: "d-1" },
				cancellationReason: "Oops",
			}),
		).rejects.toMatchObject({ code: "WRONG_STATE" });
		expect(
			(await db.job_visit.findUniqueOrThrow({ where: { id: visit.id } }))
				.status,
		).toBe("Completed");
	});

	it("a change committed while the writer waits for the visit lock is judged from the fresh status, not a CONFLICT", async () => {
		const { orgId, clientId, a } = await seedOrg("lockfirst");
		const job = await seedJob(orgId, clientId, "lockfirst", {
			status: "Scheduled",
		});
		const visit = await seedVisit(job.id, "Scheduled", [
			{ id: a.id, status: "Assigned" },
		]);

		// A delays and holds its lock; B (a cancel) queues behind it. Cancel is
		// valid from Delayed too, so B must win once it reads the fresh row.
		const [delayed, cancel] = await raceWhileHeld(
			(tx) =>
				svc.applyStatusChange(tx, {
					orgId,
					visitId: visit.id,
					action: "delay",
					context: { dispatcherId: "d-1" },
				}),
			() =>
				apply(orgId, {
					visitId: visit.id,
					action: "cancel",
					context: { dispatcherId: "d-1" },
					cancellationReason: "Customer called",
				}),
		);
		expect(delayed.to).toBe("Delayed");
		expect(cancel.status).toBe("fulfilled");
		expect((cancel as PromiseFulfilledResult<{ from: string }>).value.from).toBe(
			"Delayed",
		);
		expect(
			(await db.job_visit.findUniqueOrThrow({ where: { id: visit.id } }))
				.status,
		).toBe("Cancelled");
	});

	it("a rolled-back transition leaves no activity rows behind", async () => {
		const { orgId, clientId, a } = await seedOrg("rollbacklog");
		const job = await seedJob(orgId, clientId, "rollbacklog");
		const visit = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
		]);

		await expect(
			db.$transaction(async (tx) => {
				const e = await svc.applyStatusChange(tx, {
					orgId,
					visitId: visit.id,
					action: "complete",
					context: { techId: a.id },
				});
				expect(e.jobChange).not.toBeNull();
				expect(e.logRows).toHaveLength(1);
				throw new Error("caller rolls back");
			}),
		).rejects.toThrow("caller rolls back");

		expect(
			await db.log.count({
				where: {
					organization_id: orgId,
					entity_id: { in: [visit.id, job.id] },
				},
			}),
		).toBe(0);
	});

	it("job with one Cancelled and one completed-by-tech visit becomes Completed with completed_at set", async () => {
		const { orgId, clientId, a } = await seedOrg("mixed");
		const job = await seedJob(orgId, clientId, "mixed");
		await seedVisit(job.id, "Cancelled", [
			{ id: a.id, status: "Assigned" },
		]);
		const visit = await seedVisit(job.id, "InProgress", [
			{ id: a.id, status: "OnSite" },
		]);

		const effects = await apply(orgId, {
			visitId: visit.id,
			action: "complete",
			context: { techId: a.id },
		});
		expect(effects.jobChange).toMatchObject({
			from: "InProgress",
			to: "Completed",
		});

		const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
		expect(after.status).toBe("Completed");
		expect(after.completed_at).not.toBeNull();

		vi.mocked(comms.notifyJobCompleted).mockClear();
		await svc.runPostCommit(effects);
		expect(comms.notifyJobCompleted).toHaveBeenCalledTimes(1);
	});

	it("restore on an explicitly cancelled job clears cancelled_at and cancellation_reason", async () => {
		const { orgId, clientId, a } = await seedOrg("restore");
		const job = await seedJob(orgId, clientId, "restore");
		const visit = await seedVisit(job.id, "Scheduled", [
			{ id: a.id, status: "Assigned" },
		]);
		await db.$transaction(async (tx) => {
			await svc.applyStatusChange(tx, {
				orgId,
				visitId: visit.id,
				action: "cancel",
				context: { dispatcherId: "d-1" },
				cancellationReason: "Customer moved",
				deferJobSync: true,
			});
			await svc.syncJobFromVisits(tx, orgId, job.id, {
				cancel: { reason: "Customer moved" },
			});
		});
		const cancelled = await db.job.findUniqueOrThrow({
			where: { id: job.id },
		});
		expect(cancelled.status).toBe("Cancelled");
		expect(cancelled.cancelled_at).not.toBeNull();
		expect(cancelled.cancellation_reason).toBe("Customer moved");

		const effects = await apply(orgId, {
			visitId: visit.id,
			action: "restore",
			context: { dispatcherId: "d-1" },
		});
		expect(effects.jobChange).toMatchObject({
			from: "Cancelled",
			to: "Scheduled",
		});
		const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
		expect(after.status).toBe("Scheduled");
		expect(after.cancelled_at).toBeNull();
		expect(after.cancellation_reason).toBeNull();
		const v = await db.job_visit.findUniqueOrThrow({
			where: { id: visit.id },
		});
		expect(v.cancellation_reason).toBeNull();
		expect((await techRow(visit.id, a.id)).tech_status).toBe("Assigned");
	});

	it("record_complete closes no time entries when none are open and sets actual_end_at", async () => {
		const { orgId, clientId, a } = await seedOrg("record");
		const job = await seedJob(orgId, clientId, "record", {
			status: "Scheduled",
		});
		const visit = await seedVisit(job.id, "Scheduled", [
			{ id: a.id, status: "Assigned" },
		]);
		const now = new Date("2027-03-01T17:00:00Z");

		const effects = await apply(orgId, {
			visitId: visit.id,
			action: "record_complete",
			context: { dispatcherId: "d-1" },
			now,
		});

		const v = await db.job_visit.findUniqueOrThrow({
			where: { id: visit.id },
		});
		expect(v.status).toBe("Completed");
		expect(v.actual_end_at?.toISOString()).toBe(now.toISOString());
		expect(v.actual_start_at?.toISOString()).toBe(now.toISOString());
		expect(
			await db.job_visit_line_item.count({
				where: { visit_id: visit.id, item_type: "labor" },
			}),
		).toBe(0);
		// Nobody progressed past Assigned, so nobody is wrapping up.
		expect(effects.wrappingUpTechIds).toEqual([]);
		expect((await techRow(visit.id, a.id)).tech_status).toBe("Assigned");
	});

	it("a technician cannot record_complete, and an unassigned technician is FORBIDDEN", async () => {
		const { orgId, clientId, a, b } = await seedOrg("authz");
		const job = await seedJob(orgId, clientId, "authz");
		const visit = await seedVisit(job.id, "Scheduled", [
			{ id: a.id, status: "Assigned" },
		]);
		await expect(
			apply(orgId, {
				visitId: visit.id,
				action: "record_complete",
				context: { techId: a.id },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			apply(orgId, {
				visitId: visit.id,
				action: "drive",
				context: { techId: b.id },
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You aren't assigned to this visit.",
		});
	});
});
