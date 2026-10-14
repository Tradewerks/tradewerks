import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { getScopedDb, getUserContext } from "../lib/context.js";
import {
	DocumentRuleError,
	InvalidTransitionError,
} from "../lib/statusTransitions.js";
import { ErrorCodes, createErrorResponse, createSuccessResponse } from "../types/responses.js";
import {
	openDisputeSchema,
	openDisputesQuerySchema,
	resolveDisputeSchema,
} from "../lib/validate/disputes.js";
import {
	listDisputesWithOutcomes,
	listOpenDisputes,
	OPEN_DISPUTE_EXISTS,
	openDispute,
	resolveDispute,
	type DisputeAccess,
} from "../services/disputeService.js";
import {
	canResolveDisputesFrom,
	disputeAuthzFrom,
	viewableDisputeKinds,
	type DisputeForbiddenReason,
} from "../lib/disputeAuthz.js";
import { requireAnyPermission } from "../lib/requirePermissions.js";
import type { DisputeKind } from "../services/disputeAdapters.js";
import { notifyDispatchers } from "./notificationsController.js";

/** Who is asking, read the same way by every dispute door. */
const accessFrom = (req: Request): DisputeAccess => ({
	authz: disputeAuthzFrom(req),
	canResolve: canResolveDisputesFrom(req),
	dispatcherId: getUserContext(req).dispatcherId,
});

export const listDisputes = async (kind: DisputeKind, documentId: string, req: Request) =>
	await listDisputesWithOutcomes(
		kind,
		documentId,
		req.user!.organization_id as string,
		accessFrom(req),
	);

export const getOpenDisputes = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const parsed = openDisputesQuerySchema.safeParse(req.query);
		if (!parsed.success) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						parsed.error.issues[0]?.message ?? "Invalid query",
					),
				);
		}
		const list = await listOpenDisputes(
			req.user!.organization_id as string,
			viewableDisputeKinds(req),
			accessFrom(req),
			parsed.data.client_id,
		);
		res.json(createSuccessResponse(list, { count: list.items.length }));
	} catch (err) {
		next(err);
	}
};

export const openDisputesRoute = [
	requireAnyPermission("view_quotes", "view_invoices"),
	getOpenDisputes,
];

/**
 * The dispute routes render `{ err }` as a 422 unless the service marked it a
 * conflict (see disputeErrorResponse). Both a schema failure and a status the
 * transition table refuses are the caller's problem, not a 500 — the document
 * can change (a mid-dispute cancel, say) between opening the modal and
 * submitting it, and the modal has to be able to show why.
 */
function toErr(
	e: unknown,
	door: "open" | "resolve",
): { err: string; conflict?: true } {
	if (e instanceof ZodError)
		return { err: e.issues[0]?.message ?? "Invalid request" };
	// A rule refusing the write — the over-credit ceiling, a void re-assert —
	// is the caller's answer, not a fault to page anyone about.
	if (e instanceof InvalidTransitionError || e instanceof DocumentRuleError)
		return { err: e.message };
	if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
		// The door, not the error's target metadata, says which index lost:
		// opening inserts exactly one uniquely indexed row, the dispute itself,
		// while resolving inserts no dispute row at all. The
		// dispute_one_open_per_{quote,invoice} partial indexes — not the
		// findFirst pre-check — are the real enforcement on the open door, so a
		// lost race there is the pre-check's refusal and the same 409.
		if (door === "open") {
			return { err: OPEN_DISPUTE_EXISTS, conflict: true };
		}
		// On the resolve door it is a replacement or adjustment losing a
		// number or lineage race; naming an open dispute would send the
		// dispatcher after the wrong fix.
		return {
			err: "Another change to this document landed at the same moment. Reload it and try again.",
			conflict: true,
		};
	}
	throw e;
}

export const postDispute = async (
	kind: DisputeKind,
	documentId: string,
	req: Request,
) => {
	try {
		const parsed = openDisputeSchema.parse(req.body);
		const organizationId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await openDispute(kind, documentId, parsed, organizationId, context);
		if (!("err" in result)) {
			notifyDispatchers({
				type: "dispute_opened",
				title: `Dispute opened on a ${kind}`,
				body: parsed.reason.slice(0, 200),
				actionUrl: `/dispatch/${kind}s/${documentId}`,
			}, organizationId, context.dispatcherId).catch(() => {});
		}
		return result;
	} catch (e) {
		return toErr(e, "open");
	}
};

export const postResolution = async (
	kind: DisputeKind,
	documentId: string,
	disputeId: string,
	req: Request,
) => {
	try {
		const parsed = resolveDisputeSchema.parse(req.body);
		const organizationId = req.user!.organization_id as string;
		// The route gate only proves this caller may resolve disputes. Every
		// refusal past it — the document's rules, the money-back grants,
		// separation of duties — is decided inside resolveDispute, in the one
		// order the dispute list reports.
		return await resolveDispute(
			kind,
			documentId,
			disputeId,
			parsed,
			organizationId,
			getUserContext(req),
			disputeAuthzFrom(req),
		);
	} catch (e) {
		return toErr(e, "resolve");
	}
};

/**
 * Spec 7.3 and 10 want a duplicate open dispute and a lost compare-and-swap as
 * 409; every other refusal stays 422. disputeService tags exactly those two
 * with `conflict: true`, so the mapping keys off the flag rather than the
 * message text — rewording the copy cannot silently downgrade the code.
 */
export function disputeErrorResponse(result: {
	err: string;
	conflict?: boolean;
	forbidden?: DisputeForbiddenReason;
}) {
	// An authority refusal is neither the caller’s input nor a race, so it
	// short-circuits both mappings below. Self-resolution gets its own code
	// because the UI answers it differently: hand the dispute to a colleague.
	if (result.forbidden) {
		return {
			status: 403,
			body: createErrorResponse(
				result.forbidden === "self_resolution"
					? ErrorCodes.SELF_RESOLUTION_FORBIDDEN
					: ErrorCodes.FORBIDDEN,
				result.err,
			),
		};
	}
	const isConflict = result.conflict === true;
	// A missing (or other-org) document is a 404 everywhere else in this API —
	// invoicesController and the quote routes both key off the same substring —
	// so the dispute routes must not be the one place it reads as a validation
	// failure the caller could fix by editing the body.
	const isMissing = !isConflict && result.err.includes("not found");
	if (isMissing) {
		return {
			status: 404,
			body: createErrorResponse(ErrorCodes.NOT_FOUND, result.err),
		};
	}
	return {
		status: isConflict ? 409 : 422,
		body: createErrorResponse(
			isConflict ? ErrorCodes.CONFLICT : ErrorCodes.VALIDATION_ERROR,
			result.err,
		),
	};
}
