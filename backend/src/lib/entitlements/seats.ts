import { ErrorCodes, httpError } from "../../types/responses.js";
import { log } from "../../services/appLogger.js";
import { getEntitlements } from "../../services/entitlementService.js";

export type SeatKind = "dispatchers" | "technicians";

export const OPEN_VISIT_STATUSES = [
	"Scheduled",
	"Driving",
	"OnSite",
	"InProgress",
	"Paused",
	"Delayed",
] as const;

type CountArgs = { where: { organization_id: string; deactivated_at: null } };
export type SeatClient = {
	$executeRaw: (
		template: TemplateStringsArray,
		...values: unknown[]
	) => Promise<number>;
	dispatcher: { count: (args: CountArgs) => Promise<number> };
	technician: { count: (args: CountArgs) => Promise<number> };
};

export function countSeats(
	client: SeatClient,
	orgId: string,
	kind: SeatKind,
): Promise<number> {
	const args: CountArgs = {
		where: { organization_id: orgId, deactivated_at: null },
	};
	return kind === "technicians"
		? client.technician.count(args)
		: client.dispatcher.count(args);
}

const NOUN: Record<SeatKind, [string, string]> = {
	dispatchers: ["dispatcher", "dispatchers"],
	technicians: ["technician", "technicians"],
};

export async function assertSeatAvailable(
	tx: SeatClient,
	orgId: string,
	kind: SeatKind,
): Promise<void> {
	let limit: number | null;
	try {
		limit = (await getEntitlements(orgId)).limits[kind] ?? null;
	} catch (err) {
		// Adding a user is not worth blocking on an entitlement outage (spec §12).
		log.warn(
			{ err, orgId, kind },
			"seat check skipped: entitlements unavailable",
		);
		return;
	}
	if (limit === null) return;
	// Serialises concurrent creates/reactivations for this org and kind until the
	// transaction ends, so two requests cannot both take the last seat.
	if (kind === "technicians")
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(7, hashtext(${orgId}))`;
	else
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(6, hashtext(${orgId}))`;
	const used = await countSeats(tx, orgId, kind);
	if (used >= limit) {
		const noun = NOUN[kind][limit === 1 ? 0 : 1];
		throw httpError(
			409,
			ErrorCodes.SEAT_LIMIT_REACHED,
			`Your subscription includes ${limit} ${noun}. Deactivate one or upgrade to add more.`,
		);
	}
}
