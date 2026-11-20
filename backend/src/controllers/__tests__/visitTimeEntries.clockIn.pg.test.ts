import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the one-open-entry rule holds only under the technician row
// lock and the in-tx re-check. Scratch/CI database only.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
    if (process.env.QUOTA_TEST_DATABASE_URL)
        process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

// isWeekLocked runs after the unlocked pre-check and before the tx: the
// window a double tap slips through.
const gate = vi.hoisted(() => ({
    hook: null as null | ((call: number) => Promise<void>),
    calls: 0,
}));
vi.mock("../timesheetController.js", async (importOriginal) => {
    const real =
        await importOriginal<typeof import("../timesheetController.js")>();
    return {
        ...real,
        isWeekLocked: vi.fn(async () => {
            const call = ++gate.calls;
            if (gate.hook) await gate.hook(call);
            return false;
        }),
    };
});
vi.mock("../../services/entitlementService.js", () => ({
    isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../services/socketService.js", () => ({
    getSocket: vi.fn().mockReturnValue(null),
    emitToOrg: vi.fn(),
}));
vi.mock("../../services/wrappingUpTimer.js", () => ({
    scheduleWrappingUpClear: vi.fn(),
    cancelWrappingUpTimer: vi.fn(),
}));
vi.mock("../notificationsController.js", () => ({
    createNotification: vi.fn().mockResolvedValue(undefined),
    notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/followupTriggers.js", () => ({
    onVisitScheduled: vi.fn(),
    onVisitRescheduled: vi.fn(),
    onVisitCancelled: vi.fn(),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
    fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
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

describe.runIf(DB_URL)("clockInVisit against Postgres", () => {
    let db: typeof import("../../db.js").db;
    let ctl: typeof import("../visitTimeEntriesController.js");
    const orgIds: string[] = [];
    const dispatcherIds: string[] = [];

    beforeAll(async () => {
        ({ db } = await import("../../db.js"));
        ctl = await import("../visitTimeEntriesController.js");
    }, 60_000);

    afterAll(async () => {
        if (!orgIds.length) return;
        const mine = { organization_id: { in: orgIds } };
        await db.log.deleteMany({ where: mine });
        await db.visit_tech_time_entry.deleteMany({
            where: { visit: { job: mine } },
        });
        await db.job_visit_technician.deleteMany({
            where: { visit: { job: mine } },
        });
        await db.job_visit.deleteMany({ where: { job: mine } });
        await db.job.deleteMany({ where: mine });
        await db.client.deleteMany({ where: mine });
        await db.technician.deleteMany({ where: mine });
        await db.dispatcher.deleteMany({ where: { id: { in: dispatcherIds } } });
        await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    async function seed(label: string) {
        const org = await db.organization.create({
            data: { name: `PG clock-in ${label}` },
        });
        orgIds.push(org.id);
        const tech = await db.technician.create({
            data: {
                organization_id: org.id,
                name: "Ana",
                email: `${label}-${org.id}@clockin.test`,
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
        const visit = async () => {
            const v = await db.job_visit.create({
                data: {
                    job_id: job.id,
                    name: "Visit",
                    status: "InProgress",
                    arrival_constraint: "anytime",
                    finish_constraint: "when_done",
                    scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
                    scheduled_end_at: new Date("2027-03-01T16:00:00Z"),
                },
            });
            await db.job_visit_technician.create({
                data: { visit_id: v.id, tech_id: tech.id, tech_status: "OnSite" },
            });
            return v;
        };
        return { orgId: org.id, techId: tech.id, visit };
    }

    /**
     * B passes the unlocked pre-check while A is between its own pre-check
     * and its tx; B's tx only starts once A has committed.
     */
    async function doubleTap(
        first: () => ReturnType<typeof ctl.clockInVisit>,
        second: () => ReturnType<typeof ctl.clockInVisit>,
    ) {
        gate.calls = 0;
        let bAtGate!: () => void;
        const bReady = new Promise<void>((r) => (bAtGate = r));
        let aDone!: () => void;
        const aFinished = new Promise<void>((r) => (aDone = r));
        let b!: ReturnType<typeof ctl.clockInVisit>;
        gate.hook = async (call) => {
            if (call === 1) {
                b = second();
                await bReady;
            } else {
                bAtGate();
                await aFinished;
            }
        };
        try {
            const a = await first();
            aDone();
            return [a, await b] as const;
        } finally {
            gate.hook = null;
        }
    }

    it("a double tap on one visit opens one entry; the second gets ALREADY_CLOCKED_IN", async () => {
        const { orgId, techId, visit } = await seed("same");
        const v = await visit();
        const ctx = { techId };

        const [a, b] = await doubleTap(
            () => ctl.clockInVisit(v.id, techId, orgId, ctx),
            () => ctl.clockInVisit(v.id, techId, orgId, ctx),
        );

        expect(a.err).toBe("");
        expect(b.err).toBe(`ALREADY_CLOCKED_IN:${v.id}`);
        expect(
            await db.visit_tech_time_entry.count({
                where: { tech_id: techId, clocked_out_at: null },
            }),
        ).toBe(1);
    });

    it("clocking into two visits at once opens one entry", async () => {
        const { orgId, techId, visit } = await seed("cross");
        const v1 = await visit();
        const v2 = await visit();
        const ctx = { techId };

        const [a, b] = await doubleTap(
            () => ctl.clockInVisit(v1.id, techId, orgId, ctx),
            () => ctl.clockInVisit(v2.id, techId, orgId, ctx),
        );

        expect(a.err).toBe("");
        expect(b.err).toBe(`ALREADY_CLOCKED_IN:${v1.id}`);
        expect(
            await db.visit_tech_time_entry.count({
                where: { tech_id: techId, clocked_out_at: null },
            }),
        ).toBe(1);
    });

    it("a dispatcher clocking a tech in is the audit actor; the tech rides in changes", async () => {
        const { orgId, techId, visit } = await seed("audit");
        const v = await visit();
        const dispatcher = await db.dispatcher.create({
            data: {
                organization_id: orgId,
                name: "Dee",
                email: `audit-${orgId}@clockin.test`,
                password: "x",
                title: "Dispatcher",
                description: "",
            },
        });
        dispatcherIds.push(dispatcher.id);

        const res = await ctl.clockInVisit(v.id, techId, orgId, {
            dispatcherId: dispatcher.id,
        });
        expect(res.err).toBe("");
        const out = await ctl.clockOutVisit(v.id, techId, orgId, {
            dispatcherId: dispatcher.id,
        });
        expect(out.err).toBe("");

        const rows = await db.log.findMany({
            where: {
                organization_id: orgId,
                event_type: {
                    in: [
                        "visit_time_entry.clocked_in",
                        "visit_time_entry.clocked_out",
                    ],
                },
            },
        });
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.actor_type).toBe("dispatcher");
            expect(row.actor_id).toBe(dispatcher.id);
            expect((row.changes as Record<string, { new: unknown }>).tech_id.new).toBe(
                techId,
            );
        }
    });
});
