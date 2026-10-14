/**
 * The pre-flight a technician runs before paying has to answer the question the
 * submit path will answer later, on the same arithmetic. Its own file: the
 * lifecycle suite's db mock is shaped for the submit and review paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { db } from "../../db.js";
import { spendWindows } from "../../lib/fieldPurchase.js";
import { checkPurchaseLimit } from "../fieldPurchasesController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		field_purchase: { findFirst: vi.fn(), findMany: vi.fn() },
		field_purchase_grant: { findFirst: vi.fn() },
		organization: { findFirst: vi.fn() },
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", async () => {
	const { db } = await import("../../db.js");
	return { getScopedDb: () => db };
});

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const ORG = "org-1";
const TECH = "tech-1";
const OWN = "11111111-1111-4111-8111-111111111111";
const OTHERS = "22222222-2222-4222-8222-222222222222";
const TZ = "America/Chicago";
const mockDb = vi.mocked(db);

/** A counted-spend row in the window, shaped as `spentSoFar` reads it. */
const spend = (total: number, jobId = "job-a") => ({
	total,
	kind: "purchase",
	purchased_at: new Date(),
	created_at: new Date(),
	allocations: [{ job_id: jobId, amount: total }],
});

/** A refund row in the window, shaped as `spentSoFar` reads it. */
const refund = (total: number, refundSettledAt: Date | null) => ({
	total,
	kind: "refund",
	refund_settled_at: refundSettledAt,
	purchased_at: new Date(),
	created_at: new Date(),
	allocations: [],
});

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.organization.findFirst.mockResolvedValue({ timezone: TZ } as never);
	mockDb.field_purchase_grant.findFirst.mockResolvedValue({
		id: "grant-1",
		is_active: true,
		per_transaction_limit: 500,
		daily_limit: null,
		weekly_limit: 500,
		per_job_limit: null,
	} as never);
	mockDb.field_purchase.findMany.mockResolvedValue([]);
	// The ownership resolve: only the caller's own purchase comes back.
	mockDb.field_purchase.findFirst.mockResolvedValue({ id: OWN } as never);
});

/** The `where` the counted-spend read ran with. */
const spendWhere = () =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(mockDb.field_purchase.findMany.mock.calls[0]![0] as any).where;

describe("checkPurchaseLimit", () => {
	// The purchase being checked is itself counted spend once it leaves draft, so
	// without the exclusion its own total is measured against the ceiling twice.
	it("excludes the purchase being checked from its own spend", async () => {
		mockDb.field_purchase.findMany.mockResolvedValue([]);
		const res = await checkPurchaseLimit(ORG, TECH, { amount: 450, purchase_id: OWN });

		expect(res.err).toBeUndefined();
		expect(res.verdict!.breaches).toEqual([]);
		expect(res.spent!.week).toBe("0.00");
		expect(spendWhere().id).toEqual({ not: OWN });
	});

	it("still counts the technician's other purchases", async () => {
		mockDb.field_purchase.findMany.mockResolvedValue([spend(120)] as never);
		const res = await checkPurchaseLimit(ORG, TECH, { amount: 50, purchase_id: OWN });

		expect(res.spent!.week).toBe("120.00");
	});

	// Accepting a client-supplied id means resolving it: an id that is not the
	// caller's own excludes nothing, so it cannot be used to hide somebody's spend.
	it("ignores a purchase_id belonging to another technician", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(null);
		mockDb.field_purchase.findMany.mockResolvedValue([spend(450)] as never);

		const res = await checkPurchaseLimit(ORG, TECH, { amount: 100, purchase_id: OTHERS });

		expect(spendWhere().id).toBeUndefined();
		expect(res.spent!.week).toBe("450.00");
		expect(res.verdict!.breaches.map((b) => b.code)).toContain("weekly");
	});

	it("still works with no purchase_id at all", async () => {
		const res = await checkPurchaseLimit(ORG, TECH, { amount: 100 });

		expect(res.err).toBeUndefined();
		expect(mockDb.field_purchase.findFirst).not.toHaveBeenCalled();
		expect(spendWhere().id).toBeUndefined();
	});

	// Windows are org-local on the submit path; a pre-flight measuring a UTC day
	// answers a different question near midnight than the enforcement will.
	it("reads the org timezone the submit path reads", async () => {
		await checkPurchaseLimit(ORG, TECH, { amount: 100 });
		const win = spendWindows(new Date(), TZ);

		const or = spendWhere().OR;
		expect(or[0].purchased_at.gte.getTime()).toBe(win.weekStart.getTime());
		expect(or[0].purchased_at.lt.getTime()).toBe(win.weekEnd.getTime());
	});

	// A refund is self-produced: raised against one's own purchase, self-photographed,
	// self-verified. Netting it before settlement lets a claim free real counter spend.
	it("does not give a technician headroom for a refund nobody has settled", async () => {
		mockDb.field_purchase.findMany.mockResolvedValue([refund(900, null)] as never);
		const res = await checkPurchaseLimit(ORG, TECH, { amount: 100 });
		expect(res.spent!.week).toBe("0.00");
	});

	it("still gives the ceiling back once the refund is settled", async () => {
		mockDb.field_purchase.findMany.mockResolvedValue([refund(900, new Date())] as never);
		const res = await checkPurchaseLimit(ORG, TECH, { amount: 100 });
		expect(res.spent!.week).toBe("-900.00");
	});
});
