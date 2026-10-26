import { getScopedDb, type UserContext } from "../lib/context.js";
import { logActivity } from "../services/logger.js";
import { readTaxSnapshot } from "../services/tax/snapshot.js";
import type { TaxResult } from "./taxController.js";

export type TaxReviewKind = "quote" | "job" | "invoice";

const SELECT = { id: true, tax_needs_review: true, tax_snapshot: true } as const;

/** A review never blocks sending; it is acknowledged, and the acknowledgment is audited. */
export async function acknowledgeTaxReview(
	kind: TaxReviewKind,
	id: string,
	orgId: string,
	context: UserContext,
): Promise<TaxResult<{ id: string; tax_review_ack_by: string; tax_review_ack_at: Date }>> {
	const sdb = getScopedDb(orgId);
	const doc =
		kind === "quote"
			? await sdb.quote.findFirst({ where: { id }, select: SELECT })
			: kind === "job"
				? await sdb.job.findFirst({ where: { id }, select: SELECT })
				: await sdb.invoice.findFirst({ where: { id }, select: SELECT });
	if (!doc) return { ok: false, code: "NOT_FOUND", message: `${kind} not found` };
	if (!doc.tax_needs_review) {
		return { ok: false, code: "CONFLICT", message: "This document has no tax review to acknowledge" };
	}
	const actorId = context.dispatcherId;
	if (!actorId) {
		return { ok: false, code: "VALIDATION", message: "Only office users can acknowledge a tax review" };
	}

	const data = { tax_review_ack_by: actorId, tax_review_ack_at: new Date() };
	if (kind === "quote") await sdb.quote.update({ where: { id }, data });
	else if (kind === "job") await sdb.job.update({ where: { id }, data });
	else await sdb.invoice.update({ where: { id }, data });

	const snap = readTaxSnapshot(doc.tax_snapshot);
	await logActivity({
		event_type: `${kind}.tax_review_acknowledged`,
		action: "acknowledged",
		entity_type: kind,
		entity_id: id,
		organization_id: orgId,
		actor_type: "dispatcher",
		actor_id: actorId,
		changes: { tax_review_ack_at: { old: null, new: data.tax_review_ack_at.toISOString() } },
		...(snap?.version === 2 && snap.review_reason ? { reason: snap.review_reason } : {}),
		ip_address: context.ipAddress,
		user_agent: context.userAgent,
	});

	return { ok: true, item: { id, ...data } };
}
