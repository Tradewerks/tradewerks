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
	"restore and visit-add re-derive the job",
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
				data: { name: `PG restore ${label}` },
			});
			orgIds.push(org.id);
			const tech = (name: string) =>
				db.technician.create({
					data: {
						organization_id: org.id,
						name,
						email: `${label}-${name}-${org.id}@restore.test`,
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
			opts: { planId?: string; status?: "Scheduled" | "InProgress" | "Completed" | "Cancelled" } = {},
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
					...(opts.status === "Completed" ? { completed_at: new Date("2027-02-01T00:00:00Z") } : {}),
					...(opts.status === "Cancelled"
						? { cancelled_at: new Date("2027-02-01T00:00:00Z"), cancellation_reason: "Customer called" }
						: {}),
					...(opts.planId ? { recurring_plan_id: opts.planId } : {}),
				},
			});

		async function seedVisit(
			jobId: string,
			status: "Scheduled" | "Driving" | "InProgress" | "Completed" | "Cancelled",
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

		const newVisitReq = (jobId: string) =>
			({
				body: {
					job_id: jobId,
					name: "Follow-up",
					arrival_constraint: "anytime",
					finish_constraint: "when_done",
					scheduled_start_at: "2027-04-01T15:00:00Z",
					scheduled_end_at: "2027-04-01T16:00:00Z",
				},
			}) as never;

		it("restore moves a Cancelled visit to Scheduled and the job off Cancelled", async () => {
			const { orgId, clientId, a } = await seedOrg("restore");
			const job = await seedJob(orgId, clientId, "restore", { status: "Cancelled" });
			const visit = await seedVisit(job.id, "Cancelled", [{ id: a.id, status: "Assigned" }]);
			await db.job_visit.update({
				where: { id: visit.id },
				data: { cancellation_reason: "Customer called" },
			});
			const comms = await import("../../services/customerComms/visitEvents.js");
			vi.mocked(comms.notifyVisitRescheduled).mockClear();
			vi.mocked(sockets.emitToOrg).mockClear();

			vi.mocked(ctx.getUserContext).mockReturnValue({ dispatcherId: "d-1" });
			const http = await harness.callRoute(router, "post", "/:id/transition", {
				user: { organization_id: orgId, role: "dispatcher" },
				params: { id: visit.id },
				body: { action: "restore" },
			});
			expect(http.status).toBe(200);

			const [v, j, row] = await Promise.all([
				db.job_visit.findUniqueOrThrow({ where: { id: visit.id } }),
				db.job.findUniqueOrThrow({ where: { id: job.id } }),
				db.job_visit_technician.findUniqueOrThrow({
					where: { visit_id_tech_id: { visit_id: visit.id, tech_id: a.id } },
				}),
			]);
			expect(v.status).toBe("Scheduled");
			expect(v.cancellation_reason).toBeNull();
			expect(row.tech_status).toBe("Assigned");
			expect(j.status).toBe("Scheduled");
			expect(j.cancelled_at).toBeNull();
			expect(j.cancellation_reason).toBeNull();
			expect(comms.notifyVisitRescheduled).toHaveBeenCalledTimes(1);
			expect(
				vi.mocked(sockets.emitToOrg).mock.calls.filter(([, ev]) => ev === "job:updated"),
			).toHaveLength(1);
			const jobLog = await db.log.findMany({
				where: { organization_id: orgId, entity_id: job.id, event_type: "job.updated" },
			});
			expect(jobLog).toHaveLength(1);
			expect((jobLog[0].changes as any).cancelled_at).toBeDefined();
		});

		it("a technician calling restore gets 403", async () => {
			const { orgId, clientId, a } = await seedOrg("restoretech");
			const job = await seedJob(orgId, clientId, "restoretech", { status: "Cancelled" });
			const visit = await seedVisit(job.id, "Cancelled", [{ id: a.id, status: "Assigned" }]);
			vi.mocked(ctx.getUserContext).mockReturnValue({ techId: a.id });
			const http = await harness.callRoute(router, "post", "/:id/transition", {
				user: { organization_id: orgId, role: "technician" },
				params: { id: visit.id },
				body: { action: "restore" },
			});
			expect(http.status).toBe(403);
			expect(
				(await db.job_visit.findUniqueOrThrow({ where: { id: visit.id } })).status,
			).toBe("Cancelled");
		});

		it("adding a visit to a Completed job makes it InProgress and clears completed_at", async () => {
			const { orgId, clientId } = await seedOrg("reopen");
			const job = await seedJob(orgId, clientId, "reopen", { status: "Completed" });
			await seedVisit(job.id, "Completed", []);
			vi.mocked(sockets.emitToOrg).mockClear();

			const res = await ctl.insertJobVisit(newVisitReq(job.id), orgId, { dispatcherId: "d-1" });
			expect(res.err).toBe("");
			const j = await db.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(j.status).toBe("InProgress");
			expect(j.completed_at).toBeNull();
			expect(
				vi.mocked(sockets.emitToOrg).mock.calls.filter(([, ev]) => ev === "job:updated"),
			).toHaveLength(1);
			const log = await db.log.findMany({
				where: { organization_id: orgId, entity_id: job.id, event_type: "job.updated" },
			});
			expect(log).toHaveLength(1);
			expect(log[0].changes).toMatchObject({ completed_at: {} });
		});

		it("adding a visit to a Cancelled job makes it Scheduled and clears cancelled_at", async () => {
			const { orgId, clientId } = await seedOrg("reopencx");
			const job = await seedJob(orgId, clientId, "reopencx", { status: "Cancelled" });
			await seedVisit(job.id, "Cancelled", []);

			const res = await ctl.insertJobVisit(newVisitReq(job.id), orgId, { dispatcherId: "d-1" });
			expect(res.err).toBe("");
			const j = await db.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(j.status).toBe("Scheduled");
			expect(j.cancelled_at).toBeNull();
			expect(j.cancellation_reason).toBeNull();
		});

		it("adding a visit to an Unscheduled job still makes it Scheduled", async () => {
			const { orgId, clientId } = await seedOrg("unsched");
			const job = await db.job.create({
				data: {
					organization_id: orgId,
					client_id: clientId,
					job_number: `J-un-${Math.random().toString(36).slice(2, 8)}`,
					name: "x",
					description: "x",
					address: "1 Main St",
					coords: {},
					status: "Unscheduled",
				},
			});
			const res = await ctl.insertJobVisit(newVisitReq(job.id), orgId, { dispatcherId: "d-1" });
			expect(res.err).toBe("");
			expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("Scheduled");
		});
	},
);
