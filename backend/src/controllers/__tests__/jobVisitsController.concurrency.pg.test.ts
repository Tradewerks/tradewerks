import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the unit test's fake updateMany is a perfect CAS by
// construction, so it cannot show what the org-scoped updateMany compiles to
// under READ COMMITTED. CI sets QUOTA_TEST_DATABASE_URL after
// `prisma migrate deploy`. Never the dev database.
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

describe.runIf(DB_URL)("visit PUT optimistic concurrency against Postgres", () => {
    let db: typeof import("../../db.js").db;
    let updateJobVisit: typeof import("../jobVisitsController.js").updateJobVisit;
    const orgIds: string[] = [];
    const sql: string[] = [];

    beforeAll(async () => {
        // db.ts reuses globalThis.prisma when set, so a logging client seeded
        // here is the one the controller runs on.
        const { PrismaClient } = await import("../../../generated/prisma/client.js");
        const { PrismaPg } = await import("@prisma/adapter-pg");
        const logging = new PrismaClient({
            adapter: new PrismaPg({ connectionString: DB_URL! }),
            log: [{ emit: "event", level: "query" }],
        });
        logging.$on("query", (e: { query: string }) => sql.push(e.query));
        (globalThis as { prisma?: unknown }).prisma = logging;
        ({ db } = await import("../../db.js"));
        ({ updateJobVisit } = await import("../jobVisitsController.js"));
    });

    afterAll(async () => {
        if (!orgIds.length) return;
        const mine = { organization_id: { in: orgIds } };
        await db.log.deleteMany({ where: mine });
        await db.job_visit.deleteMany({ where: { job: mine } });
        await db.job.deleteMany({ where: mine });
        await db.client.deleteMany({ where: mine });
        await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    async function seedVisit(label: string) {
        const org = await db.organization.create({
            data: { name: `PG visit CAS ${label}` },
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
            },
        });
        const visit = await db.job_visit.create({
            data: {
                job_id: job.id,
                name: "Visit",
                arrival_constraint: "anytime",
                finish_constraint: "when_done",
                scheduled_start_at: new Date("2027-03-01T15:00:00Z"),
                scheduled_end_at: new Date("2027-03-01T16:00:00Z"),
            },
        });
        return { orgId: org.id, visitId: visit.id, token: visit.updated_at.toISOString() };
    }

    const put = (orgId: string, id: string, body: Record<string, unknown>) =>
        updateJobVisit(
            { params: { id }, body } as unknown as import("express").Request,
            orgId,
            { dispatcherId: undefined },
        );

    const at = (hour: number) => ({
        scheduled_start_at: `2027-03-02T${String(hour).padStart(2, "0")}:00:00.000Z`,
        scheduled_end_at: `2027-03-02T${String(hour + 1).padStart(2, "0")}:00:00.000Z`,
    });

    it("concurrent PUTs with the same expected_updated_at against Postgres: one saves, one 409", async () => {
        const { orgId, visitId, token } = await seedVisit("c1");
        sql.length = 0;

        const [a, b] = await Promise.all([
            put(orgId, visitId, { ...at(9), description: "from A", expected_updated_at: token }),
            put(orgId, visitId, { ...at(13), description: "from B", expected_updated_at: token }),
        ]);

        const updateSql = sql.filter((q) => /UPDATE\s+"public"\."job_visit"/i.test(q));
        console.info("[visit CAS SQL]\n" + [...new Set(updateSql)].join("\n"));

        const codes = [a, b].map((r) => ("code" in r ? r.code : "OK"));
        expect(codes.sort()).toEqual(["CONFLICT", "OK"]);
        const winner = "code" in a ? b : a;
        const winnerDesc = winner === a ? "from A" : "from B";
        const winnerStart = winner === a ? at(9) : at(13);

        const row = await db.job_visit.findUniqueOrThrow({ where: { id: visitId } });
        expect(row.description).toBe(winnerDesc);
        expect(row.scheduled_start_at.toISOString()).toBe(winnerStart.scheduled_start_at);
        const loser = "code" in a ? a : b;
        expect("current_updated_at" in loser && loser.current_updated_at).toBeTruthy();
    });

    it("a sequential save with a stale token is refused and leaves the row alone", async () => {
        const { orgId, visitId, token } = await seedVisit("s1");

        const first = await put(orgId, visitId, {
            ...at(9),
            description: "first",
            expected_updated_at: token,
        });
        expect(first.err).toBe("");

        const second = await put(orgId, visitId, {
            ...at(13),
            description: "stale",
            expected_updated_at: token,
        });
        expect("code" in second && second.code).toBe("CONFLICT");

        const row = await db.job_visit.findUniqueOrThrow({ where: { id: visitId } });
        expect(row.description).toBe("first");
        expect(row.scheduled_start_at.toISOString()).toBe(at(9).scheduled_start_at);
        expect("current_updated_at" in second && second.current_updated_at).toBe(
            row.updated_at.toISOString(),
        );
    });
});
