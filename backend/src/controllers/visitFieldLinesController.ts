import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { logActivity } from "../services/logger.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";

type FieldLineCode = "FORBIDDEN" | "WRONG_STATE" | "NOT_FOUND";

export type FieldLineResult = {
	err: string;
	code?: FieldLineCode;
	item?: unknown;
};

class FieldLineRefusal extends Error {
	constructor(
		message: string,
		readonly code: FieldLineCode,
	) {
		super(message);
	}
}

const FROZEN_VISIT_STATUSES: ReadonlySet<string> = new Set(["Completed", "Cancelled"]);

/**
 * The only field-line write a technician gets. It changes a quantity and
 * nothing else: name, unit price and tax fields are never accepted, so the
 * total is always quantity x the stored unit_price. Quantity 0 deletes the line.
 *
 * Stock lines ("used") are refused: their quantity is mirrored in the vehicle
 * stock ledger, which only the parts-used endpoint reverses correctly.
 */
export const updateFieldLineQuantity = async (
	visitId: string,
	lineItemId: string,
	quantity: number,
	orgId: string,
	context: UserContext,
): Promise<FieldLineResult> => {
	try {
		const sdb = getScopedDb(orgId);

		// Resolved through the scoped client first: job_visit_line_item has no org
		// column, so this is what makes a foreign visit a 404.
		const visit = await sdb.job_visit.findFirst({
			where: { id: visitId },
			select: { id: true, status: true, visit_techs: { select: { tech_id: true } } },
		});
		if (!visit) return { err: "Visit not found", code: "NOT_FOUND" };

		if (context.techId && !visit.visit_techs.some((vt) => vt.tech_id === context.techId)) {
			return { err: "You are not assigned to this visit", code: "FORBIDDEN" };
		}
		if (FROZEN_VISIT_STATUSES.has(visit.status)) {
			return { err: `Lines can't be changed on a ${visit.status} visit`, code: "WRONG_STATE" };
		}

		const oldQuantity = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;

			// Lock first so two concurrent edits can't both compute from the same row.
			await txc.$queryRaw`SELECT id FROM job_visit_line_item WHERE id = ${lineItemId} FOR UPDATE`;

			const line = await tx.job_visit_line_item.findFirst({
				where: { id: lineItemId, visit_id: visitId },
			});
			if (!line) throw new FieldLineRefusal("Line item not found", "NOT_FOUND");
			if (line.fulfillment_status === "used") {
				throw new FieldLineRefusal("Use the parts endpoint for stock lines", "WRONG_STATE");
			}

			if (line.fulfillment_status === "voided") {
				throw new FieldLineRefusal("A voided line can't be changed", "WRONG_STATE");
			}

			if (quantity <= 0) {
				await tx.job_visit_line_item.delete({ where: { id: lineItemId } });
			} else {
				await tx.job_visit_line_item.update({
					where: { id: lineItemId },
					data: {
						quantity,
						total: Math.round(Number(line.unit_price) * quantity * 100) / 100,
						// Same rule as the visit PUT: planned follows the quantity.
						...(line.fulfillment_status === "planned" ? { qty_planned: quantity } : {}),
					},
				});
			}

			await recomputeVisitTotals(visitId, orgId, txc);
			return Number(line.quantity);
		});

		await logActivity({
			event_type: "job_visit.line_quantity_changed",
			action: "updated",
			entity_type: "job_visit_line_item",
			entity_id: lineItemId,
			organization_id: orgId,
			actor_type: context.techId ? "technician" : context.dispatcherId ? "dispatcher" : "system",
			actor_id: context.techId || context.dispatcherId,
			ip_address: context.ipAddress,
			user_agent: context.userAgent,
			changes: { quantity: { old: oldQuantity, new: quantity } },
		});

		const item = await sdb.job_visit.findFirst({
			where: { id: visitId },
			include: {
				visit_techs: { include: { tech: true } },
				line_items: { orderBy: { sort_order: "asc" } },
			},
		});
		return { err: "", item };
	} catch (e) {
		if (e instanceof FieldLineRefusal) return { err: e.message, code: e.code };
		log.error({ err: e }, "Failed to update field line quantity");
		return { err: "Failed to update line quantity" };
	}
};
