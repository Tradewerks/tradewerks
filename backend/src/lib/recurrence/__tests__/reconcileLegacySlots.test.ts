import { describe, it, expect } from "vitest";
import {
	matchLegacySlots,
	reconcileLegacySlots,
} from "../reconcileLegacySlots.js";
import { computeSlots, type SlotRule } from "../occurrenceSlots.js";
import { zonedWallTimeToUtc } from "../zonedTime.js";
import type { Prisma } from "../../../../generated/prisma/client.js";

const CHI = "America/Chicago";

/** 08:00 Chicago on `date`, plus `offsetMs`. */
const at8 = (date: string, offsetMs = 0) =>
	new Date(zonedWallTimeToUtc(date, "08:00", CHI).getTime() + offsetMs);

function monthlyRule(overrides: Partial<SlotRule> = {}) {
	return {
		frequency: "monthly" as const,
		interval: 1,
		by_weekday: [] as { weekday: "MO" }[],
		by_month_day: 1,
		by_month: null,
		arrival_constraint: "at" as const,
		finish_constraint: "when_done" as const,
		arrival_time: "08:00",
		arrival_window_start: null,
		arrival_window_end: null,
		finish_time: null,
		...overrides,
	};
}

const slotsFor = (from: string, to: string) =>
	computeSlots(
		{ ...monthlyRule(), by_weekday: [] },
		{ startsAt: at8("2026-06-01"), endsAt: null, timezone: CHI },
		{ from, to },
	);

type Row = {
	id: string;
	recurring_plan_id: string;
	occurrence_start_at: Date;
	original_start_at: Date;
	slot_verified: boolean;
};

/**
 * In-memory stand-in for the transaction client. It enforces the
 * (recurring_plan_id, original_start_at) unique index on every write, like
 * Postgres does row by row, so a careless write order fails here too.
 */
function fakeTx(
	rows: Row[],
	plan: Record<string, unknown> = {
		id: "plan-1",
		starts_at: at8("2026-06-01"),
		ends_at: null,
		timezone: CHI,
		rules: [monthlyRule()],
	},
) {
	const writes: { id: string; original_start_at: Date }[] = [];
	const matches = (r: Row, where: Record<string, unknown>) => {
		if (
			where.recurring_plan_id !== undefined &&
			r.recurring_plan_id !== where.recurring_plan_id
		)
			return false;
		if (
			where.slot_verified !== undefined &&
			r.slot_verified !== where.slot_verified
		)
			return false;
		const range = where.original_start_at as
			{ gte?: Date; lte?: Date } | undefined;
		if (range?.gte && r.original_start_at < range.gte) return false;
		if (range?.lte && r.original_start_at > range.lte) return false;
		return true;
	};
	const tx = {
		recurring_plan: {
			findUnique: async () => plan,
		},
		recurring_occurrence: {
			findMany: async ({ where }: { where: Record<string, unknown> }) =>
				rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: { original_start_at: Date };
			}) => {
				const row = rows.find((r) => r.id === where.id)!;
				const clash = rows.find(
					(r) =>
						r.id !== row.id &&
						r.recurring_plan_id === row.recurring_plan_id &&
						r.original_start_at.getTime() ===
							data.original_start_at.getTime(),
				);
				if (clash) {
					throw new Error(
						`unique violation: ${row.id} onto ${clash.id}`,
					);
				}
				row.original_start_at = data.original_start_at;
				writes.push({ id: row.id, ...data });
				return { ...row };
			},
			updateMany: async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: { slot_verified: boolean };
			}) => {
				const hit = rows.filter((r) => matches(r, where));
				for (const r of hit) r.slot_verified = data.slot_verified;
				return { count: hit.length };
			},
		},
	};
	return { tx: tx as unknown as Prisma.TransactionClient, writes };
}

const legacy = (
	id: string,
	start: Date,
	original: Date = start,
	verified = false,
): Row => ({
	id,
	recurring_plan_id: "plan-1",
	occurrence_start_at: start,
	original_start_at: original,
	slot_verified: verified,
});

describe("matchLegacySlots", () => {
	it("a monthly occurrence moved from the 1st to the 3rd reclaims the 1st slot", () => {
		const slots = slotsFor("2026-08-01", "2026-10-31");
		const out = matchLegacySlots(
			[{ id: "a", occurrence_start_at: at8("2026-09-03") }],
			slots,
			30,
		);
		expect(out).toEqual([
			{ id: "a", original_start_at: at8("2026-09-01") },
		]);
	});

	it("two legacy rows near one slot: the closer one wins, the other keeps its value", () => {
		const slots = slotsFor("2026-09-01", "2026-09-01");
		const out = matchLegacySlots(
			[
				{ id: "far", occurrence_start_at: at8("2026-09-05") },
				{ id: "near", occurrence_start_at: at8("2026-09-02") },
			],
			slots,
			30,
		);
		expect(out).toEqual([
			{ id: "near", original_start_at: at8("2026-09-01") },
		]);
	});

	it("does not claim a slot further than half a period away", () => {
		const slots = slotsFor("2026-09-01", "2026-09-01");
		const out = matchLegacySlots(
			[{ id: "a", occurrence_start_at: at8("2026-09-17") }],
			slots,
			30,
		);
		expect(out).toEqual([]);
	});

	it("uses a one-day floor for short periods", () => {
		const slot = {
			date: "2026-09-01",
			start: at8("2026-09-01"),
			end: at8("2026-09-01", 7_200_000),
		};
		const near = matchLegacySlots(
			[{ id: "a", occurrence_start_at: at8("2026-09-01", 20 * 3600e3) }],
			[slot],
			1,
		);
		expect(near).toHaveLength(1);
		const far = matchLegacySlots(
			[{ id: "a", occurrence_start_at: at8("2026-09-01", 25 * 3600e3) }],
			[slot],
			1,
		);
		expect(far).toEqual([]);
	});

	it("a row beaten to its nearest slot does not fall back to another", () => {
		const slots = slotsFor("2026-08-01", "2026-10-31");
		const out = matchLegacySlots(
			[
				{ id: "a", occurrence_start_at: at8("2026-09-03") },
				{ id: "b", occurrence_start_at: at8("2026-09-02") },
			],
			slots,
			30,
		);
		expect(out).toEqual([
			{ id: "b", original_start_at: at8("2026-09-01") },
		]);
	});

	it("a row nearest a held slot never claims the neighbouring one", () => {
		const slots = slotsFor("2026-08-01", "2026-10-31");
		const out = matchLegacySlots(
			[{ id: "a", occurrence_start_at: at8("2026-09-10") }],
			slots,
			30,
			{ held: new Set([at8("2026-09-01").getTime()]) },
		);
		expect(out).toEqual([]);
	});
});

describe("reconcileLegacySlots", () => {
	it("a slot already held by a verified row is never claimed", async () => {
		const rows = [
			legacy("held", at8("2026-09-01"), at8("2026-09-01"), true),
			legacy("old", at8("2026-09-04")),
		];
		const { tx } = fakeTx(rows);
		const changed = await reconcileLegacySlots("plan-1", tx);
		expect(changed).toBe(0);
		expect(rows[1].original_start_at).toEqual(at8("2026-09-04"));
		expect(rows[1].slot_verified).toBe(true);
	});

	it("reconcileLegacySlots marks all legacy rows verified and is a no-op on the second run", async () => {
		const rows = [
			legacy("moved", at8("2026-09-03")),
			legacy("orphan", at8("2026-09-16")),
			legacy("ontime", at8("2026-10-01")),
		];
		const { tx, writes } = fakeTx(rows);

		expect(await reconcileLegacySlots("plan-1", tx)).toBe(1);
		expect(rows.every((r) => r.slot_verified)).toBe(true);
		expect(rows[0].original_start_at).toEqual(at8("2026-09-01"));
		expect(rows[1].original_start_at).toEqual(at8("2026-09-16"));
		expect(rows[2].original_start_at).toEqual(at8("2026-10-01"));

		const before = writes.length;
		expect(await reconcileLegacySlots("plan-1", tx)).toBe(0);
		expect(writes.length).toBe(before);
	});

	it("several rows moving onto slots never collide mid-update", async () => {
		const rows = [
			legacy("x", at8("2026-09-02")),
			legacy("y", at8("2026-10-01", 3600e3)),
			legacy("z", at8("2026-10-30")),
		];
		const { tx } = fakeTx(rows);
		expect(await reconcileLegacySlots("plan-1", tx)).toBe(3);
		expect(rows[0].original_start_at).toEqual(at8("2026-09-01"));
		expect(rows[1].original_start_at).toEqual(at8("2026-10-01"));
		expect(rows[2].original_start_at).toEqual(at8("2026-11-01"));
	});

	it("an unmatched row keeps a slot value nobody else may take", async () => {
		// Duplicate legacy rows share one start; M1 offset the second by 1 ms.
		const rows = [
			legacy("dup1", at8("2026-09-01"), at8("2026-09-01", 1)),
			legacy("dup0", at8("2026-09-01"), at8("2026-09-01")),
		];
		const { tx } = fakeTx(rows);
		await reconcileLegacySlots("plan-1", tx);
		expect(rows[1].original_start_at).toEqual(at8("2026-09-01"));
		expect(rows[0].original_start_at).toEqual(at8("2026-09-01", 1));
		expect(rows.every((r) => r.slot_verified)).toBe(true);
	});

	it("yearly rules without a month day leave rows unmatched but verified", async () => {
		const rows = [legacy("a", at8("2026-09-03"))];
		const { tx } = fakeTx(rows, {
			id: "plan-1",
			starts_at: at8("2026-06-01"),
			ends_at: null,
			timezone: CHI,
			rules: [
				monthlyRule({
					frequency: "yearly",
					by_month: 9,
					by_month_day: null,
				}),
			],
		});
		expect(await reconcileLegacySlots("plan-1", tx)).toBe(0);
		expect(rows[0].original_start_at).toEqual(at8("2026-09-03"));
		expect(rows[0].slot_verified).toBe(true);
	});

	const dailyPlan = {
		id: "plan-1",
		starts_at: at8("2026-06-01"),
		ends_at: null,
		timezone: CHI,
		rules: [monthlyRule({ frequency: "daily", by_month_day: null })],
	};

	it("daily: a row moved later in its day whose slot was re-created never takes the next day's slot", async () => {
		const rows = [
			// Generation re-created Monday 08:00 after the row moved to 09:00.
			legacy("regen", at8("2026-09-14"), at8("2026-09-14"), true),
			legacy("moved", at8("2026-09-14", 3600e3)),
			// Same story the evening before spring-forward: Sunday's 08:00 CDT
			// slot is only 22h after Saturday 09:00 CST.
			legacy("regen-dst", at8("2027-03-13"), at8("2027-03-13"), true),
			legacy("moved-dst", at8("2027-03-13", 3600e3)),
			// Moved to the evening: nearer Tuesday's slot, still Monday's row.
			legacy("regen-eve", at8("2026-09-21"), at8("2026-09-21"), true),
			legacy("moved-eve", at8("2026-09-21", 13 * 3600e3)),
		];
		const { tx } = fakeTx(rows, dailyPlan);
		expect(await reconcileLegacySlots("plan-1", tx)).toBe(0);
		for (const r of rows) {
			expect(r.original_start_at).toEqual(r.occurrence_start_at);
			expect(r.slot_verified).toBe(true);
		}
	});

	it("daily: an M1 offset duplicate never claims the next day's slot", async () => {
		const rows = [
			legacy("dup1", at8("2026-09-14"), at8("2026-09-14", 1)),
			legacy("dup0", at8("2026-09-14")),
		];
		const { tx } = fakeTx(rows, dailyPlan);
		expect(await reconcileLegacySlots("plan-1", tx)).toBe(0);
		expect(rows[0].original_start_at).toEqual(at8("2026-09-14", 1));
		expect(rows[1].original_start_at).toEqual(at8("2026-09-14"));
		expect(rows.every((r) => r.slot_verified)).toBe(true);
	});
});
