import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the guard is a conditional UPDATE racing another one, which a
// fake client cannot reproduce. CI sets QUOTA_TEST_DATABASE_URL after `prisma
// migrate deploy`. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
	process.env.PUBLIC_LINK_SECRET ??= "pg-test-public-link-secret";
});

const h = vi.hoisted(() => ({ notifyDispatchers: vi.fn(async () => {}) }));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: h.notifyDispatchers,
}));

describe.runIf(DB_URL)("public quote response against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let respondToQuote: typeof import("../../controllers/quotesController.js").respondToQuote;
	const orgIds: string[] = [];

	async function seedQuote(label: string) {
		const org = await db.organization.create({
			data: { name: `PG public quote ${label}` },
		});
		orgIds.push(org.id);
		const client = await db.client.create({
			data: {
				organization_id: org.id,
				name: "Pat Client",
				address: "1 Main St",
				coords: {},
			},
		});
		const request = await db.request.create({
			data: {
				organization_id: org.id,
				client_id: client.id,
				title: "No heat",
				description: "",
				status: "Quoted",
			},
		});
		const quote = await db.quote.create({
			data: {
				organization_id: org.id,
				client_id: client.id,
				request_id: request.id,
				quote_number: `Q-${label}`,
				title: "Furnace",
				description: "",
				address: "1 Main St",
				subtotal: 100,
				total: 100,
				status: "Sent",
			},
		});
		return { orgId: org.id, requestId: request.id, quoteId: quote.id };
	}

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		({ respondToQuote } =
			await import("../../controllers/quotesController.js"));
	});

	afterAll(async () => {
		if (!orgIds.length) return;
		const mine = { organization_id: { in: orgIds } };
		await db.log.deleteMany({ where: mine });
		await db.public_link.deleteMany({ where: mine });
		await db.quote.deleteMany({ where: mine });
		await db.request.deleteMany({ where: mine });
		await db.client.deleteMany({ where: mine });
		await db.organization.deleteMany({ where: { id: { in: orgIds } } });
	});

	it("two simultaneous approves fire the notification and request-status change once", async () => {
		const { orgId, requestId, quoteId } = await seedQuote("race");
		h.notifyDispatchers.mockClear();

		const results = await Promise.all(
			["Ann Buyer", "Bob Buyer"].map((name) =>
				respondToQuote(orgId, quoteId, {
					action: "approve",
					name,
					ip: "203.0.113.1",
					userAgent: "UA",
				}),
			),
		);

		expect(results).toEqual([
			{ status: "Approved" },
			{ status: "Approved" },
		]);
		expect(h.notifyDispatchers).toHaveBeenCalledTimes(1);
		const requestLogs = await db.log.count({
			where: {
				entity_id: requestId,
				event_type: "request.quote_approved",
			},
		});
		expect(requestLogs).toBe(1);
		const quoteLogs = await db.log.count({
			where: { entity_id: quoteId, actor_type: "customer" },
		});
		expect(quoteLogs).toBe(1);
		const q = await db.quote.findUniqueOrThrow({
			where: { id: quoteId },
		});
		expect(q.status).toBe("Approved");
		expect(q.approved_via).toBe("customer_link");
		expect(["Ann Buyer", "Bob Buyer"]).toContain(q.approved_by_name);
		const r = await db.request.findUniqueOrThrow({
			where: { id: requestId },
		});
		expect(r.status).toBe("QuoteApproved");
	});

	it("a link for org A never resolves data from org B even if entity_id is edited in the DB to another org's quote", async () => {
		const { issueLink, resolveLink } =
			await import("../../lib/publicLink.js");
		const { buildPublicView } = await import("../publicViews.js");
		const a = await seedQuote("iso-a");
		const b = await seedQuote("iso-b");
		const { token } = await issueLink(a.orgId, {
			purpose: "quote",
			entityId: a.quoteId,
		});
		await db.public_link.updateMany({
			where: { organization_id: a.orgId },
			data: { entity_id: b.quoteId },
		});
		const link = await resolveLink(token);
		expect(link?.entity_id).toBe(b.quoteId);
		expect(await buildPublicView(link!, { markViewed: true })).toBeNull();
		expect(
			await respondToQuote(link!.organization_id, link!.entity_id, {
				action: "approve",
				name: "Mallory",
			}),
		).toBeNull();
		const bq = await db.quote.findUniqueOrThrow({
			where: { id: b.quoteId },
		});
		expect(bq.status).toBe("Sent");
		expect(bq.viewed_at).toBeNull();
	});
});
