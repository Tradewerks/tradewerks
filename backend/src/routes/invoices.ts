import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router } from 'express';
import { ZodError } from 'zod';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import { getUserContext, getScopedDb } from '../lib/context.js';
import { hasPermission, requirePermission, requirePermissionForBody } from '../lib/requirePermissions.js';
import { acknowledgeTaxReviewRoute } from './tax.js';
import { logActivity } from '../services/logger.js';
import * as invoicesController from '../controllers/invoicesController.js';
import { createInvoiceRecord } from '../services/invoiceService.js';
import { generateInvoicePdf } from '../lib/pdf/pdfService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import { isSendFailure } from '../services/emailErrors.js';
import { onInvoiceSent } from '../services/followupTriggers.js';
import { buildVisitInvoicePayload, buildRecurringPlanInvoicePayload } from '../services/invoiceGenerator.js';
import { overlapCheckSchema, generateInvoiceSchema, createRefundSchema } from '../lib/validate/invoices.js';
import { advanceNextInvoiceAt, calculateNextInvoiceAt, type ScheduleFrequency } from '../lib/invoiceSchedule.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
    assertValidInvoiceTransition,
    InvalidTransitionError,
    isInvoiceFinalizingTransition,
} from '../lib/statusTransitions.js';
import { getEntityHistory, parseHistoryLimit, INVALID_HISTORY_LIMIT } from '../controllers/logsController.js';
import {
    disputeErrorResponse,
    listDisputes,
    postDispute,
    postResolution,
} from '../controllers/disputesController.js';

const router = Router();

type TaxRefusal = invoicesController.QbTaxReviewRefusal | invoicesController.QbTaxZeroRefusal;
const isTaxRefusal = (result: object): result is TaxRefusal =>
    invoicesController.isQbTaxReviewRefusal(result) ||
    invoicesController.isQbTaxZeroRefusal(result);
const taxRefusalResponse = (refusal: TaxRefusal) =>
    createErrorResponse(refusal.code, refusal.err, refusal.details);

router.get("/", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const invoices = await invoicesController.getAllInvoices(orgId);
        res.json(createSuccessResponse(invoices, { count: invoices.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const invoice = await invoicesController.getInvoiceDetail(id, orgId);
        if (!invoice)
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Invoice not found",
                    ),
                );
        res.json(createSuccessResponse(invoice));
    } catch (err) {
        next(err);
    }
});

router.get("/:id/pdf", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const buffer = await generateInvoicePdf(id, orgId);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="invoice-${id}.pdf"`,
        );
        res.send(buffer);
    } catch (err: any) {
        if (err?.status === 404)
            return res
                .status(404)
                .json(createErrorResponse(ErrorCodes.NOT_FOUND, "Invoice not found"));
        next(err);
    }
});




router.post("/:id/send", requirePermission("send_invoices"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const recipientEmail: string | undefined = req.body?.recipient_email;
        if (!recipientEmail) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "recipient_email is required"));
        }

        const orgId = req.user!.organization_id as string;

        // Guard BEFORE the email, exactly as POST /quotes/:id/send does. The
        // status update below would reject an illegal move — INVOICE_TRANSITIONS
        // has no edge to Sent from Viewed, PartiallyPaid, Paid or Void — but by
        // then the client already has it in their inbox and the invoice is left
        // sitting in its old status.
        const existing = await invoicesController.getInvoiceById(id, orgId);
        if (!existing) {
            return res
                .status(404)
                .json(createErrorResponse(ErrorCodes.NOT_FOUND, "Invoice not found"));
        }
        try {
            assertValidInvoiceTransition(existing.status, "Sent");
        } catch (e) {
            if (e instanceof InvalidTransitionError) {
                return res
                    .status(422)
                    .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, e.message));
            }
            throw e;
        }

        // A re-send of an already finalized invoice is not a finalize and must not re-push.
        const finalizing = isInvoiceFinalizingTransition(existing.status, "Sent");
        const context = getUserContext(req);
        if (finalizing) {
            const refusal = await invoicesController.qbTaxFinalizeRefusal(id, orgId);
            if (refusal) return res.status(409).json(taxRefusalResponse(refusal));
            // Finalize through Issued before emailing, so every lock-time check has passed
            // and the PDF is the locked, dated document. A failed email then leaves it
            // Issued, ready to re-send, instead of delivered but still a draft.
            const issued = await invoicesController.updateInvoice(
                { params: { id }, body: { status: "Issued" } } as any,
                orgId,
                context,
                { qbTaxConfirmed: true },
            );
            if (isTaxRefusal(issued)) return res.status(409).json(taxRefusalResponse(issued));
            if (issued.err) {
                const status = issued.err.includes("not found") ? 404 : 400;
                return res
                    .status(status)
                    .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, issued.err));
            }
        }

        try {
            await sendInvoiceEmail(id, recipientEmail, orgId);
        } catch (e: unknown) {
            // A missing document is not a delivery failure. Let the outer
            // handler answer it as a 404 rather than restating it as an email
            // problem.
            if (!isSendFailure(e) && (e as { status?: number })?.status === 404) throw e;
            // Only a translated failure carries a message written for the
            // caller. A PDF render throw or a Prisma error reaches here with
            // text that was never meant to leave the server, so it is recorded
            // and answered generically.
            const failure = isSendFailure(e) ? e : null;
            // logActivity swallows its own errors, so this await cannot
            // displace the response below.
            // An invoice the client never received must not age on the
            // receivables board as Sent, and onInvoiceSent below must not start
            // dunning against a delivery that did not happen.
            await logActivity({
                event_type: "invoice.send_failed",
                action: "sent",
                entity_type: "invoice",
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
                        (finalizing ? "The invoice was created, but the email was not sent. " : "") +
                            (failure?.message ?? "Email could not be sent."),
                    ),
                );
        }
        const result = await invoicesController.updateInvoice(
            { params: { id }, body: { status: "Sent" } } as any,
            orgId,
            context,
        );
        if (isTaxRefusal(result)) return res.status(409).json(taxRefusalResponse(result));
        if (result.err) {
            const status = result.err.includes("not found") ? 404 : 400;
            return res
                .status(status)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        // Best-effort: auto-enroll into any active invoice_sent followup sequences.
        onInvoiceSent(id, orgId);
        res.json(createSuccessResponse(result.item));
    } catch (err: any) {
        if (err?.status === 404)
            return res
                .status(404)
                .json(createErrorResponse(ErrorCodes.NOT_FOUND, err.message));
        next(err);
    }
});

// ── Pipeline: overlap check ───────────────────────────────────────────────────

router.post("/overlap-check", requirePermission("create_invoices"), async (req, res, next) => {
    try {
        const { visit_ids } = overlapCheckSchema.parse(req.body);
        const orgId = req.user!.organization_id as string;
        const sdb = getScopedDb(orgId);
        const { warnings } = await buildVisitInvoicePayload(visit_ids, sdb);
        res.json(createSuccessResponse({ warnings }));
    } catch (err) {
        if (err instanceof ZodError)
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, err.issues[0].message));
        if (err instanceof Error && err.message.includes("same client"))
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, err.message));
        next(err);
    }
});

// ── Pipeline: generate invoice from recurring plan ────────────────────────────

router.post("/generate", requireModule("recurring_plans"), requirePermission("create_invoices"), async (req, res, next) => {
    try {
        const parsed = generateInvoiceSchema.parse(req.body);
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const sdb = getScopedDb(orgId);

        // Read schedule first — both the payload builder and the CAS guard must
        // use the same last_invoiced_at snapshot to prevent stale-scope bypass.
        const schedule = await sdb.invoice_schedule.findFirst({ where: { recurring_plan_id: parsed.plan_id } });

        const { payload, warnings } = await buildRecurringPlanInvoicePayload(
            parsed.plan_id,
            sdb,
            schedule ? { last_invoiced_at: schedule.last_invoiced_at } : undefined,
        );
        if (parsed.memo) payload.memo = parsed.memo;
        if (parsed.payment_terms_days != null) payload.payment_terms_days = parsed.payment_terms_days;

        // Retry loop guards against invoice_number unique-constraint collision
        // on concurrent requests. CAS guard inside the transaction prevents
        // double-invoice on the same plan.
        let inv;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                inv = await sdb.$transaction(async (tx) => {
                    const created = await createInvoiceRecord(payload, orgId, context.dispatcherId, tx as unknown as Prisma.TransactionClient);
                    if (schedule && schedule.frequency !== "on_visit_completion") {
                        // Advance from the scheduled anchor date so a late run
                        // doesn't skip billing periods (advanceNextInvoiceAt vs
                        // calculateNextInvoiceAt which defaults from=now).
                        const nextInvoiceAt = schedule.next_invoice_at
                            ? advanceNextInvoiceAt(
                                schedule.frequency as ScheduleFrequency,
                                schedule.day_of_month ?? null,
                                schedule.day_of_week ?? null,
                                schedule.generate_days_before ?? 0,
                                schedule.next_invoice_at,
                            )
                            : calculateNextInvoiceAt(
                                schedule.frequency as ScheduleFrequency,
                                schedule.day_of_month ?? null,
                                schedule.day_of_week ?? null,
                                schedule.generate_days_before ?? 0,
                            );
                        const updateResult = await tx.invoice_schedule.updateMany({
                            where: {
                                id: schedule.id,
                                last_invoiced_at: schedule.last_invoiced_at,
                            },
                            data: { last_invoiced_at: new Date(), next_invoice_at: nextInvoiceAt },
                        });
                        if (updateResult.count === 0) {
                            throw new Error("Invoice generation already in progress for this plan — try again");
                        }
                    }
                    return created;
                });
                break;
            } catch (e) {
                if (
                    attempt < 4 &&
                    e instanceof Prisma.PrismaClientKnownRequestError &&
                    e.code === "P2002" &&
                    (e.meta?.target as string[] | undefined)?.includes("invoice_number")
                ) {
                    continue;
                }
                throw e;
            }
        }

        if (!inv) throw new Error("Invoice creation failed");

        await logActivity({
            event_type: "invoice.created",
            action: "created",
            entity_type: "invoice",
            entity_id: inv.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: context.dispatcherId ?? null,
            changes: {
                invoice_number: { old: null, new: inv.invoice_number },
                client_id: { old: null, new: inv.client_id },
                total: { old: null, new: inv.total },
                status: { old: null, new: inv.status },
                recurring_plan_id: { old: null, new: inv.recurring_plan_id ?? null },
            },
            ip_address: context.ipAddress,
            user_agent: context.userAgent,
        });

        res.status(201).json(createSuccessResponse({ invoice: inv, warnings }));
    } catch (err) {
        if (err instanceof ZodError)
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, err.issues[0].message));
        if (err instanceof Error && err.message.startsWith("Invoice generation already in progress"))
            return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, err.message));
        next(err);
    }
});

router.post("/", requirePermission("create_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.insertInvoice(req, orgId, context);
        if (result.err)
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// Voiding is cash out, and it arrives on the same PATCH that renames a memo —
// so the gate reads what the body is asking for rather than the path.
const requireVoidPermission = requirePermissionForBody(
    "refund_invoices",
    (body) => (body as { status?: string } | undefined)?.status === "Void",
);

router.patch("/:id", requirePermission("edit_invoices"), requireVoidPermission, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.updateInvoice(req, orgId, context, {
            canAckQbTaxReview: hasPermission(req, "send_invoices"),
        });
        if (isTaxRefusal(result)) return res.status(409).json(taxRefusalResponse(result));
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
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post(
	"/:id/tax-review/acknowledge",
	requirePermission("send_invoices"),
	acknowledgeTaxReviewRoute("invoice"),
);

router.delete("/:id", requirePermission("delete_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.deleteInvoice(
            req.params.id as string,
            orgId,
            context,
        );
        if (result.err) {
            const status = result.err.includes("not found") ? 404 : 400;
            return res
                .status(status)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }
        res.status(200).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ── Payments ─────────────────────────────────────────────────────────────────

router.get("/:invoiceId/payments", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const payments = await invoicesController.getInvoicePayments(
            req.params.invoiceId as string, req.user!.organization_id as string,
        );
        res.json(createSuccessResponse(payments, { count: payments.length }));
    } catch (err) {
        next(err);
    }
});

router.post("/:invoiceId/payments", requirePermission("edit_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.insertInvoicePayment(
            req.params.invoiceId as string,
            req.body,
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
        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// Deleting a payment row reverses recorded cash and re-syncs the invoice
// totals — a payment void by another name, so it sits with the refunds.
router.delete(
    "/:invoiceId/payments/:paymentId",
    requirePermission("refund_invoices"),
    async (req, res, next) => {
        try {
            const orgId = req.user!.organization_id as string;
            const context = getUserContext(req);
            const result = await invoicesController.deleteInvoicePayment(
                req.params.invoiceId as string,
                req.params.paymentId as string,
                orgId,
                context,
            );
            if (result.err) {
                const status = result.err.includes("not found") ? 404 : 400;
                return res
                    .status(status)
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

router.post("/:invoiceId/refunds", requirePermission("refund_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const parsed = createRefundSchema.parse(req.body);
        const result = await invoicesController.recordRefund(
            req.params.invoiceId as string,
            parsed,
            orgId,
            context,
        );
        if (result.err) {
            const status = result.err.includes("not found") ? 404 : 422;
            return res
                .status(status)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        result.err,
                    ),
                );
        }
        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        if (err instanceof ZodError) {
            return res
                .status(422)
                .json(
                    createErrorResponse(
                        ErrorCodes.VALIDATION_ERROR,
                        err.issues[0]?.message ?? "Invalid request",
                    ),
                );
        }
        next(err);
    }
});

// ── Disputes ─────────────────────────────────────────────────────────────────

router.get("/:invoiceId/disputes", requireModule("disputes"), requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const invoiceId = req.params.invoiceId as string;
        const list = await listDisputes("invoice", invoiceId, req);
        res.json(createSuccessResponse(list, { count: list.disputes.length }));
    } catch (err) {
        next(err);
    }
});

// view_invoices ahead of the dispute grant: both doors' refusals can echo the
// document's status and amount_paid (DW-65), and open_disputes/resolve_disputes
// alone say nothing about whether this caller may see that.
router.post("/:invoiceId/disputes", requireModule("disputes"), requirePermission("view_invoices"), requirePermission("open_disputes"), async (req, res, next) => {
    try {
        const invoiceId = req.params.invoiceId as string;
        const result = await postDispute("invoice", invoiceId, req);
        if (result && "err" in result) {
            const refusal = disputeErrorResponse(result);
            return res.status(refusal.status).json(refusal.body);
        }
        res.status(201).json(createSuccessResponse(result));
    } catch (err) {
        next(err);
    }
});

router.post(
    "/:invoiceId/disputes/:disputeId/resolve",
    requireModule("disputes"),
    requirePermission("view_invoices"),
    requirePermission("resolve_disputes"),
    async (req, res, next) => {
        try {
            const invoiceId = req.params.invoiceId as string;
            const disputeId = req.params.disputeId as string;
            const result = await postResolution("invoice", invoiceId, disputeId, req);
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

// ── Notes ─────────────────────────────────────────────────────────────────────

router.get("/:invoiceId/notes", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const notes = await invoicesController.getInvoiceNotes(
            req.params.invoiceId as string,
            orgId,
        );
        res.json(createSuccessResponse(notes, { count: notes.length }));
    } catch (err) {
        next(err);
    }
});

router.post("/:invoiceId/notes", requirePermission("edit_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.insertInvoiceNote(
            req.params.invoiceId as string,
            req.body,
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
        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:invoiceId/notes/:noteId", requirePermission("edit_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.updateInvoiceNote(
            req.params.invoiceId as string,
            req.params.noteId as string,
            req.body,
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
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/:invoiceId/notes/:noteId", requirePermission("edit_invoices"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await invoicesController.deleteInvoiceNote(
            req.params.invoiceId as string,
            req.params.noteId as string,
            orgId,
            context,
        );
        if (result.err) {
            const status = result.err.includes("not found") ? 404 : 400;
            return res
                .status(status)
                .json(createErrorResponse(ErrorCodes.DELETE_ERROR, result.err));
        }
        res.status(200).json(
            createSuccessResponse({ message: result.message }),
        );
    } catch (err) {
        next(err);
    }
});

router.get("/:invoiceId/changes", requirePermission("view_invoices"), async (req, res, next) => {
    try {
        const invoiceId = req.params.invoiceId as string;
        const orgId = req.user!.organization_id as string;
        let limit: number;
        try {
            limit = parseHistoryLimit(req.query.limit);
        } catch {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
        }

        const results = await getEntityHistory(orgId, "invoice", invoiceId, limit);

        if (results.err) {
            return res
                .status(500)
                .json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));
        }

        res.json(createSuccessResponse(results.rows, {
            count: results.rows.length,
            hasMore: results.hasMore,
            total: results.total,
        }));
    } catch (err) {
        next(err);
    }
});


export default router;
