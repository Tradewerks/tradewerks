import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the unit test mocks the scoped client, so it cannot show that
// the org scope really hides another org's plan. CI sets QUOTA_TEST_DATABASE_URL
// after `prisma migrate deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
    if (process.env.QUOTA_TEST_DATABASE_URL)
        process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

vi.mock("../../services/entitlementService.js", () => ({
    isModuleOn: vi.fn(async () => true),
}));

describe.runIf(DB_URL)("job create recurring_plan_id scope against Postgres", () => {
    let db: typeof import("../../db.js").db;
    let insertJob: typeof import("../jobsController.js").insertJob;
    const orgIds: string[] = [];

    async function seedOrg(label: string, withPlan: boolean) {
        const org = await db.organization.create({
            data: { name: `PG job plan scope ${label}` },
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
        const plan = withPlan
            ? await db.recurring_plan.create({
                  data: {
                      organization_id: org.id,
                      client_id: client.id,
                      name: `Plan ${label}`,
                      description: "Seasonal tune-up",
                      address: "1 Main St",
                      starts_at: new Date("2027-01-01T00:00:00Z"),
                  },
              })
            : null;
        return { orgId: org.id, clientId: client.id, planId: plan?.id };
    }

    const create = (orgId: string, clientId: string, planId: string) =>
        insertJob({
            body: {
                client_id: clientId,
                name: "Maintenance",
                description: "Seasonal tune-up",
                address: "1 Main St",
                coords: { lat: 30.2, lon: -97.7 },
                recurring_plan_id: planId,
            },
            user: { organization_id: orgId },
        } as unknown as import("express").Request);

    beforeAll(async () => {
        ({ db } = await import("../../db.js"));
        ({ insertJob } = await import("../jobsController.js"));
    });

    afterAll(async () => {
        if (!orgIds.length) return;
        const mine = { organization_id: { in: orgIds } };
        await db.log.deleteMany({ where: mine });
        await db.job.deleteMany({ where: mine });
        await db.recurring_plan.deleteMany({ where: mine });
        await db.client.deleteMany({ where: mine });
        await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    it("org B cannot attach org A's recurring plan to a new job", async () => {
        const a = await seedOrg("a1", true);
        const b = await seedOrg("b1", false);

        const result = await create(b.orgId, b.clientId, a.planId!);

        expect(result.err).toBe("Recurring plan not found");
        expect(result.item).toBeUndefined();
        expect(await db.job.count({ where: { recurring_plan_id: a.planId } })).toBe(0);
        expect(await db.job.count({ where: { organization_id: b.orgId } })).toBe(0);
    });

    it("org A can attach its own recurring plan", async () => {
        const a = await seedOrg("a2", true);

        const result = await create(a.orgId, a.clientId, a.planId!);

        expect(result.err).toBe("");
        expect(result.item?.recurring_plan_id).toBe(a.planId);
        const jobs = await db.job.findMany({ where: { recurring_plan_id: a.planId } });
        expect(jobs).toHaveLength(1);
        expect(jobs[0].organization_id).toBe(a.orgId);
    });
});
