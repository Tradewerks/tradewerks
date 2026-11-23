import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the guarantee is a conditional write that two concurrent
// conversions race on. Scratch/CI database only.
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

describe.runIf(DB_URL)("request to job conversion", () => {
    let db: typeof import("../../db.js").db;
    let ctl: typeof import("../jobsController.js");
    const orgIds: string[] = [];
    const dispatcher = { dispatcherId: "d-1" };

    beforeAll(async () => {
        ({ db } = await import("../../db.js"));
        ctl = await import("../jobsController.js");
    }, 60_000);

    afterAll(async () => {
        if (!orgIds.length) return;
        const mine = { organization_id: { in: orgIds } };
        await db.log.deleteMany({ where: mine });
        await db.job.deleteMany({ where: mine });
        await db.quote.deleteMany({ where: mine });
        await db.request.deleteMany({ where: mine });
        await db.client.deleteMany({ where: mine });
        await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    });

    async function seedRequest(
        label: string,
        status:
            | "New"
            | "Reviewing"
            | "Quoted"
            | "QuoteApproved"
            | "ConvertedToJob"
            | "Cancelled",
    ) {
        const org = await db.organization.create({
            data: { name: `PG req convert ${label}` },
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
        const request = await db.request.create({
            data: {
                organization_id: org.id,
                client_id: client.id,
                title: "No cooling",
                description: "Unit blowing warm air",
                address: "1 Main St",
                coords: { lat: 30.2, lon: -97.7 },
                status,
            },
        });
        return { orgId: org.id, clientId: client.id, request };
    }

    const seedQuote = (orgId: string, clientId: string, requestId: string) =>
        db.quote.create({
            data: {
                organization_id: orgId,
                client_id: clientId,
                request_id: requestId,
                quote_number: `Q-${Math.random().toString(36).slice(2, 8)}`,
                title: "Condenser",
                description: "Replace",
                address: "1 Main St",
                coords: { lat: 30.2, lon: -97.7 },
                status: "Approved",
                issued_at: new Date(),
                subtotal: 100,
                total: 100,
            },
        });

    const convertQuote = (orgId: string, clientId: string, quoteId: string) =>
        ctl.insertJob(
            {
                body: { client_id: clientId, quote_id: quoteId },
                user: { organization_id: orgId },
            } as never,
            dispatcher,
        );

    const convert = (orgId: string, clientId: string, requestId: string) =>
        ctl.insertJob(
            {
                body: { client_id: clientId, request_id: requestId },
                user: { organization_id: orgId },
            } as never,
            dispatcher,
        );

    it("two concurrent direct conversions of one request make one job", async () => {
        const { orgId, clientId, request } = await seedRequest(
            "race",
            "Reviewing",
        );

        const results = await Promise.all([
            convert(orgId, clientId, request.id),
            convert(orgId, clientId, request.id),
        ]);

        expect(results.filter((r) => !r.err)).toHaveLength(1);
        expect(results.filter((r) => r.err)).toHaveLength(1);
        expect(await db.job.count({ where: { request_id: request.id } })).toBe(
            1,
        );
        const r = await db.request.findUniqueOrThrow({
            where: { id: request.id },
        });
        expect(r.status).toBe("ConvertedToJob");
    });

    it("direct conversion of a ConvertedToJob request is refused", async () => {
        const { orgId, clientId, request } = await seedRequest(
            "done",
            "ConvertedToJob",
        );

        const res = await convert(orgId, clientId, request.id);

        expect(res.err).toMatch(/already converted/);
        expect(res.code).toBe("WRONG_STATE");
        expect(await db.job.count({ where: { request_id: request.id } })).toBe(
            0,
        );
    });

    it("refuses a request with an open quote and a cancelled request", async () => {
        const quoted = await seedRequest("quoted", "Quoted");
        const q = await convert(quoted.orgId, quoted.clientId, quoted.request.id);
        expect(q.err).toMatch(/open quote/);

        const cancelled = await seedRequest("cancelled", "Cancelled");
        const c = await convert(
            cancelled.orgId,
            cancelled.clientId,
            cancelled.request.id,
        );
        expect(c.err).toMatch(/cancelled/);
    });

    it("refuses another client's id on a direct conversion", async () => {
        const { orgId, request } = await seedRequest("client", "New");
        const other = await db.client.create({
            data: {
                organization_id: orgId,
                name: "Other",
                address: "2 Main St",
                coords: {},
            },
        });

        const res = await convert(orgId, other.id, request.id);

        expect(res.err).toMatch(/different client/);
        expect(await db.job.count({ where: { request_id: request.id } })).toBe(
            0,
        );
    });

    it("a QuoteApproved request converted directly refuses its quote afterwards", async () => {
        const { orgId, clientId, request } = await seedRequest(
            "twice",
            "QuoteApproved",
        );
        const quote = await seedQuote(orgId, clientId, request.id);

        const direct = await convert(orgId, clientId, request.id);
        expect(direct.err).toBe("");

        const viaQuote = await convertQuote(orgId, clientId, quote.id);
        expect(viaQuote.code).toBe("WRONG_STATE");
        expect(viaQuote.err).toBe("This request already has a job.");
        expect(await db.job.count({ where: { organization_id: orgId } })).toBe(
            1,
        );
        const q = await db.quote.findUniqueOrThrow({ where: { id: quote.id } });
        expect(q.status).toBe("Approved");
    });

    it("a quote conversion then a direct conversion makes one job", async () => {
        const { orgId, clientId, request } = await seedRequest(
            "quotefirst",
            "QuoteApproved",
        );
        const quote = await seedQuote(orgId, clientId, request.id);

        expect((await convertQuote(orgId, clientId, quote.id)).err).toBe("");
        const direct = await convert(orgId, clientId, request.id);

        expect(direct.code).toBe("WRONG_STATE");
        expect(direct.err).toMatch(/already converted/);
    });

    it("deleting the only job converted from a quote returns the request to QuoteApproved", async () => {
        const { orgId, clientId, request } = await seedRequest(
            "revertq",
            "QuoteApproved",
        );
        const quote = await seedQuote(orgId, clientId, request.id);
        const made = await convertQuote(orgId, clientId, quote.id);
        expect(made.err).toBe("");

        const res = await ctl.deleteJob(made.item!.id, orgId, dispatcher);

        expect(res.err).toBe("");
        const r = await db.request.findUniqueOrThrow({
            where: { id: request.id },
        });
        expect(r.status).toBe("QuoteApproved");
        expect(
            await db.log.count({
                where: {
                    organization_id: orgId,
                    entity_id: request.id,
                    event_type: "request.reverted",
                },
            }),
        ).toBe(1);
    });

    it("deleting the only job of a request returns the request to Reviewing", async () => {
        const { orgId, clientId, request } = await seedRequest(
            "revert",
            "Reviewing",
        );
        const made = await convert(orgId, clientId, request.id);
        expect(made.err).toBe("");

        const res = await ctl.deleteJob(made.item!.id, orgId, dispatcher);

        expect(res.err).toBe("");
        const r = await db.request.findUniqueOrThrow({
            where: { id: request.id },
        });
        expect(r.status).toBe("Reviewing");
        const logs = await db.log.findMany({
            where: {
                organization_id: orgId,
                entity_id: request.id,
                event_type: "request.reverted",
            },
        });
        expect(logs).toHaveLength(1);
    });
});
