import type {
	Prisma,
	log as LogRow,
} from "../../../generated/prisma/client.js";
import { FEED_EVENT_SET } from "../../lib/activityFeedEvents.js";
import { redactFeedRow } from "../../controllers/logsController.js";
import { getSocket } from "../socketService.js";
import { recordChangedFromLog } from "../recordChanged.js";

type ChangeSet = Record<string, { old: unknown; new: unknown }>;

/**
 * logActivity's row, written on the caller's tx so a rollback takes it too.
 * Its live hints are the caller's to send after commit (emitActivityHints).
 */
export async function logActivityInTx(
	tx: Prisma.TransactionClient,
	params: {
		event_type: string;
		action: string;
		entity_type: string;
		entity_id: string;
		organization_id: string;
		actor_type: string;
		actor_id?: string | null;
		ip_address?: string;
		user_agent?: string;
		changes: ChangeSet;
	},
): Promise<LogRow> {
	let actorName: string | null = null;
	if (params.actor_id && params.actor_type === "technician") {
		const t = await tx.technician.findUnique({
			where: { id: params.actor_id },
			select: { name: true },
		});
		actorName = t?.name || "Unknown Technician";
	} else if (params.actor_id && params.actor_type === "dispatcher") {
		const d = await tx.dispatcher.findUnique({
			where: { id: params.actor_id },
			select: { name: true },
		});
		actorName = d?.name || "Unknown Dispatcher";
	}
	return tx.log.create({
		data: {
			event_type: params.event_type,
			action: params.action,
			entity_type: params.entity_type,
			entity_id: params.entity_id,
			organization_id: params.organization_id,
			actor_type: params.actor_type,
			actor_id: params.actor_id || null,
			actor_name: actorName,
			changes: JSON.parse(JSON.stringify(params.changes)),
			timestamp: new Date(),
			ip_address: params.ip_address || null,
			user_agent: params.user_agent || null,
		},
	});
}

/** The live hints logActivity sends, for a row that has committed. */
export function emitActivityHints(row: LogRow): void {
	if (FEED_EVENT_SET.has(row.event_type) && row.organization_id) {
		try {
			getSocket()
				.to(`org:${row.organization_id}`)
				.emit("activity-event", redactFeedRow(row));
		} catch {
			// socket not initialised
		}
	}
	try {
		recordChangedFromLog(row);
	} catch {
		// a live-refresh hint never fails a committed change
	}
}
