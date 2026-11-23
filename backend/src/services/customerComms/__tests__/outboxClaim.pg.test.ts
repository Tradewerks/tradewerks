import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: FOR UPDATE SKIP LOCKED is the thing under test, and a fake client
// cannot race. CI sets QUOTA_TEST_DATABASE_URL after `prisma migrate deploy`. Never the
// dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

// Only the claim runs here; the provider is never reached.
vi.mock("../channels/index.js", () => ({
	getChannelAdapter: () => null,
	registeredChannels: () => [],
}));

describe.runIf(DB_URL)("customer message outbox claim against Postgres", () => {
	let db: typeof import("../../../db.js").db;
	let claimDue: typeof import("../outboxSweeper.js").claimDue;
	let orgId = "";
	const ROWS = 150;

	beforeAll(async () => {
		({ db } = await import("../../../db.js"));
		({ claimDue } = await import("../outboxSweeper.js"));
		const org = await db.organization.create({
			data: { name: "PG outbox claim" },
		});
		orgId = org.id;
		const past = new Date(Date.now() - 60_000);
		await db.customer_message.createMany({
			data: Array.from({ length: ROWS }, (_, i) => ({
				organization_id: orgId,
				event: "visit_reminder",
				channel: "email",
				recipient: `c${i}@x.test`,
				entity_type: "job_visit",
				entity_id: `v${i}`,
				dedupe_key: `visit_reminder:v${i}`,
				send_after: past,
			})),
		});
	});

	afterAll(async () => {
		if (!orgId) return;
		await db.customer_message.deleteMany({
			where: { organization_id: orgId },
		});
		await db.organization.deleteMany({ where: { id: orgId } });
	});

	it("two concurrent sweeps never claim the same row", async () => {
		const now = new Date();
		const mine = (rows: { id: string; organization_id: string }[]) =>
			rows.filter((r) => r.organization_id === orgId).map((r) => r.id);

		// Sweep A has locked its batch and not yet committed when sweep B runs.
		// B must neither wait for A nor take A's rows.
		let bIds: string[] = [];
		const aIds = await db.$transaction(async (tx) => {
			const locked = await tx.$queryRaw<{ id: string }[]>`
				SELECT "id" FROM "customer_message"
				WHERE "organization_id" = ${orgId} AND "status" = 'queued'
				ORDER BY "send_after", "id"
				LIMIT 50
				FOR UPDATE`;
			const ids = locked.map((r) => r.id);
			const b = await Promise.race([
				claimDue(now),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("sweep B blocked on A")),
						3000,
					),
				),
			]);
			bIds = mine(b);
			await tx.$executeRaw`
				UPDATE "customer_message"
				SET "status" = 'sending', "claimed_at" = ${now}, "attempts" = "attempts" + 1
				WHERE "id" = ANY(${ids})`;
			return ids;
		});

		expect(aIds).toHaveLength(50);
		// Other rows in a shared database may take some of B's batch of 100.
		expect(bIds.length).toBeGreaterThan(0);
		expect(bIds.some((id) => aIds.includes(id))).toBe(false);

		// Later sweeps drain the rest, and nothing is ever claimed twice.
		const claimed = [...aIds, ...bIds];
		for (let i = 0; i < 20 && claimed.length < ROWS; i++) {
			const more = mine(await claimDue(new Date()));
			if (!more.length) break;
			expect(more.some((id) => claimed.includes(id))).toBe(false);
			claimed.push(...more);
		}
		expect(claimed).toHaveLength(ROWS);
		expect(new Set(claimed).size).toBe(ROWS);

		const rows = await db.customer_message.findMany({
			where: { organization_id: orgId },
			select: { status: true, attempts: true },
		});
		expect(
			rows.every((r) => r.status === "sending" && r.attempts === 1),
		).toBe(true);
	});
});
