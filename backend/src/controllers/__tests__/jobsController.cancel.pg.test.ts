import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Real Postgres: the cancel's guarantees are one transaction and row locks.
// Scratch/CI database only.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
    if (process.env.QUOTA_TEST_DATABASE_URL)
        process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

// Just before the service locks this visit, `during` runs on another
// connection (default: flip the visit to Completed so the cancel is refused).
const race = vi.hoisted(() => ({
    visitId: null as string | null,
    during: null as null | (() => Promise<unknown>),
}));

vi.mock("../../services/visitLifecycle/index.js", async (importOriginal) => {
    const real =
        await importOriginal<
            typeof import("../../services/visitLifecycle/index.js")
        >();
    const bound = (t: object, p: string | symbol) => {
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
    };
    return {
        ...real,
        applyStatusChange: vi.fn(
            async (
                tx: Parameters<typeof real.applyStatusChange>[0],
                args: Parameters<typeof real.applyStatusChange>[1],
            ) => {
                if (args.visitId !== race.visitId)
                    return real.applyStatusChange(tx, args);
                const { db } = await import("../../db.js");
                let fired = false;
                // The service's first raw query is its visit lock.
                const lockFirst = async (...q: unknown[]) => {
                    if (!fired) {
                        fired = true;
                        if (race.during) await race.during();
                        else
                            await db.job_visit.update({
                                where: { id: args.visitId },
                                data: { status: "Completed" },
                            });
                    }
                    return (
                        tx.$queryRaw as (...a: unknown[]) => Promise<unknown>
                    )(...q);
                };
                const racedTx = new Proxy(tx, {
                    get(t, p) {
                        return p === "$queryRaw" ? lockFirst : bound(t, p);
                    },
                });
                return real.applyStatusChange(racedTx, args);
            },
        ),
    };
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

type VisitStatus = "Scheduled" | "InProgress" | "Completed" | "Cancelled";

describe.runIf(DB_URL)("cancelJob", () => {
    let db: typeof import("../../db.js").db;
    let ctl: typeof import("../jobsController.js");
    let comms: typeof import("../../services/customerComms/visitEvents.js");
    const orgIds: string[] = [];
    const dispatcher = { dispatcherId: "d-1" };

    beforeAll(async () => {
        ({ db } = await import("../../db.js"));
        ctl = await import("../jobsController.js");
        comms = await import("../../services/customerComms/visitEvents.js");
    }, 60_000);

    beforeEach(() => {
        race.visitId = null;
        race.during = null;
        vi.mocked(comms.notifyVisitCancelled).mockClear();
        vi.mocked(comms.skipVisitReminders).mockClear();
        vi.mocked(comms.notifyJobCancelled).mockClear();
    });

    afterAll(async () => {
        if (!orgIds.length) return;
        const mine = { organization_id: { in: orgIds } };
        await db.log.deleteMany({ where: mine });
        await db.job_visit_technician.deleteMany({
            where: { visit: { job: mine } },
        });
        await db.job_visit.deleteMany({ where: { job: mine } });
        await db.job.deleteMany({ where: mine });
        await db.recurring_plan.deleteMany({ where: mine });
        await db.client.deleteMany({ where: mine });
        await db.technician.deleteMany({ where: mine });
        await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    async function seedJob(
        label: string,
        status: "Unscheduled" | "Scheduled" | "InProgress" | "Completed",
    ) {
        const org = await db.organization.create({
            data: { name: `PG job cancel ${label}` },
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
                job_number: `J-${label}-${Math.random().toString(36).slice(2, 8)}`,
                name: "Tune-up",
                description: "Seasonal",
                address: "1 Main St",
                coords: {},
                status,
                ...(status === "Completed" ? { completed_at: new Date() } : {}),
            },
        });
        return { orgId: org.id, clientId: client.id, job };
    }

    const seedVisit = (
        jobId: string,
        status: VisitStatus,
        start: string,
        total = 0,
    ) =>
        db.job_visit.create({
            data: {
                job_id: jobId,
                name: "Visit",
                status,
                total,
                arrival_constraint: "anytime",
                finish_constraint: "when_done",
                scheduled_start_at: new Date(start),
                scheduled_end_at: new Date(
                    new Date(start).getTime() + 3_600_000,
                ),
            },
        });

    it("cancels a job with no visits and stamps cancelled_at and the reason", async () => {
        const { orgId, job } = await seedJob("novisits", "Unscheduled");

        const res = await ctl.cancelJob(
            job.id,
            "Customer moved",
            orgId,
            dispatcher,
        );

        expect(res.err).toBe("");
        const j = await db.job.findUniqueOrThrow({ where: { id: job.id } });
        expect(j.status).toBe("Cancelled");
        expect(j.cancelled_at).not.toBeNull();
        expect(j.cancellation_reason).toBe("Customer moved");
        expect(comms.notifyVisitCancelled).not.toHaveBeenCalled();
        const logs = await db.log.findMany({
            where: {
                organization_id: orgId,
                entity_id: job.id,
                event_type: "job.cancelled",
            },
        });
        expect(logs).toHaveLength(1);
        expect((logs[0].changes as any).status).toEqual({
            old: "Unscheduled",
            new: "Cancelled",
        });

        const again = await ctl.cancelJob(job.id, "x", orgId, dispatcher);
        expect(again.code).toBe("WRONG_STATE");
        expect(again.err).toMatch(/already cancelled/);
    });

    it("cancels every open visit in one transaction; a refusal on one rolls back all", async () => {
        const { orgId, job } = await seedJob("rollback", "Scheduled");
        const first = await seedVisit(job.id, "Scheduled", "2099-03-01T15:00:00Z");
        const second = await seedVisit(job.id, "Scheduled", "2099-03-02T15:00:00Z");
        // Visits are cancelled in id order, so race the later id: the earlier
        // one is already written when the refusal lands.
        const [early, late] = [first, second].sort((a, b) =>
            a.id.localeCompare(b.id),
        );
        race.visitId = late.id;

        const res = await ctl.cancelJob(job.id, "Customer called", orgId, dispatcher);

        expect(res.code).toBe("WRONG_STATE");
        const [e, j] = await Promise.all([
            db.job_visit.findUniqueOrThrow({ where: { id: early.id } }),
            db.job.findUniqueOrThrow({ where: { id: job.id } }),
        ]);
        expect(e.status).toBe("Scheduled");
        expect(e.cancellation_reason).toBeNull();
        expect(j.status).toBe("Scheduled");
        expect(j.cancelled_at).toBeNull();
        expect(j.cancellation_reason).toBeNull();
        expect(comms.notifyVisitCancelled).not.toHaveBeenCalled();
        expect(comms.skipVisitReminders).not.toHaveBeenCalled();
        // The early visit's transition log rolled back with it.
        expect(
            await db.log.count({
                where: {
                    organization_id: orgId,
                    entity_id: { in: [early.id, job.id] },
                },
            }),
        ).toBe(0);
    });

    it("a visit added after the open-visit read rolls the cancel back with CONFLICT", async () => {
        const { orgId, job } = await seedJob("addrace", "InProgress");
        const open = await seedVisit(job.id, "Scheduled", "2099-03-01T15:00:00Z");
        let added: string | null = null;
        race.visitId = open.id;
        race.during = async () => {
            added = (await seedVisit(job.id, "Scheduled", "2099-03-05T15:00:00Z")).id;
        };

        const res = await ctl.cancelJob(job.id, "Customer called", orgId, dispatcher);

        expect(res).toMatchObject({
            code: "CONFLICT",
            err: "This job changed while you were saving. Reload and try again.",
        });
        expect(added).not.toBeNull();
        const [v, j] = await Promise.all([
            db.job_visit.findUniqueOrThrow({ where: { id: open.id } }),
            db.job.findUniqueOrThrow({ where: { id: job.id } }),
        ]);
        expect(v.status).toBe("Scheduled");
        expect(j.status).toBe("InProgress");
        expect(j.cancelled_at).toBeNull();
        expect(
            await db.log.count({
                where: { entity_id: job.id, event_type: "job.cancelled" },
            }),
        ).toBe(0);
    });

    it("job with a completed visit and an open visit ends Cancelled and keeps actual_total", async () => {
        const { orgId, job } = await seedJob("decision8", "InProgress");
        await seedVisit(job.id, "Completed", "2026-01-01T15:00:00Z", 250);
        const open = await seedVisit(job.id, "Scheduled", "2099-03-01T15:00:00Z", 400);

        const res = await ctl.cancelJob(job.id, "Customer moved", orgId, dispatcher);

        expect(res.err).toBe("");
        const [j, v] = await Promise.all([
            db.job.findUniqueOrThrow({ where: { id: job.id } }),
            db.job_visit.findUniqueOrThrow({ where: { id: open.id } }),
        ]);
        expect(v.status).toBe("Cancelled");
        expect(v.cancellation_reason).toBe("Customer moved");
        expect(j.status).toBe("Cancelled");
        expect(j.cancellation_reason).toBe("Customer moved");
        expect(Number(j.actual_total)).toBe(250);
    });

    it("queues one customer cancel notice, for the next upcoming visit", async () => {
        const { orgId, job } = await seedJob("notice", "Scheduled");
        const past = await seedVisit(job.id, "Scheduled", "2020-01-01T15:00:00Z");
        const later = await seedVisit(job.id, "Scheduled", "2099-05-01T15:00:00Z");
        const next = await seedVisit(job.id, "Scheduled", "2099-04-01T15:00:00Z");

        const res = await ctl.cancelJob(job.id, "Customer moved", orgId, dispatcher);

        expect(res.err).toBe("");
        expect(comms.notifyVisitCancelled).toHaveBeenCalledTimes(1);
        expect(comms.notifyVisitCancelled).toHaveBeenCalledWith(next.id, orgId);
        // Every cancelled visit's own queued reminders are dropped silently.
        const skipped = vi
            .mocked(comms.skipVisitReminders)
            .mock.calls.map(([id]) => id)
            .sort();
        expect(skipped).toEqual([past.id, later.id, next.id].sort());
        expect(comms.notifyJobCancelled).toHaveBeenCalledTimes(1);
        expect(comms.notifyJobCancelled).toHaveBeenCalledWith(job.id, orgId);
    });

    it("refuses a Completed job and a job whose recurring plan is active", async () => {
        const done = await seedJob("completed", "Completed");
        const res = await ctl.cancelJob(done.job.id, "x", done.orgId, dispatcher);
        expect(res).toMatchObject({
            code: "WRONG_STATE",
            err: "This job is complete. Cancel its invoice instead.",
        });

        const { orgId, clientId, job } = await seedJob("plan", "Scheduled");
        const plan = await db.recurring_plan.create({
            data: {
                organization_id: orgId,
                client_id: clientId,
                name: "Plan",
                description: "",
                address: "1 Main St",
                starts_at: new Date("2026-01-01T00:00:00Z"),
            },
        });
        await db.job.update({
            where: { id: job.id },
            data: { recurring_plan_id: plan.id },
        });
        const refused = await ctl.cancelJob(job.id, "x", orgId, dispatcher);
        expect(refused).toMatchObject({
            code: "WRONG_STATE",
            err: "Cancel the recurring plan instead.",
        });
        expect(
            (await db.job.findUniqueOrThrow({ where: { id: job.id } })).status,
        ).toBe("Scheduled");
    });

    it("404 for another org's job", async () => {
        const mine = await seedJob("own", "Scheduled");
        const theirs = await seedJob("theirs", "Scheduled");
        const res = await ctl.cancelJob(theirs.job.id, "x", mine.orgId, dispatcher);
        expect(res.code).toBe("NOT_FOUND");
    });
});
