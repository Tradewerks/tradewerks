import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: PUT status, cancel and clock-in/out now run through the
// lifecycle service, whose guarantees are row locks. Scratch/CI database only.
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
	onVisitCancelled: vi.fn(async () => undefined),
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
}));
vi.mock("../../lib/context.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/context.js")>()),
	getUserContext: vi.fn(),
}));

type VisitStatus =
	"Scheduled" | "OnSite" | "InProgress" | "Completed" | "Cancelled";

describe.runIf(DB_URL)(
	"PUT status, cancel and clock-in/out through the lifecycle service",
	() => {
		let db: typeof import("../../db.js").db;
		let ctl: typeof import("../jobVisitsController.js");
		let timeCtl: typeof import("../visitTimeEntriesController.js");
		let router: typeof import("../../routes/jobVisits.js").default;
		let harness: typeof import("../../routes/__tests__/harness.js");
		let ctx: typeof import("../../lib/context.js");
		let comms: typeof import("../../services/customerComms/visitEvents.js");
		const orgIds: string[] = [];
		const dispatcher = { dispatcherId: "d-1" };

		beforeAll(async () => {
			({ db } = await import("../../db.js"));
			ctl = await import("../jobVisitsController.js");
			timeCtl = await import("../visitTimeEntriesController.js");
			router = (await import("../../routes/jobVisits.js")).default;
			harness = await import("../../routes/__tests__/harness.js");
			ctx = await import("../../lib/context.js");
			comms = await import("../../services/customerComms/visitEvents.js");
		}, 60_000);

		afterAll(async () => {
			if (!orgIds.length) return;
			const mine = { organization_id: { in: orgIds } };
			await db.log.deleteMany({ where: mine });
			await db.visit_tech_time_entry.deleteMany({
				where: { visit: { job: mine } },
			});
			await db.job_visit_line_item.deleteMany({
				where: { visit: { job: mine } },
			});
			await db.job_visit.deleteMany({ where: { job: mine } });
			await db.job.deleteMany({ where: mine });
			await db.client.deleteMany({ where: mine });
			await db.technician.deleteMany({ where: mine });
			await db.organization.deleteMany({ where: { id: { in: orgIds } } });
		});

		async function seedOrg(label: string) {
			const org = await db.organization.create({
				data: { name: `PG put-status ${label}` },
			});
			orgIds.push(org.id);
			const a = await db.technician.create({
				data: {
					organization_id: org.id,
					name: "Ana",
					email: `${label}-ana-${org.id}@putstatus.test`,
					phone: "555-0100",
					password: "x",
					title: "Tech",
					description: "",
					hire_date: new Date("2025-01-01"),
					hourly_rate: 60,
					status: "OnSite",
				},
			});
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
					job_number: `J-${label}-${Math.random().toString(36).slice(2, 8)}`,
					name: "Tune-up",
					description: "Seasonal",
					address: "1 Main St",
					coords: {},
					status: "InProgress",
				},
			});
			return { orgId: org.id, a, job };
		}

		async function seedVisit(
			jobId: string,
			status: VisitStatus,
			techId?: string,
			techStatus: "Assigned" | "OnSite" | "Done" = "OnSite",
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
			if (techId) {
				await db.job_visit_technician.create({
					data: {
						visit_id: visit.id,
						tech_id: techId,
						tech_status: techStatus,
					},
				});
			}
			return visit;
		}

		const put = (
			orgId: string,
			id: string,
			body: Record<string, unknown>,
		) =>
			ctl.updateJobVisit(
				{
					params: { id },
					body,
				} as unknown as import("express").Request,
				orgId,
				dispatcher,
			);

		it("PUT status Completed closes open time entries and sets tech Done", async () => {
			const { orgId, a, job } = await seedOrg("done");
			const visit = await seedVisit(job.id, "InProgress", a.id);
			const entry = await db.visit_tech_time_entry.create({
				data: {
					visit_id: visit.id,
					tech_id: a.id,
					clocked_in_at: new Date(Date.now() - 3600_000),
				},
			});

			const res = await put(orgId, visit.id, { status: "Completed" });
			expect(res.err).toBe("");

			const closed = await db.visit_tech_time_entry.findUniqueOrThrow({
				where: { id: entry.id },
			});
			expect(closed.clocked_out_at).not.toBeNull();
			expect(closed.line_item_id).not.toBeNull();
			const row = await db.job_visit_technician.findUniqueOrThrow({
				where: {
					visit_id_tech_id: { visit_id: visit.id, tech_id: a.id },
				},
			});
			expect(row.tech_status).toBe("Done");
			const after = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(after.status).toBe("Completed");
			expect(after.actual_end_at).not.toBeNull();
		});

		it("PUT status Cancelled on a Completed visit is 409 WRONG_STATE", async () => {
			const { orgId, a, job } = await seedOrg("cxl");
			const visit = await seedVisit(job.id, "Completed", a.id, "Done");

			const res = await put(orgId, visit.id, { status: "Cancelled" });
			expect(res).toMatchObject({
				err: "Can't move a visit from Completed to Cancelled.",
				code: "WRONG_STATE",
			});

			vi.mocked(ctx.getUserContext).mockReturnValue(dispatcher);
			const http = await harness.callRoute(router, "put", "/:id", {
				user: { organization_id: orgId },
				params: { id: visit.id },
				body: { status: "Cancelled" },
			});
			expect(http.status).toBe(409);
			expect(
				(
					await db.job_visit.findUniqueOrThrow({
						where: { id: visit.id },
					})
				).status,
			).toBe("Completed");
		});

		it("PUT with status unchanged and edited lines on a Completed visit succeeds and moves actual_total", async () => {
			const { orgId, a, job } = await seedOrg("lines");
			await db.job.update({
				where: { id: job.id },
				data: { status: "Completed" },
			});
			const visit = await seedVisit(job.id, "Completed", a.id, "Done");

			const res = await put(orgId, visit.id, {
				status: "Completed",
				line_items: [
					{
						name: "Filter",
						quantity: 2,
						unit_price: 50,
						sort_order: 0,
					},
				],
			});
			expect(res.err).toBe("");

			const v = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(Number(v.total)).toBeGreaterThan(0);
			const j = await db.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(Number(j.actual_total)).toBe(Number(v.total));
			expect(j.status).toBe("Completed");
		});

		it("cancel route on a Completed visit is 409", async () => {
			const { orgId, a, job } = await seedOrg("cxlroute");
			const visit = await seedVisit(job.id, "Completed", a.id, "Done");

			vi.mocked(ctx.getUserContext).mockReturnValue(dispatcher);
			const http = await harness.callRoute(
				router,
				"post",
				"/:id/cancel",
				{
					user: { organization_id: orgId },
					params: { id: visit.id },
					body: { cancellation_reason: "no longer needed" },
				},
			);
			expect(http.status).toBe(409);
			const after = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(after.status).toBe("Completed");
			expect(after.cancellation_reason).toBeNull();
		});

		it("clock-in on an OnSite visit advances to InProgress through the service and derives the job", async () => {
			const { orgId, a, job } = await seedOrg("clockin");
			await db.job.update({
				where: { id: job.id },
				data: { status: "Scheduled" },
			});
			const visit = await seedVisit(job.id, "OnSite", a.id);

			const res = await timeCtl.clockInVisit(visit.id, a.id, orgId, {
				techId: a.id,
			});
			expect(res.err).toBe("");

			const v = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(v.status).toBe("InProgress");
			expect(v.actual_start_at).not.toBeNull();
			const j = await db.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(j.status).toBe("InProgress");
			// The service's job derivation logs the job's own change.
			expect(
				await db.log.count({
					where: {
						organization_id: orgId,
						entity_id: job.id,
						event_type: "job.updated",
					},
				}),
			).toBe(1);
			const t = await db.technician.findUniqueOrThrow({
				where: { id: a.id },
			});
			expect(t.status).toBe("Working");
		});

		it("notifyJobCompleted fires once when the last visit is cancelled after another completed", async () => {
			const { orgId, a, job } = await seedOrg("lastcxl");
			await seedVisit(job.id, "Completed", a.id, "Done");
			const open = await seedVisit(job.id, "Scheduled", a.id, "Assigned");
			vi.mocked(comms.notifyJobCompleted).mockClear();
			vi.mocked(comms.notifyVisitCancelled).mockClear();

			const res = await ctl.cancelJobVisit(
				open.id,
				"customer asked",
				orgId,
				dispatcher,
			);
			expect(res.err).toBe("");

			expect(comms.notifyJobCompleted).toHaveBeenCalledTimes(1);
			expect(comms.notifyJobCompleted).toHaveBeenCalledWith(
				job.id,
				orgId,
			);
			expect(comms.notifyVisitCancelled).toHaveBeenCalledTimes(1);
			const j = await db.job.findUniqueOrThrow({ where: { id: job.id } });
			expect(j.status).toBe("Completed");
			expect(j.completed_at).not.toBeNull();
			const v = await db.job_visit.findUniqueOrThrow({
				where: { id: open.id },
			});
			expect(v.cancellation_reason).toBe("customer asked");
		});

		it("PUT restoring a cancelled visit to a new time sends one rescheduled notice", async () => {
			const { orgId, a, job } = await seedOrg("restore");
			const visit = await seedVisit(
				job.id,
				"Cancelled",
				a.id,
				"Assigned",
			);
			vi.mocked(comms.notifyVisitRescheduled).mockClear();

			const res = await put(orgId, visit.id, {
				status: "Scheduled",
				scheduled_start_at: "2027-03-02T15:00:00.000Z",
				scheduled_end_at: "2027-03-02T16:00:00.000Z",
			});
			expect(res.err).toBe("");
			expect(comms.notifyVisitRescheduled).toHaveBeenCalledTimes(1);
			const v = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(v.status).toBe("Scheduled");
			expect(v.scheduled_start_at.toISOString()).toBe(
				"2027-03-02T15:00:00.000Z",
			);
		});

		it("a stale form whose visit moved on is a CONFLICT, not a refused transition", async () => {
			const { orgId, a, job } = await seedOrg("stale");
			const visit = await seedVisit(job.id, "OnSite", a.id);
			const token = visit.updated_at.toISOString();
			// A tech clocks in meanwhile: OnSite -> InProgress.
			const clockIn = await timeCtl.clockInVisit(visit.id, a.id, orgId, {
				techId: a.id,
			});
			expect(clockIn.err).toBe("");
			const moved = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});

			const res = await put(orgId, visit.id, {
				status: "OnSite",
				description: "stale edit",
				expected_updated_at: token,
			});
			expect(res).toMatchObject({
				code: "CONFLICT",
				current_updated_at: moved.updated_at.toISOString(),
			});
			const after = await db.job_visit.findUniqueOrThrow({
				where: { id: visit.id },
			});
			expect(after.status).toBe("InProgress");
			expect(after.description).toBe(moved.description);
			expect(after.updated_at.getTime()).toBe(moved.updated_at.getTime());
		});

		it("PUT to Driving is refused: driving goes through the drive action", async () => {
			const { orgId, a, job } = await seedOrg("putdrive");
			const visit = await seedVisit(
				job.id,
				"Scheduled",
				a.id,
				"Assigned",
			);
			vi.mocked(comms.notifyTechOnTheWay).mockClear();

			const res = await put(orgId, visit.id, { status: "Driving" });
			expect(res).toMatchObject({
				err: "Use the drive action to start driving to a visit.",
				code: "WRONG_STATE",
			});
			expect(comms.notifyTechOnTheWay).not.toHaveBeenCalled();
			expect(
				(
					await db.job_visit.findUniqueOrThrow({
						where: { id: visit.id },
					})
				).status,
			).toBe("Scheduled");
		});

		it("clock-out racing a complete bills the entry exactly once", async () => {
			const { orgId, a, job } = await seedOrg("race");
			for (let i = 0; i < 6; i++) {
				const visit = await seedVisit(job.id, "InProgress", a.id);
				await db.technician.update({
					where: { id: a.id },
					data: { status: "Working" },
				});
				const entry = await db.visit_tech_time_entry.create({
					data: {
						visit_id: visit.id,
						tech_id: a.id,
						clocked_in_at: new Date(Date.now() - 3600_000),
					},
				});

				const [out, done] = await Promise.all([
					timeCtl.clockOutVisit(visit.id, a.id, orgId, {
						techId: a.id,
					}),
					ctl.applyVisitTransition(
						visit.id,
						"complete",
						orgId,
						dispatcher,
					),
				]);
				// The complete either wins, or loses the status race to the
				// clock-out's auto-pause and is refused; never an error.
				expect(
					done.err === "" ||
						("code" in done && done.code === "CONFLICT"),
				).toBe(true);
				expect(
					out.err === "" ||
						out.err ===
							"No active clock-in found for this technician on this visit",
				).toBe(true);

				expect(
					await db.job_visit_line_item.count({
						where: { visit_id: visit.id, item_type: "labor" },
					}),
				).toBe(1);
				const closed = await db.visit_tech_time_entry.findUniqueOrThrow(
					{
						where: { id: entry.id },
					},
				);
				expect(closed.clocked_out_at).not.toBeNull();
				expect(closed.line_item_id).not.toBeNull();
				expect(
					(
						await db.job_visit.findUniqueOrThrow({
							where: { id: visit.id },
						})
					).status,
				).toBe(done.err === "" ? "Completed" : "Paused");
			}
		});
	},
);
