import { z } from "zod";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { offWindows, type OffWindow } from "../lib/entitlements/windows.js";

const choices = z.record(z.string(), z.boolean()).catch({});
const changeShape = z.object({
	module_choices: z.object({ old: choices, new: choices }),
});

export async function getOffWindows(
	orgId: string,
	moduleKey: string,
): Promise<OffWindow[]> {
	const rows = await db.log.findMany({
		where: {
			organization_id: orgId,
			event_type: "org_entitlement.modules_changed",
		},
		orderBy: { timestamp: "asc" },
		select: { timestamp: true, changes: true },
	});
	const changes = rows.flatMap((r) => {
		const parsed = changeShape.safeParse(r.changes);
		return parsed.success
			? [
					{
						at: r.timestamp,
						old: parsed.data.module_choices.old,
						next: parsed.data.module_choices.new,
					},
				]
			: [];
	});
	return offWindows(changes, moduleKey);
}

export async function getClosedWindows(
	orgId: string,
	moduleKey: string,
): Promise<{ off: Date; on: Date }[]> {
	return (await getOffWindows(orgId, moduleKey)).flatMap((w) =>
		w.on ? [{ off: w.off, on: w.on }] : [],
	);
}

export async function lastReenabledAt(
	orgId: string,
	moduleKey: string,
): Promise<Date | null> {
	const closed = await getClosedWindows(orgId, moduleKey);
	return closed[closed.length - 1]?.on ?? null;
}

const DISMISSED = "org_entitlement.notice_dismissed";

export interface UntrackedStockNotice {
	module: "inventory" | "vehicle_stock";
	off: Date;
	on: Date;
	visits: {
		id: string;
		job_id: string;
		name: string | null;
		completed_at: Date;
	}[];
}

export async function getUntrackedStockNotice(
	orgId: string,
	moduleKey: "inventory" | "vehicle_stock",
): Promise<UntrackedStockNotice | null> {
	const closed = await getClosedWindows(orgId, moduleKey);
	const window = closed[closed.length - 1];
	if (!window) return null;
	const dismissed = await db.log.findFirst({
		where: {
			organization_id: orgId,
			event_type: DISMISSED,
			entity_id: `${moduleKey}:${window.on.toISOString()}`,
		},
		select: { id: true },
	});
	if (dismissed) return null;

	// Vehicle Stock: parts-used is refused while it is off, so no line exists for the
	// window. The notice still tells the org its truck counts may be wrong.
	if (moduleKey === "vehicle_stock")
		return { module: moduleKey, ...window, visits: [] };

	// Same selection deductInventoryForVisit makes, for visits it was skipped on.
	const visits = await getScopedDb(orgId).job_visit.findMany({
		where: {
			status: "Completed",
			actual_end_at: { gte: window.off, lte: window.on },
			stock_movements: { none: {} },
			line_items: {
				some: {
					inventory_item_id: { not: null },
					OR: [
						{ fulfillment_status: null },
						{ fulfillment_status: { not: "used" } },
					],
				},
			},
		},
		orderBy: { actual_end_at: "asc" },
		select: { id: true, job_id: true, name: true, actual_end_at: true },
	});
	return {
		module: moduleKey,
		...window,
		visits: visits.map((v) => ({
			id: v.id,
			job_id: v.job_id,
			name: v.name,
			completed_at: v.actual_end_at as Date,
		})),
	};
}

export async function dismissUntrackedStockNotice(
	orgId: string,
	moduleKey: "inventory" | "vehicle_stock",
	on: Date,
	actor: { id: string; name: string },
): Promise<void> {
	await db.log.create({
		data: {
			organization_id: orgId,
			event_type: DISMISSED,
			action: "updated",
			entity_type: "org_entitlement",
			entity_id: `${moduleKey}:${on.toISOString()}`,
			actor_type: "dispatcher",
			actor_id: actor.id,
			actor_name: actor.name,
		},
	});
}
