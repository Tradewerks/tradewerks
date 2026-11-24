/**
 * One-time repair of occurrences that predate rule-computed slots. M1 copied
 * occurrence_start_at into original_start_at, which is wrong for any row that
 * was rescheduled earlier: generation would then see its true slot as empty
 * and create it again. Each such row is matched back to its nearest slot
 * when no verified row holds it.
 */
import type { Prisma } from "../../../generated/prisma/client.js";
import { computeSlots, toSlotRule, type Slot } from "./occurrenceSlots.js";
import { addLocalDays, diffLocalDays, toLocalDate } from "./zonedTime.js";

const DAY_MS = 86_400_000;

// Year 1 is far below any real occurrence, so parked values can't collide.
// (Date.UTC would read year 1 as 1901.)
const PARKING_BASE_MS = Date.parse("0001-01-01T00:00:00Z");

export function periodDaysFor(rule: {
	frequency: "daily" | "weekly" | "monthly" | "yearly";
	interval: number;
}): number {
	const interval = Math.max(1, Math.floor(rule.interval) || 1);
	switch (rule.frequency) {
		case "daily":
			return interval;
		case "weekly":
			return 7 * interval;
		case "monthly":
			return 30 * interval;
		case "yearly":
			return 365 * interval;
	}
}

/**
 * `slots` must be every rule slot in the window, held ones included: a row
 * may only claim the slot it sits strictly nearest to, so a row rescheduled
 * within its own period can't jump to a neighbour just because its real slot
 * was re-created (and is now `held`). `timezone` adds a local-date bound so a
 * row never claims a slot a whole period or more away, whatever DST does to
 * the hour count.
 */
export function matchLegacySlots(
	legacy: { id: string; occurrence_start_at: Date }[],
	slots: Slot[],
	periodDays: number,
	opts: { held?: ReadonlySet<number>; timezone?: string } = {},
): { id: string; original_start_at: Date }[] {
	const reach = Math.min(Math.max(periodDays / 2, 1), periodDays) * DAY_MS;
	const pairs: { li: number; si: number; dist: number }[] = [];
	legacy.forEach((row, li) => {
		const t = row.occurrence_start_at.getTime();
		let best = -1;
		let bestDist = Infinity;
		let tied = false;
		slots.forEach((slot, si) => {
			const dist = Math.abs(slot.start.getTime() - t);
			if (dist < bestDist) {
				best = si;
				bestDist = dist;
				tied = false;
			} else if (dist === bestDist) {
				tied = true;
			}
		});
		if (best < 0 || tied || bestDist >= reach) return;
		const slot = slots[best];
		if (opts.held?.has(slot.start.getTime())) return;
		if (opts.timezone) {
			const rowDate = toLocalDate(row.occurrence_start_at, opts.timezone);
			if (Math.abs(diffLocalDays(slot.date, rowDate)) >= periodDays) {
				return;
			}
		}
		pairs.push({ li, si: best, dist: bestDist });
	});
	// Ties fall back to input order, so callers decide who wins an exact tie.
	pairs.sort((a, b) => a.dist - b.dist || a.li - b.li);

	const slotTaken = new Set<number>();
	const out: { id: string; original_start_at: Date }[] = [];
	for (const { li, si } of pairs) {
		if (slotTaken.has(si)) continue;
		slotTaken.add(si);
		out.push({ id: legacy[li].id, original_start_at: slots[si].start });
	}
	return out;
}

/**
 * Returns how many legacy rows had their original_start_at corrected.
 * Must run inside a $transaction: rows are parked on placeholder values and
 * then landed in separate writes, which is only atomic within one.
 */
export async function reconcileLegacySlots(
	planId: string,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const legacy = await tx.recurring_occurrence.findMany({
		where: { recurring_plan_id: planId, slot_verified: false },
		select: {
			id: true,
			occurrence_start_at: true,
			original_start_at: true,
		},
		orderBy: [{ original_start_at: "asc" }, { id: "asc" }],
	});
	if (legacy.length === 0) return 0;

	const plan = await tx.recurring_plan.findUnique({
		where: { id: planId },
		include: { rules: { include: { by_weekday: true } } },
	});
	const rule = plan?.rules[0];

	let changed = 0;
	if (plan && rule) {
		const times = legacy.map((r) => r.occurrence_start_at.getTime());
		const periodDays = periodDaysFor(rule);
		const from = addLocalDays(
			toLocalDate(new Date(Math.min(...times)), plan.timezone),
			-periodDays,
		);
		const to = addLocalDays(
			toLocalDate(new Date(Math.max(...times)), plan.timezone),
			periodDays,
		);
		const slots = computeSlots(
			toSlotRule(rule),
			{
				startsAt: plan.starts_at,
				endsAt: plan.ends_at,
				timezone: plan.timezone,
			},
			{ from, to },
		);

		changed = await applyMatches(
			planId,
			tx,
			legacy,
			slots,
			periodDays,
			plan.timezone,
		);
	}

	await tx.recurring_occurrence.updateMany({
		where: { recurring_plan_id: planId, slot_verified: false },
		data: { slot_verified: true },
	});
	return changed;
}

async function applyMatches(
	planId: string,
	tx: Prisma.TransactionClient,
	legacy: {
		id: string;
		occurrence_start_at: Date;
		original_start_at: Date;
	}[],
	slots: Slot[],
	periodDays: number,
	timezone: string,
): Promise<number> {
	if (slots.length === 0) return 0;

	const verified = await tx.recurring_occurrence.findMany({
		where: {
			recurring_plan_id: planId,
			slot_verified: true,
			original_start_at: {
				gte: slots[0].start,
				lte: slots[slots.length - 1].start,
			},
		},
		select: { original_start_at: true },
	});
	const held = new Set(verified.map((r) => r.original_start_at.getTime()));

	// An M1 offset duplicate (original != occurrence) must never fill a real
	// slot, so only rows still holding their own start are candidates.
	const candidates = legacy.filter(
		(r) =>
			r.original_start_at.getTime() === r.occurrence_start_at.getTime(),
	);
	const matches = matchLegacySlots(candidates, slots, periodDays, {
		held,
		timezone,
	});
	const current = new Map(
		legacy.map((r) => [r.id, r.original_start_at.getTime()]),
	);
	// A row that doesn't move keeps its value, so no mover may land on it;
	// dropping a mover pins its own value too, hence the loop.
	let moves = matches.filter(
		(m) => current.get(m.id) !== m.original_start_at.getTime(),
	);
	for (;;) {
		const moving = new Set(moves.map((m) => m.id));
		const kept = new Set(
			legacy
				.filter((r) => !moving.has(r.id))
				.map((r) => current.get(r.id)),
		);
		const next = moves.filter(
			(m) => !kept.has(m.original_start_at.getTime()),
		);
		if (next.length === moves.length) break;
		moves = next;
	}

	// The unique index is checked row by row, so a swap or chain written
	// directly would collide; park every mover first, then land them. With
	// only self-holding rows moving this is defensive, but cheap.
	for (let i = 0; i < moves.length; i++) {
		await tx.recurring_occurrence.update({
			where: { id: moves[i].id },
			data: { original_start_at: new Date(PARKING_BASE_MS + i) },
		});
	}
	for (const m of moves) {
		await tx.recurring_occurrence.update({
			where: { id: m.id },
			data: { original_start_at: m.original_start_at },
		});
	}
	return moves.length;
}
