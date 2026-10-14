import { Router, type Request, type RequestHandler, type Response } from "express";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import { getUserContext } from "../lib/context.js";
import { receiptUpload } from "../lib/upload.js";
import {
	listGrants,
	upsertGrant,
	revokeGrant,
	getMyGrant,
	requestGrant,
	checkPurchaseLimit,
	listPurchases,
	getPurchasesSummary,
	createPurchase,
	getPurchase,
	getPurchaseExtraction,
	getCaptureLocation,
	deletePurchase,
	uploadReceipt,
	retryOcr,
	requestPreauth,
	decidePreauth,
	submitPurchase,
	reviewPurchase,
	assignLineJob,
	linkSupplier,
	secondSignoff,
	createRefund,
	settleRefund,
	SCANS_USED_UP,
} from "../controllers/fieldPurchasesController.js";
import { requirePermission, requireAnyPermission } from "../lib/requirePermissions.js";

const router = Router();

// Same mapping as routes/suppliers.ts, plus a 403 branch: these paths refuse on
// ownership and separation-of-duties as often as they refuse on payload. The
// three prefixes below are reserved for exactly that — a refusal about the
// caller's authority. A refusal about the row's state is a 400 and must not be
// worded to match them.
function sendControllerErr(res: Response, err: string) {
	// Same status and code as the AI meter, so a client can tell "used up" from a bad request.
	if (err === SCANS_USED_UP)
		return res.status(429).json(createErrorResponse(ErrorCodes.QUOTA_EXCEEDED, err));
	const notFound = err.includes("not found");
	const forbidden =
		err.startsWith("You can only") || err.startsWith("You cannot") || err.startsWith("Only a");
	const status = notFound ? 404 : forbidden ? 403 : 400;
	return res
		.status(status)
		.json(
			createErrorResponse(
				notFound
					? ErrorCodes.NOT_FOUND
					: forbidden
						? ErrorCodes.INVALID_CREDENTIALS
						: ErrorCodes.VALIDATION_ERROR,
				err,
			),
		);
}

const orgOf = (req: { user?: { organization_id?: unknown } }) => req.user!.organization_id as string;
const idOf = (req: Request) => req.params.id as string;
const uidOf = (req: Request) => req.user!.uid as string;

type Result<T> = { err?: string } & Partial<T>;

/**
 * Every handler runs the same three steps - call the controller, map a message-shaped
 * refusal onto a status, wrap the rest - so each route below only describes its
 * success body.
 */
function route<T extends object>(
	run: (req: Request) => Promise<Result<T>>,
	send: (res: Response, result: Result<T>) => void,
): RequestHandler {
	return async (req, res, next) => {
		try {
			const result = await run(req);
			if (result.err) return sendControllerErr(res, result.err);
			send(res, result);
		} catch (err) {
			next(err);
		}
	};
}

/** The common case: one wrapped entity, 200 unless the route created something. */
const one =
	<T extends object>(pick: (r: Result<T>) => unknown, status = 200) =>
	(res: Response, result: Result<T>) => {
		res.status(status).json(createSuccessResponse(pick(result)));
	};

// ── Grants (finance/admin) ───────────────────────────────────────────────────

router.get(
	"/grants",
	requirePermission("manage_field_purchase_grants"),
	route(
		(req) => listGrants(orgOf(req)),
		(res, r) => res.json(createSuccessResponse(r.grants, { count: r.grants!.length })),
	),
);

router.post(
	"/grants",
	requirePermission("manage_field_purchase_grants"),
	route((req) => upsertGrant(orgOf(req), req.body, getUserContext(req)), one((r) => r.grant, 201)),
);

router.post(
	"/grants/:id/revoke",
	requirePermission("manage_field_purchase_grants"),
	route(
		(req) => revokeGrant(orgOf(req), idOf(req), req.body, getUserContext(req)),
		one((r) => r.grant),
	),
);

// ── Technician pre-flight ────────────────────────────────────────────────────

// Authority to buy is per-technician, so both of these answer only for the
// caller — there is no id parameter to point at somebody else's ceiling.
router.get(
	"/my-grant",
	requirePermission("request_field_purchase"),
	route(
		(req) => getMyGrant(orgOf(req), uidOf(req)),
		one((r) => ({ grant: r.grant, spent: r.spent })),
	),
);

// Reaching the flow is the permission; the ceiling is the grant. This is for the
// technician who holds the first and not the second.
router.post(
	"/my-grant/request",
	requirePermission("request_field_purchase"),
	route(
		(req) => requestGrant(orgOf(req), uidOf(req), getUserContext(req)),
		one((r) => ({ requested: r.requested })),
	),
);

// POST for a body, not because it writes: a split receipt asks about the whole
// total and every job's share at once, which is more than a query string carries.
router.post(
	"/limit-check",
	requirePermission("request_field_purchase"),
	route(
		(req) => checkPurchaseLimit(orgOf(req), uidOf(req), req.body),
		one((r) => ({ verdict: r.verdict, spent: r.spent })),
	),
);

// ── Purchases ────────────────────────────────────────────────────────────────

router.get(
	"/",
	requireAnyPermission("request_field_purchase", "view_field_purchases"),
	route(
		(req) => listPurchases(orgOf(req), req.query, getUserContext(req)),
		(res, r) =>
			res.json(
				createSuccessResponse(r.purchases, {
					count: r.purchases!.length,
					total: r.total,
					// Against the offset, not the page size: comparing a page to the
					// row count reported "more" forever on the last page.
					hasMore: r.offset! + r.purchases!.length < r.total!,
				}),
			),
	),
);

// Above `/:id` on purpose: a param route would swallow the literal path.
router.get(
	"/summary",
	requireAnyPermission("request_field_purchase", "view_field_purchases"),
	route(
		(req) => getPurchasesSummary(orgOf(req), getUserContext(req)),
		one((r) => r.summary),
	),
);

router.post(
	"/",
	requirePermission("request_field_purchase"),
	route(
		(req) => createPurchase(orgOf(req), uidOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase, 201),
	),
);

router.get(
	"/:id",
	requireAnyPermission("request_field_purchase", "view_field_purchases"),
	route(
		(req) => getPurchase(orgOf(req), idOf(req), getUserContext(req)),
		one((r) => ({ purchase: r.purchase, events: r.events })),
	),
);

router.delete(
	"/:id",
	requirePermission("request_field_purchase"),
	route(
		(req) => deletePurchase(orgOf(req), idOf(req), getUserContext(req)),
		one(() => ({ deleted: true })),
	),
);

// multipart: the image plus the capture metadata the browser collected at
// capture time (device clock, best-effort geolocation).
router.post(
	"/:id/receipt",
	requirePermission("request_field_purchase"),
	receiptUpload.single("image"),
	route(
		(req) => uploadReceipt(orgOf(req), idOf(req), req.file, req.body, getUserContext(req)),
		one((r) => r.purchase),
	),
);

// What the receipt itself read, which is not the same thing as what the purchase
// now holds: extraction never overwrites a technician's own value, so the reading
// it stood down for only survives here. Its own request because the snapshot and
// the provider payload are too heavy for the projection the list shares.
router.get(
	"/:id/extraction",
	requireAnyPermission("request_field_purchase", "view_field_purchases"),
	route(
		(req) => getPurchaseExtraction(orgOf(req), idOf(req), getUserContext(req)),
		one((r) => r.extraction),
	),
);

// Its own permission, and its own request, because the coordinates are the one
// piece of a purchase that is sensitive personal information about the technician
// rather than a record of the spend. Every other read gets `has_geo` and stops
// there; a reviewer comparing the position against the vendor asks for this.
router.get(
	"/:id/capture-location",
	requirePermission("view_field_purchase_location"),
	route(
		(req) => getCaptureLocation(orgOf(req), idOf(req), getUserContext(req)),
		one((r) => r.location),
	),
);

// Re-reads the stored image rather than asking for a fresh photo, which would
// change the receipt hash the duplicate guard depends on.
router.post(
	"/:id/ocr/retry",
	requirePermission("request_field_purchase"),
	route(
		(req) => retryOcr(orgOf(req), idOf(req), getUserContext(req)),
		one(() => ({ started: true })),
	),
);

router.post(
	"/:id/preauth",
	requirePermission("request_field_purchase"),
	route(
		(req) => requestPreauth(orgOf(req), idOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase),
	),
);

router.post(
	"/:id/preauth-decision",
	requirePermission("review_field_purchases"),
	route(
		(req) => decidePreauth(orgOf(req), idOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase),
	),
);

router.post(
	"/:id/submit",
	requirePermission("request_field_purchase"),
	route(
		// The body carries the sheet the technician is looking at. Empty is valid —
		// a purchase already saved field by field submits with nothing to apply.
		(req) => submitPurchase(orgOf(req), idOf(req), getUserContext(req), req.body),
		one((r) => ({ purchase: r.purchase, flags: r.flags })),
	),
);

// The purchaser is never the approver, so this gate is deliberately a
// dispatcher-only permission rather than one a senior tech could hold.
router.post(
	"/:id/review",
	requirePermission("review_field_purchases"),
	route(
		(req) => reviewPurchase(orgOf(req), idOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase),
	),
);

// The technician says which job a line was for at the counter; a reviewer who
// knows better corrects it here, and the charge moves rather than being left on
// the wrong invoice for somebody to notice.
router.patch(
	"/:id/lines/:lineId/job",
	requirePermission("review_field_purchases"),
	route(
		(req) =>
			assignLineJob(
				orgOf(req),
				idOf(req),
				req.params.lineId as string,
				req.body,
				getUserContext(req),
			),
		one((r) => r.purchase),
	),
);

router.patch(
	"/:id/supplier",
	requirePermission("review_field_purchases"),
	route(
		(req) => linkSupplier(orgOf(req), idOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase),
	),
);

// The refund is raised by the technician who made the purchase; settling it is
// a dispatcher act, because it asserts the money actually came back.
router.post(
	"/refunds",
	requirePermission("request_field_purchase"),
	route(
		(req) => createRefund(orgOf(req), uidOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase, 201),
	),
);

router.post(
	"/:id/settle",
	requirePermission("review_field_purchases"),
	route(
		(req) => settleRefund(orgOf(req), idOf(req), getUserContext(req)),
		one((r) => r.purchase),
	),
);

// A distinct permission from review: the whole point is that the person holding
// it is not the person who approved.
router.post(
	"/:id/second-signoff",
	requirePermission("second_sign_off_field_purchases"),
	route(
		(req) => secondSignoff(orgOf(req), idOf(req), req.body, getUserContext(req)),
		one((r) => r.purchase),
	),
);

export default router;
