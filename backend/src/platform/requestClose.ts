import type { db } from "../db.js";
import { ErrorCodes, httpError } from "../types/responses.js";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export const requestClosed = () =>
	httpError(
		409,
		ErrorCodes.REQUEST_CLOSED,
		"This request was already closed",
	);

export type RequestCloser = {
	type: "platform_staff" | "dispatcher";
	id: string;
	name: string;
};

// Conditional on status "open" so two closers racing cannot both win.
export async function closeRequestTx(
	tx: Tx,
	request: { id: string; orgId: string },
	status: "approved" | "declined" | "withdrawn",
	closer: RequestCloser,
	note?: string,
): Promise<void> {
	const { count } = await tx.upgrade_request.updateMany({
		where: {
			id: request.id,
			organization_id: request.orgId,
			status: "open",
		},
		data: {
			status,
			resolved_at: new Date(),
			...(closer.type === "platform_staff" && {
				resolved_by_id: closer.id,
				resolution_note: note,
			}),
		},
	});
	if (count === 0) throw requestClosed();
	await tx.log.create({
		data: {
			organization_id: request.orgId,
			event_type: `upgrade_request.${status}`,
			action: "updated",
			entity_type: "upgrade_request",
			entity_id: request.id,
			actor_type: closer.type,
			actor_id: closer.id,
			actor_name: closer.name,
			...(note !== undefined && { reason: note }),
		},
	});
}
