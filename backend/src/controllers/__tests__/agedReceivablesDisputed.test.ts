import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Both aged-receivables functions gained a second raw query, a merge of
 * disputed and non-disputed rows keyed by client id, a re-derived total and a
 * JS sort that replaced the SQL ORDER BY. None of it had any test coverage,
 * old or new — and it is a raw-SQL money aggregate, where a sign error or a
 * double count silently misstates what the business thinks it is owed.
 *
 * The queries themselves are the DB's job; what is asserted here is the
 * arithmetic and the merge on top of them, which is where the changeset's own
 * logic actually lives.
 */
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = { $extends, $queryRaw: vi.fn() };
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({ db: mockDb }));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

import {
	getAgedReceivables,
	getAgedReceivablesByClient,
} from "../reportsController.js";

const raw = mockDb.$queryRaw as ReturnType<typeof vi.fn>;

/** The two queries run in order: ageing buckets first, then the disputed split. */
const answerWith = (buckets: unknown[], disputed: unknown[]) => {
	raw.mockResolvedValueOnce(buckets).mockResolvedValueOnce(disputed);
};

beforeEach(() => vi.clearAllMocks());

describe("getAgedReceivables — disputed carve-out", () => {
	it("keeps disputed money in the total while holding it out of the buckets", async () => {
		answerWith(
			[
				{ bucket: "0-30", amount: 1000, count: 2 },
				{ bucket: "90+", amount: 500, count: 1 },
			],
			[{ amount: 2500, count: 1 }],
		);

		const result = await getAgedReceivables("org1");

		// The contested $2,500 must not age — that is the whole point of the
		// carve-out — but it is still owed, so it stays in the total.
		expect(result.data.find((d) => d.bucket === "0-30")?.amount).toBe(1000);
		expect(result.data.find((d) => d.bucket === "90+")?.amount).toBe(500);
		expect(result.disputedTotal).toBe(2500);
		expect(result.disputedCount).toBe(1);
		expect(result.totalOutstanding).toBe(4000);
	});

	it("reports zeroes rather than nulls when nothing is disputed", async () => {
		answerWith(
			[{ bucket: "0-30", amount: 300, count: 1 }],
			[{ amount: null, count: 0 }],
		);

		const result = await getAgedReceivables("org1");

		expect(result.disputedTotal).toBe(0);
		expect(result.disputedCount).toBe(0);
		// No disputed money means the total is exactly the buckets, so the
		// carve-out cannot inflate an org that has never used it.
		expect(result.totalOutstanding).toBe(300);
	});

	/**
	 * An unapplied credit is money the client can spend against this balance,
	 * so leaving it out overstates receivables by the whole credit. The queries
	 * now select a non-zero balance rather than a positive one, and credits are
	 * bucketed as current — ageing a credit would read as the organisation
	 * being slow to repay itself, which is not a collection-risk fact about
	 * the client.
	 */
	it("nets an unapplied credit out of the current bucket and the total", async () => {
		answerWith(
			[
				{ bucket: "0-30", amount: -500, count: 1 },
				{ bucket: "90+", amount: 2000, count: 1 },
			],
			[],
		);

		const result = await getAgedReceivables("org1");

		expect(result.data.find((d) => d.bucket === "0-30")?.amount).toBe(-500);
		expect(result.data.find((d) => d.bucket === "90+")?.amount).toBe(2000);
		// $2,000 owed less a $500 credit is $1,500 of real exposure.
		expect(result.totalOutstanding).toBe(1500);
	});

	it("returns every bucket even when the query answered for none of them", async () => {
		answerWith([], []);

		const result = await getAgedReceivables("org1");

		expect(result.data.map((d) => d.bucket)).toEqual([
			"0-30",
			"31-60",
			"61-90",
			"90+",
		]);
		expect(result.totalOutstanding).toBe(0);
	});
});

describe("getAgedReceivablesByClient — disputed merge", () => {
	it("adds the disputed column to a client that also has aged debt", async () => {
		answerWith(
			[
				{
					clientId: "c1",
					clientName: "Acme",
					bucket0_30: 100,
					bucket31_60: 0,
					bucket61_90: 0,
					bucket90plus: 0,
					total: 100,
					count: 1,
				},
			],
			[{ clientId: "c1", clientName: "Acme", disputed: 400, count: 2 }],
		);

		const rows = await getAgedReceivablesByClient("org1");

		expect(rows).toHaveLength(1);
		expect(rows[0].disputed).toBe(400);
		// One row per client, not two, and the count covers both populations.
		expect(rows[0].total).toBe(500);
		expect(rows[0].count).toBe(3);
	});

	it("still lists a client whose only outstanding money is disputed", async () => {
		answerWith(
			[],
			[{ clientId: "c2", clientName: "Globex", disputed: 750, count: 1 }],
		);

		const rows = await getAgedReceivablesByClient("org1");

		// The bucket query excludes Disputed, so without the merge's else
		// branch this client would vanish from the report entirely.
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			clientId: "c2",
			clientName: "Globex",
			disputed: 750,
			total: 750,
			count: 1,
			bucket0_30: 0,
		});
	});

	it("sorts by combined total, so a purely disputed client is not sunk", async () => {
		answerWith(
			[
				{
					clientId: "c1",
					clientName: "Small",
					bucket0_30: 200,
					bucket31_60: 0,
					bucket61_90: 0,
					bucket90plus: 0,
					total: 200,
					count: 1,
				},
			],
			[{ clientId: "c2", clientName: "Big", disputed: 9000, count: 1 }],
		);

		const rows = await getAgedReceivablesByClient("org1");

		// The SQL ORDER BY was dropped in favour of a JS sort; it has to rank
		// on the total that includes disputed money, not the bucket subtotal.
		expect(rows.map((r) => r.clientId)).toEqual(["c2", "c1"]);
	});

	it("rounds the total once over the sum, not once per addend", async () => {
		answerWith(
			[
				{
					clientId: "c1",
					clientName: "Acme",
					bucket0_30: 0.005,
					bucket31_60: 0,
					bucket61_90: 0,
					bucket90plus: 0,
					total: 0.005,
					count: 1,
				},
			],
			[{ clientId: "c1", clientName: "Acme", disputed: 0.005, count: 1 }],
		);

		const rows = await getAgedReceivablesByClient("org1");

		// round2(0.005) + round2(0.005) would be 0.02; rounding the sum is 0.01.
		expect(rows[0].total).toBe(0.01);
	});
});
