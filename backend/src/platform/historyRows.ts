import { db } from "../db.js";

const HISTORY_SELECT = {
	id: true,
	timestamp: true,
	event_type: true,
	actor_type: true,
	actor_id: true,
	actor_name: true,
	reason: true,
	changes: true,
} as const;

export async function historyRows(
	where: NonNullable<Parameters<typeof db.log.findMany>[0]>["where"],
) {
	const rows = await db.log.findMany({
		where,
		orderBy: { timestamp: "desc" },
		take: 100,
		select: HISTORY_SELECT,
	});
	return withStaffNames(rows);
}

async function withStaffNames<
	T extends { actor_type: string; actor_id: string | null },
>(rows: T[]) {
	const ids = [
		...new Set(
			rows
				.filter((r) => r.actor_type === "platform_staff" && r.actor_id)
				.map((r) => r.actor_id as string),
		),
	];
	const staff = ids.length
		? await db.platform_staff.findMany({
				where: { id: { in: ids } },
				select: { id: true, name: true },
			})
		: [];
	const names = new Map(staff.map((s) => [s.id, s.name]));
	return rows.map(({ actor_id, ...r }) => ({
		...r,
		staff_name:
			r.actor_type === "platform_staff" && actor_id
				? (names.get(actor_id) ?? null)
				: null,
	}));
}
