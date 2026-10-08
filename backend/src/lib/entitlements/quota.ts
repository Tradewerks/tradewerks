import { db } from "../../db.js";
import { log } from "../../services/appLogger.js";
import { getEntitlements } from "../../services/entitlementService.js";
import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { countSeats } from "./seats.js";
import { METER_KEYS, type LimitKey, type MeterKey } from "./registry.js";

export interface QuotaResult {
	allowed: boolean;
	used: number;
	limit: number | null;
}

export interface UsageSummary {
	period_start: string;
	meters: Record<LimitKey, { used: number; limit: number | null }>;
}

const METER_COPY: Record<MeterKey, { name: string; unit: string }> = {
	ai_calls_month: { name: "AI assistant", unit: "requests" },
	tax_lookups_month: { name: "Tax lookups", unit: "lookups" },
	receipt_scans_month: { name: "Receipt scanning", unit: "scans" },
};

const WARN_AT = 0.8;

// Computed once per call and passed to SQL so the INSERT and the UPDATE can
// never land in different months at the boundary.
export function periodStart(now: Date = new Date()): string {
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${now.getUTCFullYear()}-${m}-01`;
}

const limitOf = (
	limits: Record<string, number | null>,
	key: string,
): number | null => limits[key] ?? null;

export async function consumeQuota(
	orgId: string,
	meter: MeterKey,
	n = 1,
): Promise<QuotaResult> {
	const limit = limitOf((await getEntitlements(orgId)).limits, meter);
	const p = periodStart();

	await db.$executeRaw`
		INSERT INTO "usage_counter" ("id", "organization_id", "meter", "period_start", "count")
		VALUES (gen_random_uuid()::text, ${orgId}, ${meter}, ${p}::date, 0)
		ON CONFLICT ("organization_id", "meter", "period_start") DO NOTHING`;

	type Row = { id: string; count: number; warned_at: Date | null };
	const rows =
		limit === null
			? await db.$queryRaw<Row[]>`
				UPDATE "usage_counter" SET "count" = "count" + ${n}
				WHERE "organization_id" = ${orgId} AND "meter" = ${meter} AND "period_start" = ${p}::date
				RETURNING "id", "count", "warned_at"`
			: await db.$queryRaw<Row[]>`
				UPDATE "usage_counter" SET "count" = "count" + ${n}
				WHERE "organization_id" = ${orgId} AND "meter" = ${meter} AND "period_start" = ${p}::date
				  AND "count" + ${n} <= ${limit}
				RETURNING "id", "count", "warned_at"`;

	if (rows.length === 0) {
		const current = await db.usage_counter.findFirst({
			where: {
				organization_id: orgId,
				meter,
				period_start: new Date(`${p}T00:00:00Z`),
			},
			select: { count: true },
		});
		return { allowed: false, used: current?.count ?? 0, limit };
	}

	const { id, count, warned_at } = rows[0]!;
	if (
		limit !== null &&
		limit > 0 &&
		warned_at === null &&
		count >= limit * WARN_AT
	) {
		await warnOnce(orgId, id, meter, count, limit);
	}
	return { allowed: true, used: count, limit };
}

async function warnOnce(
	orgId: string,
	rowId: string,
	meter: MeterKey,
	used: number,
	limit: number,
) {
	// The claim, not the read above, decides who sends: several instances can
	// cross 80 % together and only the one whose UPDATE matched may notify.
	const claimed = await db.$executeRaw`
		UPDATE "usage_counter" SET "warned_at" = now() WHERE "id" = ${rowId} AND "warned_at" IS NULL`;
	if (claimed !== 1) return;
	const copy = METER_COPY[meter];
	try {
		await notifyDispatchers(
			{
				type: "usage_limit_warning",
				title: `${copy.name}: ${Math.floor((used / limit) * 100)}% of this month's limit used`,
				body: `${used} of ${limit} ${copy.unit} used this month. The limit resets on the 1st (UTC).`,
				actionUrl: "/dispatch/admin?tab=entitlements",
			},
			orgId,
		);
	} catch (err) {
		log.warn(
			{ err, orgId, meter },
			"usage warning claimed but not delivered",
		);
	}
}

export async function getUsageSummary(
	orgId: string,
	limits: Record<string, number | null>,
): Promise<UsageSummary> {
	const p = periodStart();
	const [dispatchers, technicians, rows] = await Promise.all([
		countSeats(db, orgId, "dispatchers"),
		countSeats(db, orgId, "technicians"),
		db.usage_counter.findMany({
			where: {
				organization_id: orgId,
				period_start: new Date(`${p}T00:00:00Z`),
			},
			select: { meter: true, count: true },
		}),
	]);
	const used = (m: MeterKey) => rows.find((r) => r.meter === m)?.count ?? 0;
	const meters = {
		dispatchers: {
			used: dispatchers,
			limit: limitOf(limits, "dispatchers"),
		},
		technicians: {
			used: technicians,
			limit: limitOf(limits, "technicians"),
		},
	} as UsageSummary["meters"];
	for (const m of METER_KEYS)
		meters[m] = { used: used(m), limit: limitOf(limits, m) };
	return { period_start: p, meters };
}
