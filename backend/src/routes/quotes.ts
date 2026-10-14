import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import {
	assertValidQuoteTransition,
	InvalidTransitionError,
} from "../lib/statusTransitions.js";
import { documentErrorResponse } from "../lib/documentErrorResponse.js";
import {
	getAllQuotes,
	getQuoteById,
	getQuoteDetail,
	insertQuote,
	updateQuote,
	deleteQuote,
	getQuoteItems,
	getQuoteItemById,
	insertQuoteItem,
	updateQuoteItem,
	deleteQuoteItem,
} from "../controllers/quotesController.js";
import { generateQuotePdf } from "../lib/pdf/pdfService.js";
import { sendQuoteEmail } from "../services/emailService.js";
import { isSendFailure } from "../services/emailErrors.js";
import { logActivity } from "../services/logger.js";
import { onQuoteSent } from "../services/followupTriggers.js";
import { getUserContext } from "../lib/context.js";
import * as quoteNotesController from "../controllers/quoteNotesController.js";
import { requirePermission } from "../lib/requirePermissions.js";
import {
	getEntityHistory,
	parseHistoryLimit,
	INVALID_HISTORY_LIMIT,
} from "../controllers/logsController.js";
import {
	disputeErrorResponse,
	listDisputes,
	postDispute,
	postResolution,
} from "../controllers/disputesController.js";
import { createQuoteRevision } from "../services/quoteRevision.js";

const router = Router();

router.get("/", requirePermission("view_quotes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const quotes = await getAllQuotes(orgId);
		res.json(createSuccessResponse(quotes, { count: quotes.length }));
	} catch (err) {
		next(err);
	}
});

router.get("/:id", requirePermission("view_quotes"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const quote = await getQuoteDetail(id, orgId);

		if (!quote) {
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Quote not found",
					),
				);
		}

		res.json(createSuccessResponse(quote));
	} catch (err) {
		next(err);
	}
});

router.get(
	"/:id/pdf",
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const id = req.params.id as string;
			const buffer = await generateQuotePdf(id, orgId);
			// changed routerlication to application - Max
			res.setHeader("Content-Type", "application/pdf");
			res.setHeader(
				"Content-Disposition",
				`attachment; filename="quote-${req.params.id}.pdf"`,
			);
			res.send(buffer);
		} catch (err: any) {
			if (err?.status === 404)
				return res
					.status(404)
					.json(
						createErrorResponse(
							ErrorCodes.NOT_FOUND,
							"Quote not found",
						),
					);
			next(err);
		}
	},
);

router.post(
	"/:id/send",
	requirePermission("send_quotes"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const recipientEmail: string | undefined =
				req.body?.recipient_email;
			if (!recipientEmail) {
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							"recipient_email is required",
						),
					);
			}

			const orgId = req.user!.organization_id as string;

			// Guard BEFORE the email. The status update below would reject an
			// illegal move (a disputed quote must not be re-sent), but by then
			// the client already has it in their inbox.
			const existing = await getQuoteById(id, orgId);
			if (!existing) {
				return res
					.status(404)
					.json(
						createErrorResponse(
							ErrorCodes.NOT_FOUND,
							"Quote not found",
						),
					);
			}
			try {
				assertValidQuoteTransition(existing.status, "Sent");
			} catch (e) {
				if (e instanceof InvalidTransitionError) {
					return res
						.status(422)
						.json(
							createErrorResponse(
								ErrorCodes.VALIDATION_ERROR,
								e.message,
							),
						);
				}
				throw e;
			}

			const context = getUserContext(req);
			try {
				await sendQuoteEmail(id, recipientEmail, orgId);
			} catch (e: unknown) {
				// A missing document is not a delivery failure. Let the outer
				// handler answer it as a 404 rather than restating it as an
				// email problem.
				if (!isSendFailure(e) && (e as { status?: number })?.status === 404)
					throw e;
				// Only a translated failure carries a message written for the
				// caller. A PDF render throw or a Prisma error reaches here with
				// text that was never meant to leave the server, so it is
				// recorded and answered generically.
				const failure = isSendFailure(e) ? e : null;
				// logActivity swallows its own errors, so this await cannot
				// displace the response below.
				// The status stays where it was. A quote the client never
				// received must not sit on the board as Sent, and the followup
				// enrollment below must not start chasing a reply to an email
				// that does not exist.
				await logActivity({
					event_type: "quote.send_failed",
					action: "sent",
					entity_type: "quote",
					entity_id: id,
					organization_id: orgId,
					actor_type: "dispatcher",
					actor_id: context.dispatcherId ?? null,
					reason:
						failure?.providerMessage ??
						(e instanceof Error ? e.message : undefined),
					changes: { recipient_email: { old: null, new: recipientEmail } },
					ip_address: context.ipAddress,
					user_agent: context.userAgent,
				});
				return res
					.status(failure?.status ?? 502)
					.json(
						createErrorResponse(
							failure?.code ?? ErrorCodes.EMAIL_SEND_FAILED,
							failure?.message ?? "Email could not be sent.",
						),
					);
			}
			const result = await updateQuote(
				{ params: { id }, body: { status: "Sent" } } as any,
				orgId,
				context,
			);
			if (result.err) {
				const status = result.err.includes("not found") ? 404 : 400;
				return res
					.status(status)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}
			// Best-effort: auto-enroll into any active quote_sent followup sequences.
			onQuoteSent(id, orgId);
			res.json(createSuccessResponse(result.item));
		} catch (err: any) {
			if (err?.status === 404)
				return res
					.status(404)
					.json(
						createErrorResponse(ErrorCodes.NOT_FOUND, err.message),
					);
			next(err);
		}
	},
);

router.post("/", requirePermission("create_quotes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await insertQuote(req, orgId, context);

		if (result.err) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						result.err,
					),
				);
		}

		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.put("/:id", requirePermission("edit_quotes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await updateQuote(req, orgId, context);

		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res
				.status(statusCode)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						result.err,
					),
				);
		}

		res.json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

router.delete(
	"/:id",
	requirePermission("delete_quotes"),
	async (req, res, next) => {
		try {
			const id = req.params.id as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await deleteQuote(id, orgId, context);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.DELETE_ERROR,
							result.err,
						),
					);
			}

			res.status(200).json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

// ============================================
// QUOTE LINE ITEM ROUTES
// ============================================

router.get(
	"/:quoteId/line-items",
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const orgId = req.user!.organization_id as string;
			const items = await getQuoteItems(quoteId, orgId);
			res.json(createSuccessResponse(items, { count: items.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:quoteId/line-items/:itemId",
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const { quoteId, itemId } = req.params as {
				quoteId: string;
				itemId: string;
			};
			const orgId = req.user!.organization_id as string;
			const item = await getQuoteItemById(quoteId, itemId, orgId);

			if (!item) {
				return res
					.status(404)
					.json(
						createErrorResponse(
							ErrorCodes.NOT_FOUND,
							"Line item not found",
						),
					);
			}

			res.json(createSuccessResponse(item));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:quoteId/line-items",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await insertQuoteItem(
				quoteId,
				req.body,
				orgId,
				context,
			);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}

			res.status(201).json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

router.put(
	"/:quoteId/line-items/:itemId",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const { quoteId, itemId } = req.params as {
				quoteId: string;
				itemId: string;
			};
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await updateQuoteItem(
				quoteId,
				itemId,
				req.body,
				orgId,
				context,
			);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}

			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

router.delete(
	"/:quoteId/line-items/:itemId",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const { quoteId, itemId } = req.params as {
				quoteId: string;
				itemId: string;
			};
			const context = getUserContext(req);
			const orgId = req.user!.organization_id as string;
			const result = await deleteQuoteItem(
				quoteId,
				itemId,
				orgId,
				context,
			);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.DELETE_ERROR,
							result.err,
						),
					);
			}

			res.status(200).json(
				createSuccessResponse({ message: result.message }),
			);
		} catch (err) {
			next(err);
		}
	},
);

// ============================================
// QUOTE NOTE ROUTES
// ============================================

router.get(
	"/:quoteId/notes",
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const orgId = req.user!.organization_id as string;
			const notes = await quoteNotesController.getQuoteNotes(
				quoteId,
				orgId,
			);
			res.json(createSuccessResponse(notes, { count: notes.length }));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:quoteId/notes/:noteId",
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const { quoteId, noteId } = req.params as {
				quoteId: string;
				noteId: string;
			};
			const orgId = req.user!.organization_id as string;
			const note = await quoteNotesController.getNoteById(
				quoteId,
				noteId,
				orgId,
			);

			if (!note) {
				return res
					.status(404)
					.json(
						createErrorResponse(
							ErrorCodes.NOT_FOUND,
							"Note not found",
						),
					);
			}

			res.json(createSuccessResponse(note));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:quoteId/notes",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await quoteNotesController.insertQuoteNote(
				quoteId,
				req.body,
				orgId,
				context,
			);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}

			res.status(201).json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

router.put(
	"/:quoteId/notes/:noteId",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const { quoteId, noteId } = req.params as {
				quoteId: string;
				noteId: string;
			};
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await quoteNotesController.updateQuoteNote(
				quoteId,
				noteId,
				req.body,
				orgId,
				context,
			);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}

			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

router.delete(
	"/:quoteId/notes/:noteId",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const { quoteId, noteId } = req.params as {
				quoteId: string;
				noteId: string;
			};
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await quoteNotesController.deleteQuoteNote(
				quoteId,
				noteId,
				orgId,
				context,
			);

			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 400;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.DELETE_ERROR,
							result.err,
						),
					);
			}

			res.status(200).json(
				createSuccessResponse({ message: result.message }),
			);
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/:quoteId/changes",
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const orgId = req.user!.organization_id as string;
			let limit: number;
			try {
				limit = parseHistoryLimit(req.query.limit);
			} catch {
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							INVALID_HISTORY_LIMIT,
						),
					);
			}

			const results = await getEntityHistory(
				orgId,
				"quote",
				quoteId,
				limit,
			);

			if (results.err) {
				return res
					.status(500)
					.json(
						createErrorResponse(
							ErrorCodes.SERVER_ERROR,
							results.err,
						),
					);
			}

			res.json(
				createSuccessResponse(results.rows, {
					count: results.rows.length,
					hasMore: results.hasMore,
					total: results.total,
				}),
			);
		} catch (err) {
			next(err);
		}
	},
);

// ============================================
// DISPUTE ROUTES
// ============================================

router.get(
	"/:quoteId/disputes",
	requireModule("disputes"),
	requirePermission("view_quotes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const list = await listDisputes("quote", quoteId, req);
			res.json(
				createSuccessResponse(list, { count: list.disputes.length }),
			);
		} catch (err) {
			next(err);
		}
	},
);

// view_quotes ahead of the dispute grant: both doors' refusals can echo the
// document's status and money figures (DW-65), and open_disputes/
// resolve_disputes alone say nothing about whether this caller may see that.
router.post(
	"/:quoteId/disputes",
	requireModule("disputes"),
	requirePermission("view_quotes"),
	requirePermission("open_disputes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const result = await postDispute("quote", quoteId, req);
			if (result && "err" in result) {
				const refusal = disputeErrorResponse(result);
				return res.status(refusal.status).json(refusal.body);
			}
			res.status(201).json(createSuccessResponse(result));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:quoteId/disputes/:disputeId/resolve",
	requireModule("disputes"),
	requirePermission("view_quotes"),
	requirePermission("resolve_disputes"),
	async (req, res, next) => {
		try {
			const quoteId = req.params.quoteId as string;
			const disputeId = req.params.disputeId as string;
			const result = await postResolution(
				"quote",
				quoteId,
				disputeId,
				req,
			);
			if (result && "err" in result) {
				const refusal = disputeErrorResponse(result);
				return res.status(refusal.status).json(refusal.body);
			}
			res.json(createSuccessResponse(result));
		} catch (err) {
			next(err);
		}
	},
);

// ============================================
// REJECT / CANCEL ROUTES
// ============================================

/**
 * Rejected means the client declined. Cancelled means we withdrew it.
 * The funnel counts both as lost, but they are different sales facts, so
 * they stay separate actions with separate reasons.
 */
router.post(
	"/:id/reject",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const reason =
				typeof req.body?.rejection_reason === "string"
					? req.body.rejection_reason.trim()
					: "";
			if (!reason) {
				return res
					.status(422)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							"A rejection reason is required",
						),
					);
			}
			// Shaped like the /send handler above: updateQuote reads only
			// params.id and body, and `as any` keeps the value inspectable
			// where `as never` would suppress every downstream error too.
			const result = await updateQuote(
				{
					params: { id: req.params.id as string },
					body: { status: "Rejected", rejection_reason: reason },
				} as any,
				orgId,
				context,
			);
			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 422;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}
			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:id/cancel",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const reason =
				typeof req.body?.reason === "string"
					? req.body.reason.trim()
					: "";
			if (!reason) {
				return res
					.status(422)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							"A cancellation reason is required",
						),
					);
			}
			const result = await updateQuote(
				{
					params: { id: req.params.id as string },
					body: { status: "Cancelled", rejection_reason: reason },
				} as any,
				orgId,
				context,
			);
			if (result.err) {
				const statusCode = result.err.includes("not found") ? 404 : 422;
				return res
					.status(statusCode)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							result.err,
						),
					);
			}
			res.json(createSuccessResponse(result.item));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/:id/revise",
	requirePermission("edit_quotes"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const context = getUserContext(req);
			const result = await createQuoteRevision(
				req.params.id as string,
				orgId,
				context,
			);
			if ("err" in result) {
				// Keyed on the service's flags, not the message text: a lost
				// race is a 409, a missing quote a 404, a rule refusal a 422.
				const { status, body } = documentErrorResponse(result);
				return res.status(status).json(body);
			}
			res.json(createSuccessResponse(result));
		} catch (err) {
			next(err);
		}
	},
);

export default router;
