import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { zonedWallTimeToUtc } from "../zonedTime.js";

// Real Postgres: the unique index on (recurring_plan_id, original_start_at)
// is checked row by row, which the in-memory fake can only imitate.
// Never the dev database.
const DB_URL = process.env.QUOTA_TEST_DATABASE_URL;
vi.hoisted(() => {
	if (process.env.QUOTA_TEST_DATABASE_URL)
		process.env.DATABASE_URL = process.env.QUOTA_TEST_DATABASE_URL;
});

const CHI = "America/Chicago";
const at8 = (date: string, offsetMs = 0) =>
	new Date(zonedWallTimeToUtc(date, "08:00", CHI).getTime() + offsetMs);

describe.runIf(DB_URL)("reconcileLegacySlots against Postgres", () => {
	let db: typeof import("../../../db.js").db;
	let reconcileLegacySlots: typeof import("../reconcileLegacySlots.js").reconcileLegacySlots;
	let orgId: string;
	let planId: string;

	beforeAll(async () => {
		({ db } = await import("../../../db.js"));
		({ reconcileLegacySlots } = await import("../reconcileLegacySlots.js"));
		const org = await db.organization.create({
			data: { name: "PG reconcile legacy slots" },
		});
		orgId = org.id;
		const client = await db.client.create({
			data: {
				organization_id: orgId,
				name: "Reconcile client",
				address: "1 Main St",
				coords: {},
			},
		});
		const plan = await db.recurring_plan.create({
			data: {
				organization_id: orgId,
				client_id: client.id,
				name: "Monthly tune-up",
				description: "Filter swap",
				address: "1 Main St",
				starts_at: at8("2026-06-01"),
				timezone: CHI,
				rules: {
					create: {
						frequency: "monthly",
						interval: 1,
						by_month_day: 1,
						arrival_constraint: "at",
						finish_constraint: "when_done",
						arrival_time: "08:00",
					},
				},
			},
		});
		planId = plan.id;
	});

	afterAll(async () => {
		if (!orgId) return;
		await db.recurring_plan.deleteMany({
			where: { organization_id: orgId },
		});
		await db.client.deleteMany({ where: { organization_id: orgId } });
		await db.organization.delete({ where: { id: orgId } });
	});

	it("moves legacy rows onto their slots under the unique index, once", async () => {
		const occ = (start: Date, original: Date, slot_verified = false) => ({
			recurring_plan_id: planId,
			occurrence_start_at: start,
			occurrence_end_at: new Date(start.getTime() + 7_200_000),
			original_start_at: original,
			slot_verified,
		});
		// Aug 1 is held by a verified row, so the late-July row can't claim
		// it, and an M1 offset duplicate stays where it is.
		const [x, y, held, late, dup] = await Promise.all([
			db.recurring_occurrence.create({
				data: occ(at8("2026-09-02"), at8("2026-09-02")),
			}),
			db.recurring_occurrence.create({
				data: occ(
					at8("2026-10-01", 3_600_000),
					at8("2026-10-01", 3_600_000),
				),
			}),
			db.recurring_occurrence.create({
				data: occ(at8("2026-08-01"), at8("2026-08-01"), true),
			}),
			db.recurring_occurrence.create({
				data: occ(at8("2026-07-30"), at8("2026-07-30")),
			}),
			db.recurring_occurrence.create({
				data: occ(at8("2026-09-02"), at8("2026-09-02", 1)),
			}),
		]);

		const changed = await db.$transaction((tx) =>
			reconcileLegacySlots(planId, tx),
		);
		expect(changed).toBe(2);

		const byId = async (id: string) =>
			db.recurring_occurrence.findUniqueOrThrow({ where: { id } });
		expect((await byId(x.id)).original_start_at).toEqual(at8("2026-09-01"));
		expect((await byId(y.id)).original_start_at).toEqual(at8("2026-10-01"));
		expect((await byId(held.id)).original_start_at).toEqual(
			at8("2026-08-01"),
		);
		expect((await byId(dup.id)).original_start_at).toEqual(
			at8("2026-09-02", 1),
		);
		// Its nearest slot (Aug 1) is held: unchanged.
		const lateRow = await byId(late.id);
		expect(lateRow.original_start_at).toEqual(at8("2026-07-30"));
		expect(
			await db.recurring_occurrence.count({
				where: { recurring_plan_id: planId, slot_verified: false },
			}),
		).toBe(0);

		const again = await db.$transaction((tx) =>
			reconcileLegacySlots(planId, tx),
		);
		expect(again).toBe(0);
	});
});
