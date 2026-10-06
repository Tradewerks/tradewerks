import { db } from "../../db.js";
import { registerBlocker } from "../../services/entitlementService.js";

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

const blocker =
	(
		count: (orgId: string) => Promise<number>,
		message: (n: number) => string,
	) =>
	async (orgId: string) => {
		const n = await count(orgId);
		return n > 0 ? { count: n, message: message(n) } : null;
	};

// Work that would be stranded half-finished if its module were switched off:
// the write routes close, so nobody could finish it.
export function registerEntitlementBlockers(): void {
	registerBlocker(
		"disputes",
		blocker(
			(orgId) =>
				db.document_dispute.count({
					where: { organization_id: orgId, status: "Open" },
				}),
			(n) =>
				`${plural(n, "open dispute")} must be resolved before Disputes can be turned off`,
		),
	);
	// Resolving a quote dispute goes through a quotes write route, so Quotes
	// cannot go off while one is open either.
	registerBlocker(
		"quotes",
		blocker(
			(orgId) =>
				db.document_dispute.count({
					where: {
						organization_id: orgId,
						status: "Open",
						quote_id: { not: null },
					},
				}),
			(n) =>
				`${plural(n, "open quote dispute")} must be resolved before Quotes can be turned off`,
		),
	);
	registerBlocker(
		"field_purchases",
		blocker(
			(orgId) =>
				db.field_purchase.count({
					where: {
						organization_id: orgId,
						OR: [
							{
								status: {
									in: [
										"pending_preauth",
										"pending_review",
										"pending_second_signoff",
										"preauth_approved",
										"queried",
									],
								},
							},
							{
								kind: "refund",
								status: "approved",
								refund_settled_at: null,
							},
						],
					},
				}),
			(n) =>
				`${plural(n, "field purchase")} must be finished before Field Purchases can be turned off`,
		),
	);
	registerBlocker(
		"purchasing",
		blocker(
			(orgId) =>
				db.purchase.count({
					where: {
						organization_id: orgId,
						status: { in: ["ordered", "partially_received"] },
					},
				}),
			(n) =>
				`${plural(n, "purchase")} not yet received; receive or cancel before turning Purchasing off`,
		),
	);
}
