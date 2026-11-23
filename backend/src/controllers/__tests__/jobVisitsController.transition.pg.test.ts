import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the transition now runs through the lifecycle service, whose
// guarantees are row locks and rows in other tables. Scratch/CI database only.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(),
	onVisitRescheduled: vi.fn(),
	onVisitCancelled: vi.fn(),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/wrappingUpTimer.js", () => ({
	scheduleWrappingUpClear: vi.fn(),
	cancelWrappingUpTimer: vi.fn(),
}));
vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn().mockResolvedValue(undefined),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyJobCancelled: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
	skipVisitReminders: vi.fn(async () => undefined),
}));
vi.mock("../../lib/vehicleMileage.js", () => ({
	applyOdometerIncrement: vi.fn(),
	fetchRouteDistanceMiles: vi.fn(async () => null),
}));
vi.mock("../../lib/requirePermissions.js", () => ({
	requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
		next(),
	requireAnyPermission:
		() => (_req: unknown, _res: unknown, next: () => void) =>
			next(),
	// Every caller reads as exempt from the route's assignment gate; the service checks assignment.
	hasPermission: () => true,
}));
vi.mock("../../lib/context.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/context.js")>()),
	getUserContext: vi.fn(),
}));

describe.runIf(DB_URL)(
	"applyVisitTransition through the lifecycle service",
	() => {
		let db: typeof import("../../db.js").db;
		let ctl: typeof import("../jobVisitsController.js");
		let router: typeof import("../../routes/jobVisits.js").default;
		let harness: typeof import("../../routes/__tests__/harness.js");
		let ctx: typeof import("../../lib/context.js");
		let sockets: typeof import("../../services/socketService.js");
		const orgIds: string[] = [];

		beforeAll(async () => {
			({ db } = await import("../../db.js"));
			ctl = await import("../jobVisitsController.js");
			router = (await import("../../routes/jobVisits.js")).default;
			harness = await import("../../routes/__tests__/harness.js");
			ctx = await import("../../lib/context.js");
			sockets = await import("../../services/socketService.js");
		}, 60_000);

		afterAll(async () => {
			if (!orgIds.length) return;
			const mine = { organization_id: { in: orgIds } };
			await db.log.deleteMany({ where: mine });
			await db.invoice.deleteMany({ where: mine });
			await db.visit_tech_drive.deleteMany({ where: { tech: mine } });
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
			await db.client.deleteMany({ where: mine });
			await db.technician.deleteMany({ where: mine });
			await db.organization.deleteMany({ where: { id: { in: orgIds } } });
		});

		async function seedOrg(label: string) {
			const org = await db.organization.create({
				data: { name: `PG transition ${label}` },
			});
			orgIds.push(org.id);
			const tech = (name: string) =>
				db.technician.create({
					data: {
						organization_id: org.id,
						name,
						email: `${label}-${name}-${org.id}@transition.test`,
						phone: "555-0100",
						password: "x",
						title: "Tech",
						description: "",
						hire_date: new Date("2025-01-01"),
						hourly_rate: 60,
						status: "Available",
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

		const seedJob = (
			orgId: string,
			clientId: string,
			label: string,
			opts: { planId?: string; status?: "Scheduled" | "InProgress" } = {},
		) =>
			db.job.create({
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

		async function seedVisit(
			jobId: string,
			status: "Scheduled" | "Driving" | "InProgress",
			techs: { id: string; status: "Assigned" | "EnRoute" | "OnSite" }[],
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

		it("tech complete on a plan visit fires the auto-invoice", async () => {
			const { orgId, clientId, a } = await seedOrg("inv");
			const plan = await db.recurring_plan.create({
				data: {
					organization_id: orgId,
					client_id: clientId,
					name: "Plan inv",
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
			const job = await seedJob(orgId, clientId, "inv", {
				planId: plan.id,
			});
			const visit = await seedVisit(job.id, "InProgress", [
				{ id: a.id, status: "OnSite" },
			]);

			const res = await ctl.applyVisitTransition(
				visit.id,
				"complete",
				orgId,
				{
					techId: a.id,
				},
			);
			expect(res.err).toBe("");
			expect(
				await db.invoice.count({
					where: { recurring_plan_id: plan.id },
				}),
			).toBe(1);
			const after = await db.job.findUniqueOrThrow({
				where: { id: job.id },
			});
			expect(after.status).toBe("Completed");
			expect(after.completed_at).not.toBeNull();
		});

		it("drive to a second visit recalls the first and re-derives its job", async () => {
			const { orgId, clientId, a } = await seedOrg("switch");
			const job1 = await seedJob(orgId, clientId, "switch1");
			const job2 = await seedJob(orgId, clientId, "switch2", {
				status: "Scheduled",
			});
			const v1 = await seedVisit(job1.id, "Driving", [
				{ id: a.id, status: "EnRoute" },
			]);
			const v2 = await seedVisit(job2.id, "Scheduled", [
				{ id: a.id, status: "Assigned" },
			]);
			const comms =
				await import("../../services/customerComms/visitEvents.js");
			vi.mocked(sockets.emitToOrg).mockClear();
			vi.mocked(comms.notifyTechOnTheWay).mockClear();

			const res = await ctl.applyVisitTransition(v2.id, "drive", orgId, {
				techId: a.id,
			});
			expect(res.err).toBe("");

			const jobEmits = vi
				.mocked(sockets.emitToOrg)
				.mock.calls.filter(([, ev]) => ev === "job:updated")
				.map(([, , p]) => (p as { jobId: string }).jobId);
			expect(jobEmits).toContain(job1.id);
			const onTheWay = vi
				.mocked(comms.notifyTechOnTheWay)
				.mock.calls.map(([visitId]) => visitId);
			expect(onTheWay).toEqual([v2.id]);

			const [r1, r2, j1, j2] = await Promise.all([
				db.job_visit.findUniqueOrThrow({ where: { id: v1.id } }),
				db.job_visit.findUniqueOrThrow({ where: { id: v2.id } }),
				db.job.findUniqueOrThrow({ where: { id: job1.id } }),
				db.job.findUniqueOrThrow({ where: { id: job2.id } }),
			]);
			expect(r1.status).toBe("Scheduled");
			expect(r2.status).toBe("Driving");
			expect(j1.status).toBe("Scheduled");
			expect(j2.status).toBe("InProgress");
			const row = await db.job_visit_technician.findUniqueOrThrow({
				where: { visit_id_tech_id: { visit_id: v1.id, tech_id: a.id } },
			});
			expect(row.tech_status).toBe("Assigned");

			// The recall is a real status change: logged and broadcast like any other.
			const recallLogs = await db.log.findMany({
				where: {
					organization_id: orgId,
					entity_id: v1.id,
					event_type: "job_visit.updated",
				},
			});
			expect(recallLogs).toHaveLength(1);
			expect((recallLogs[0].changes as any).status).toEqual({
				old: "Driving",
				new: "Scheduled",
			});
			const visitEmits = vi
				.mocked(sockets.emitToOrg)
				.mock.calls.filter(
					([, ev]) => ev === "job_visit:status_changed",
				)
				.map(
					([, , payload]) =>
						payload as { visitId?: string; id?: string },
				);
			expect(
				visitEmits.some((p) => JSON.stringify(p).includes(v1.id)),
			).toBe(true);
		});

		it("transition returns code FORBIDDEN for an unassigned tech and the route answers 403", async () => {
			const { orgId, clientId, a, b } = await seedOrg("authz");
			const job = await seedJob(orgId, clientId, "authz");
			const visit = await seedVisit(job.id, "InProgress", [
				{ id: a.id, status: "OnSite" },
			]);

			const res = await ctl.applyVisitTransition(
				visit.id,
				"pause",
				orgId,
				{
					techId: b.id,
				},
			);
			expect(res).toMatchObject({
				err: "You aren't assigned to this visit.",
				code: "FORBIDDEN",
			});

			vi.mocked(ctx.getUserContext).mockReturnValue({ techId: b.id });
			const http = await harness.callRoute(
				router,
				"post",
				"/:id/transition",
				{
					user: { organization_id: orgId, role: "technician" },
					params: { id: visit.id },
					body: { action: "pause" },
				},
			);
			expect(http.status).toBe(403);
			expect(http.body).toEqual({
				success: false,
				data: null,
				error: expect.objectContaining({
					code: "FORBIDDEN",
					message: "You aren't assigned to this visit.",
				}),
				meta: expect.anything(),
			});

			const wrong = await harness.callRoute(
				router,
				"post",
				"/:id/start",
				{
					user: { organization_id: orgId, role: "technician" },
					params: { id: visit.id },
				},
			);
			expect(wrong.status).toBe(403);

			// An assigned tech on the wrong state still gets 409.
			const later = await seedVisit(job.id, "Scheduled", [
				{ id: a.id, status: "Assigned" },
			]);
			vi.mocked(ctx.getUserContext).mockReturnValue({ techId: a.id });
			const stale = await harness.callRoute(
				router,
				"post",
				"/:id/transition",
				{
					user: { organization_id: orgId, role: "technician" },
					params: { id: later.id },
					body: { action: "pause" },
				},
			);
			expect(stale.status).toBe(409);
			expect(
				(
					await db.job_visit.findUniqueOrThrow({
						where: { id: later.id },
					})
				).status,
			).toBe("Scheduled");
		});

		it("drive to a second visit of the same job recalls the first and leaves the job InProgress", async () => {
			const { orgId, clientId, a } = await seedOrg("samejob");
			const job = await seedJob(orgId, clientId, "samejob");
			const v1 = await seedVisit(job.id, "Driving", [
				{ id: a.id, status: "EnRoute" },
			]);
			const v2 = await seedVisit(job.id, "Scheduled", [
				{ id: a.id, status: "Assigned" },
			]);
			const res = await ctl.applyVisitTransition(v2.id, "drive", orgId, {
				techId: a.id,
			});
			expect(res.err).toBe("");
			expect(
				(await db.job_visit.findUniqueOrThrow({ where: { id: v1.id } }))
					.status,
			).toBe("Scheduled");
			expect(
				(await db.job.findUniqueOrThrow({ where: { id: job.id } }))
					.status,
			).toBe("InProgress");
			const drives = await db.visit_tech_drive.findMany({
				where: { tech_id: a.id, ended_at: null },
			});
			expect(drives.map((d) => d.visit_id)).toEqual([v2.id]);
		});

		it("dispatcher delay closes the open drive and a tech cannot delay", async () => {
			const { orgId, clientId, a } = await seedOrg("delay");
			const job = await seedJob(orgId, clientId, "delay");
			const visit = await seedVisit(job.id, "Driving", [
				{ id: a.id, status: "EnRoute" },
			]);
			await db.visit_tech_drive.create({
				data: {
					visit_id: visit.id,
					tech_id: a.id,
					started_at: new Date(Date.now() - 600_000),
				},
			});

			const byTech = await ctl.applyVisitTransition(
				visit.id,
				"delay",
				orgId,
				{ techId: a.id },
			);
			expect(byTech).toMatchObject({ code: "FORBIDDEN" });

			const res = await ctl.applyVisitTransition(
				visit.id,
				"delay",
				orgId,
				{
					dispatcherId: "d-1",
				},
			);
			expect(res.err).toBe("");
			expect(
				(
					await db.job_visit.findUniqueOrThrow({
						where: { id: visit.id },
					})
				).status,
			).toBe("Delayed");
			expect(
				await db.visit_tech_drive.count({
					where: { visit_id: visit.id, ended_at: null },
				}),
			).toBe(0);
		});

		it("a repeat dispatcher delay on a Delayed visit is a 200 no-op", async () => {
			const { orgId, clientId, a } = await seedOrg("redelay");
			const job = await seedJob(orgId, clientId, "redelay");
			const visit = await db.job_visit.create({
				data: {
					job_id: job.id,
					name: "Visit",
					status: "Delayed",
					arrival_constraint: "anytime",
					finish_constraint: "when_done",
					scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
					scheduled_end_at: new Date("2027-03-01T16:00:00Z"),
				},
			});
			await db.job_visit_technician.create({
				data: {
					visit_id: visit.id,
					tech_id: a.id,
					tech_status: "Assigned",
				},
			});
			const before = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});

			vi.mocked(ctx.getUserContext).mockReturnValue({
				dispatcherId: "d-1",
			});
			const http = await harness.callRoute(router, "post", "/:id/delay", {
				user: { organization_id: orgId },
				params: { id: visit.id },
			});
			expect(http.status).toBe(200);
			expect(http.body.success).toBe(true);

			const after = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(after.status).toBe("Delayed");
			expect(after.updated_at.getTime()).toBe(
				before.updated_at.getTime(),
			);
			expect(
				await db.log.count({
					where: { organization_id: orgId, entity_id: visit.id },
				}),
			).toBe(0);
		});

		it("deleting the last open visit re-derives the job: Completed, actual_total, job post-commit", async () => {
			const { orgId, clientId, a } = await seedOrg("delete");
			const job = await seedJob(orgId, clientId, "delete");
			const done = await db.job_visit.create({
				data: {
					job_id: job.id,
					name: "Done",
					status: "Completed",
					total: 250,
					arrival_constraint: "anytime",
					finish_constraint: "when_done",
					scheduled_start_at: new Date("2027-02-01T15:00:00Z"),
					scheduled_end_at: new Date("2027-02-01T16:00:00Z"),
				},
			});
			const open = await seedVisit(job.id, "Scheduled", [
				{ id: a.id, status: "Assigned" },
			]);
			const comms =
				await import("../../services/customerComms/visitEvents.js");
			vi.mocked(sockets.emitToOrg).mockClear();
			vi.mocked(comms.notifyJobCompleted).mockClear();

			const res = await ctl.deleteJobVisit(open.id, orgId, {
				dispatcherId: "d-1",
			});
			expect(res.err).toBe("");

			const after = await db.job.findUniqueOrThrow({
				where: { id: job.id },
			});
			expect(after.status).toBe("Completed");
			expect(after.completed_at).not.toBeNull();
			expect(Number(after.actual_total)).toBe(250);
			expect(
				vi
					.mocked(sockets.emitToOrg)
					.mock.calls.some(
						([, ev, p]) =>
							ev === "job:updated" &&
							(p as { jobId: string }).jobId === job.id,
					),
			).toBe(true);
			expect(comms.notifyJobCompleted).toHaveBeenCalledWith(
				job.id,
				orgId,
			);
			expect(
				await db.job_visit.count({ where: { id: done.id } }),
			).toBe(1);
		});

		it("a second complete is refused with WRONG_STATE (409), not a 200 no-op", async () => {
			const { orgId, clientId, a } = await seedOrg("twice");
			const job = await seedJob(orgId, clientId, "twice");
			const visit = await seedVisit(job.id, "InProgress", [
				{ id: a.id, status: "OnSite" },
			]);
			const first = await ctl.applyVisitTransition(
				visit.id,
				"complete",
				orgId,
				{ techId: a.id },
			);
			expect(first.err).toBe("");

			vi.mocked(ctx.getUserContext).mockReturnValue({ techId: a.id });
			const http = await harness.callRoute(router, "post", "/:id/complete", {
				user: { organization_id: orgId },
				params: { id: visit.id },
			});
			expect(http.status).toBe(409);
		});

		it("a tech's drive on a Completed visit is WRONG_STATE and leaves the tech alone", async () => {
			const { orgId, clientId, a } = await seedOrg("closeddrive");
			const job = await seedJob(orgId, clientId, "closeddrive");
			const visit = await seedVisit(job.id, "Scheduled", [
				{ id: a.id, status: "Assigned" },
			]);
			await db.job_visit.update({
				where: { id: visit.id },
				data: { status: "Completed" },
			});

			const res = await ctl.applyVisitTransition(visit.id, "drive", orgId, {
				techId: a.id,
			});
			expect(res).toEqual(expect.objectContaining({ code: "WRONG_STATE" }));
			const row = await db.job_visit_technician.findUniqueOrThrow({
				where: {
					visit_id_tech_id: { visit_id: visit.id, tech_id: a.id },
				},
			});
			expect(row.tech_status).toBe("Assigned");
			expect(
				(await db.technician.findUniqueOrThrow({ where: { id: a.id } }))
					.status,
			).toBe("Available");
		});
	},
);
