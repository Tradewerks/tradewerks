import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Real Postgres: the compare-and-set claim is the thing under test, and a fake client
// cannot race. CI sets QUOTA_TEST_DATABASE_URL after `prisma migrate deploy`. Never the
// dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

const mockRun = vi.fn(async (..._a: unknown[]) => {
	await new Promise((r) => setTimeout(r, 20));
});
vi.mock("../../controllers/fieldPurchasesController.js", () => ({
	READ_STALLED: "stalled",
	runReceiptOcr: (...a: unknown[]) => mockRun(...a),
}));
vi.mock("../wasabiService.js", () => ({
	getBuffer: vi.fn(async () => ({ buffer: Buffer.from("img"), contentType: "image/jpeg" })),
}));
vi.mock("../socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../receiptOcr/index.js", async () => {
	const normalize = await import("../receiptOcr/normalize.js");
	return { ...normalize, getReceiptOcrProvider: () => ({ name: "fixture", extract: vi.fn() }) };
});

describe.runIf(DB_URL)("receipt OCR sweeper against Postgres", () => {
	let db: typeof import("../../db.js").db;
	let sweep: typeof import("../receiptOcrSweeper.js").sweepStalledReads;
	let orgId = "";
	let techId = "";
	const ids: string[] = [];

	beforeAll(async () => {
		({ db } = await import("../../db.js"));
		({ sweepStalledReads: sweep } = await import("../receiptOcrSweeper.js"));
		const org = await db.organization.create({ data: { name: "PG OCR sweep" } });
		orgId = org.id;
		const tech = await db.technician.create({
			data: {
				organization_id: orgId,
				name: "PG Tech",
				email: `pg-ocr-${Date.now()}@t.test`,
				phone: "0",
				password: "x",
				title: "t",
				description: "d",
				hire_date: new Date(),
			},
		});
		techId = tech.id;
		const longAgo = new Date(Date.now() - 10 * 60_000);
		for (let i = 0; i < 6; i++) {
			const row = await db.field_purchase.create({
				data: {
					organization_id: orgId,
					technician_id: techId,
					receipt_image_url: `https://bucket/receipts/${i}.jpg`,
					receipt_image_hash: `pg-ocr-hash-${i}-${Date.now()}`,
					ocr_status: "pending",
					ocr_started_at: longAgo,
					ocr_attempts: 1,
				},
			});
			ids.push(row.id);
		}
	});

	afterAll(async () => {
		if (!orgId) return;
		await db.field_purchase.deleteMany({ where: { id: { in: ids } } });
		await db.technician.deleteMany({ where: { id: techId } });
		await db.organization.deleteMany({ where: { id: orgId } });
	});

	it("two sweepers racing claim each stale read exactly once", async () => {
		const now = new Date();
		const [a, b] = await Promise.all([sweep(now), sweep(now)]);
		expect(a + b).toBe(ids.length);

		const runs = mockRun.mock.calls.map((c) => c[1] as string).filter((id) => ids.includes(id));
		expect(runs.sort()).toEqual([...ids].sort());

		const rows = await db.field_purchase.findMany({
			where: { id: { in: ids } },
			select: { ocr_attempts: true },
		});
		expect(rows.every((r) => r.ocr_attempts === 2)).toBe(true);
	});
});
