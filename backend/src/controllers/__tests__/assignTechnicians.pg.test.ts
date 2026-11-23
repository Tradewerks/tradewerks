import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: tech_status survival and concurrent adds are row-level facts
// a fake client can't show. Scratch/CI database only, never dev.
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
    notifyVisitCompleted: vi.fn(async () => undefined),
    notifyTechOnTheWay: vi.fn(async () => undefined),
}));

describe.runIf(DB_URL)("technician assignment diff against Postgres", () => {
    let db: typeof import("../../db.js").db;
    let ctl: typeof import("../jobVisitsController.js");
    const orgIds: string[] = [];
    const dispatcher = { dispatcherId: undefined };

    beforeAll(async () => {
        ({ db } = await import("../../db.js"));
        ctl = await import("../jobVisitsController.js");
    });

    afterAll(async () => {
        if (!orgIds.length) return;
        const mine = { organization_id: { in: orgIds } };
        await db.log.deleteMany({ where: mine });
        await db.visit_tech_time_entry.deleteMany({ where: { visit: { job: mine } } });
        await db.job_visit.deleteMany({ where: { job: mine } });
        await db.job.deleteMany({ where: mine });
        await db.client.deleteMany({ where: mine });
        await db.technician.deleteMany({ where: mine });
        await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    async function seed(label: string, visitStatus: "Scheduled" | "InProgress" = "Scheduled") {
        const org = await db.organization.create({ data: { name: `PG assign ${label}` } });
        orgIds.push(org.id);
        const tech = (name: string) =>
            db.technician.create({
                data: {
                    organization_id: org.id,
                    name,
                    email: `${label}-${name}-${org.id}@assign.test`,
                    phone: "555-0100",
                    password: "x",
                    title: "Tech",
                    description: "",
                    hire_date: new Date("2025-01-01"),
                },
            });
        const [a, b, c] = await Promise.all([tech("Ana"), tech("Ben"), tech("Cy")]);
        const client = await db.client.create({
            data: { organization_id: org.id, name: `Client ${label}`, address: "1 Main St", coords: {} },
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
                status: visitStatus === "InProgress" ? "InProgress" : "Scheduled",
            },
        });
        const visit = await db.job_visit.create({
            data: {
                job_id: job.id,
                name: "Visit",
                status: visitStatus,
                arrival_constraint: "anytime",
                finish_constraint: "when_done",
                scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
                scheduled_end_at: new Date("2027-03-01T16:00:00Z"),
            },
        });
        await db.job_visit_technician.create({
            data: { visit_id: visit.id, tech_id: a.id, tech_status: "OnSite" },
        });
        return { orgId: org.id, visitId: visit.id, a, b, c };
    }

    const statusOf = async (visitId: string, techId: string) =>
        (
            await db.job_visit_technician.findUnique({
                where: { visit_id_tech_id: { visit_id: visitId, tech_id: techId } },
            })
        )?.tech_status ?? null;

    it("adding a tech keeps the existing tech's OnSite tech_status", async () => {
        const { orgId, visitId, a, b } = await seed("keep");
        const res = await ctl.assignTechniciansToVisit(visitId, [a.id, b.id], orgId, dispatcher);
        expect(res.err).toBe("");
        expect(await statusOf(visitId, a.id)).toBe("OnSite");
        expect(await statusOf(visitId, b.id)).toBe("Assigned");
    });

    it("removing a tech deletes only that row", async () => {
        const { orgId, visitId, a, b } = await seed("remove");
        await db.job_visit_technician.create({
            data: { visit_id: visitId, tech_id: b.id, tech_status: "EnRoute" },
        });
        const res = await ctl.assignTechniciansToVisit(visitId, [a.id], orgId, dispatcher);
        expect(res.err).toBe("");
        expect(await statusOf(visitId, b.id)).toBeNull();
        expect(await statusOf(visitId, a.id)).toBe("OnSite");
    });

    it("removing a clocked-in tech is refused", async () => {
        const { orgId, visitId, a, b } = await seed("clocked");
        await db.job_visit_technician.create({
            data: { visit_id: visitId, tech_id: b.id, tech_status: "OnSite" },
        });
        await db.visit_tech_time_entry.create({
            data: { visit_id: visitId, tech_id: a.id, clocked_in_at: new Date() },
        });
        const res = await ctl.assignTechniciansToVisit(visitId, [b.id], orgId, dispatcher);
        expect(res).toMatchObject({
            err: "Ana is clocked in on this visit. Clock them out first.",
            code: "WRONG_STATE",
        });
        expect(await statusOf(visitId, a.id)).toBe("OnSite");
    });

    it("after adding a tech mid-visit, completing marks the OnSite tech Done", async () => {
        const { orgId, visitId, a, b } = await seed("complete", "InProgress");
        const add = await ctl.patchVisitTechnicians(visitId, { add: [b.id] }, orgId, dispatcher);
        expect(add.err).toBe("");
        const done = await ctl.applyVisitTransition(visitId, "complete", orgId, dispatcher);
        expect(done.err).toBe("");
        expect(await statusOf(visitId, a.id)).toBe("Done");
        // Never arrived, so completion leaves them Assigned.
        expect(await statusOf(visitId, b.id)).toBe("Assigned");
    });

    it("two concurrent removals of different techs from a 2-tech InProgress visit: exactly one succeeds", async () => {
        const { orgId, visitId, a, b } = await seed("lastrace", "InProgress");
        await db.job_visit_technician.create({
            data: { visit_id: visitId, tech_id: b.id, tech_status: "OnSite" },
        });
        const results = await Promise.all([
            ctl.patchVisitTechnicians(visitId, { remove: [a.id] }, orgId, dispatcher),
            ctl.patchVisitTechnicians(visitId, { remove: [b.id] }, orgId, dispatcher),
        ]);
        expect(results.filter((r) => r.err === "")).toHaveLength(1);
        expect(results.find((r) => r.err !== "")?.err).toBe(
            "Can't remove every technician while the visit is InProgress. Assign someone else first.",
        );
        expect(await db.job_visit_technician.count({ where: { visit_id: visitId } })).toBe(1);
    });

    it("concurrent identical adds log and notify once", async () => {
        const { orgId, visitId, b } = await seed("dupadd");
        const { createNotification } = await import("../notificationsController.js");
        vi.mocked(createNotification).mockClear();
        const results = await Promise.all([
            ctl.patchVisitTechnicians(visitId, { add: [b.id] }, orgId, dispatcher),
            ctl.patchVisitTechnicians(visitId, { add: [b.id] }, orgId, dispatcher),
        ]);
        expect(results.map((r) => r.err)).toEqual(["", ""]);
        const logs = await db.log.count({
            where: { organization_id: orgId, entity_id: visitId, event_type: "job_visit.technicians_assigned" },
        });
        expect(logs).toBe(1);
        expect(
            vi.mocked(createNotification).mock.calls.filter(([n]) => n.technicianId === b.id),
        ).toHaveLength(1);
    });

    it("a clock-in racing an unassign that commits first is refused, leaving no open entry", async () => {
        const { orgId, visitId, a } = await seed("clockrace", "InProgress");
        const { clockInVisit } = await import("../visitTimeEntriesController.js");
        let clockIn!: ReturnType<typeof clockInVisit>;
        await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM job_visit WHERE id = ${visitId} FOR NO KEY UPDATE`;
            await tx.job_visit_technician.delete({
                where: { visit_id_tech_id: { visit_id: visitId, tech_id: a.id } },
            });
            // Its pre-check still sees the uncommitted row; it then blocks on the visit lock.
            clockIn = clockInVisit(visitId, a.id, orgId, dispatcher);
            await new Promise((r) => setTimeout(r, 500));
        });
        expect(await clockIn).toEqual({ err: "Technician not assigned to this visit" });
        expect(
            await db.visit_tech_time_entry.count({ where: { visit_id: visitId, clocked_out_at: null } }),
        ).toBe(0);
    });

    it("an add whose unlocked pre-read still sees the tech is applied once a concurrent removal commits", async () => {
        const { orgId, visitId, a, b } = await seed("staleadd");
        await db.job_visit_technician.create({
            data: { visit_id: visitId, tech_id: b.id, tech_status: "Assigned" },
        });
        let readd!: ReturnType<typeof ctl.patchVisitTechnicians>;
        await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM job_visit WHERE id = ${visitId} FOR NO KEY UPDATE`;
            await tx.job_visit_technician.delete({
                where: { visit_id_tech_id: { visit_id: visitId, tech_id: b.id } },
            });
            // Its pre-read still sees B assigned; it then blocks on the visit lock.
            readd = ctl.patchVisitTechnicians(visitId, { add: [b.id] }, orgId, dispatcher);
            await new Promise((r) => setTimeout(r, 500));
        });
        expect((await readd).err).toBe("");
        expect(await statusOf(visitId, b.id)).toBe("Assigned");
        expect(await statusOf(visitId, a.id)).toBe("OnSite");
    });

    it("two dispatchers adding different techs to the same visit both land", async () => {
        const { orgId, visitId, a, b, c } = await seed("race");
        const [first, second] = await Promise.all([
            ctl.patchVisitTechnicians(visitId, { add: [b.id] }, orgId, dispatcher),
            ctl.patchVisitTechnicians(visitId, { add: [c.id] }, orgId, dispatcher),
        ]);
        expect(first.err).toBe("");
        expect(second.err).toBe("");
        const rows = await db.job_visit_technician.findMany({ where: { visit_id: visitId } });
        expect(rows.map((r) => r.tech_id).sort()).toEqual([a.id, b.id, c.id].sort());
        expect(await statusOf(visitId, a.id)).toBe("OnSite");
    });
});
