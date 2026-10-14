import {
	describe,
	it,
	expect,
	vi,
	beforeAll,
	afterAll,
	beforeEach,
} from "vitest";

// Real Postgres: a row lock is the thing under test, a fake client cannot show it.
// CI sets QUOTA_TEST_DATABASE_URL after `prisma migrate deploy`; locally point it
// at a throwaway postgres:17 with migrations applied. Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

const limits: Record<string, number | null> = {};
vi.mock("../../../services/entitlementService.js", () => ({
	getEntitlements: vi.fn(async () => ({ limits })),
}));
const notify = vi.fn(async (..._a: unknown[]) => []);
vi.mock("../../../controllers/notificationsController.js", () => ({
	notifyDispatchers: (...a: unknown[]) => notify(...a),
}));

import { db } from "../../../db.js";
import { consumeQuota, getUsageSummary, periodStart } from "../quota.js";

describe("periodStart", () => {
	it("is the first of the UTC month", () => {
		expect(periodStart(new Date("2026-10-31T23:59:59.999Z"))).toBe(
			"2026-10-01",
		);
		expect(periodStart(new Date("2026-11-01T00:00:00.000Z"))).toBe(
			"2026-11-01",
		);
		expect(periodStart(new Date("2027-01-15T12:00:00Z"))).toBe(
			"2027-01-01",
		);
	});
});

describe.runIf(DB_URL)("consumeQuota against Postgres", () => {
	const org = `quota-test-${Date.now()}`;

	beforeAll(async () => {
		await db.usage_counter.deleteMany({
			where: { organization_id: { startsWith: "quota-test-" } },
		});
	});
	afterAll(async () => {
		await db.usage_counter.deleteMany({
			where: { organization_id: { startsWith: "quota-test-" } },
		});
		await db.$disconnect();
	});
	beforeEach(() => {
		notify.mockClear();
		for (const k of Object.keys(limits)) delete limits[k];
	});

	it("50 concurrent calls against a limit of 10 allow exactly 10", async () => {
		limits.ai_calls_month = 10;
		const o = `${org}-race`;
		const results = await Promise.all(
			Array.from({ length: 50 }, () => consumeQuota(o, "ai_calls_month")),
		);
		expect(results.filter((r) => r.allowed)).toHaveLength(10);
		const row = await db.usage_counter.findFirst({
			where: { organization_id: o },
		});
		expect(row?.count).toBe(10);
	});

	it("unlimited is always allowed and still counted", async () => {
		limits.ai_calls_month = null;
		const o = `${org}-unl`;
		for (let i = 0; i < 3; i++)
			expect((await consumeQuota(o, "ai_calls_month")).allowed).toBe(
				true,
			);
		const r = await consumeQuota(o, "ai_calls_month", 2);
		expect(r).toEqual({ allowed: true, used: 5, limit: null });
	});

	it("a missing limit key is unlimited", async () => {
		const r = await consumeQuota(`${org}-missing`, "tax_lookups_month");
		expect(r).toEqual({ allowed: true, used: 1, limit: null });
	});

	it("a refused call leaves the count unchanged and reports it", async () => {
		limits.ai_calls_month = 2;
		const o = `${org}-refuse`;
		await consumeQuota(o, "ai_calls_month");
		await consumeQuota(o, "ai_calls_month");
		expect(await consumeQuota(o, "ai_calls_month")).toEqual({
			allowed: false,
			used: 2,
			limit: 2,
		});
	});

	it("limit 0 refuses the first call and never warns", async () => {
		limits.ai_calls_month = 0;
		const r = await consumeQuota(`${org}-zero`, "ai_calls_month");
		expect(r).toEqual({ allowed: false, used: 0, limit: 0 });
		expect(notify).not.toHaveBeenCalled();
	});

	it("the 80 % warning is sent once even when many calls cross it together", async () => {
		limits.ai_calls_month = 10;
		const o = `${org}-warn`;
		for (let i = 0; i < 7; i++) await consumeQuota(o, "ai_calls_month");
		expect(notify).not.toHaveBeenCalled();
		await Promise.all(
			Array.from({ length: 3 }, () => consumeQuota(o, "ai_calls_month")),
		);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatchObject({
			type: "usage_limit_warning",
			actionUrl: "/dispatch/admin?tab=entitlements",
		});
		expect(notify.mock.calls[0][1]).toBe(o);
	});

	it("usage summary reads this month's meters and defaults to 0", async () => {
		limits.ai_calls_month = 10;
		const o = `${org}-sum`;
		await consumeQuota(o, "ai_calls_month", 4);
		const s = await getUsageSummary(o, {
			ai_calls_month: 10,
			tax_lookups_month: 0,
		});
		expect(s.period_start).toBe(periodStart());
		expect(s.meters.ai_calls_month).toEqual({ used: 4, limit: 10 });
		expect(s.meters.tax_lookups_month).toEqual({ used: 0, limit: 0 });
		expect(s.meters.dispatchers).toEqual({ used: 0, limit: null });
		expect(s.meters.technicians).toEqual({ used: 0, limit: null });
	});
});
