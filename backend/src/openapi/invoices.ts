import z from "zod";
import {
	createInvoiceSchema,
	updateInvoiceSchema,
	createInvoicePaymentSchema,
	createInvoiceNoteSchema,
	updateInvoiceNoteSchema,
	overlapCheckSchema,
	generateInvoiceSchema,
	createRefundSchema,
} from "../lib/validate/invoices.js";
import {
	openDisputeSchema,
	resolveDisputeSchema,
} from "../lib/validate/disputes.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	historyQuery,
	historyResponses,
	idName,
	json,
	moduleOff,
} from "./shared.js";
import { clientParams, noteAuthor, noteEditors } from "./clients.js";
import { deletedId, documentDispute } from "./requestsQuotes.js";
import { jobParams, jobVisitParams } from "./jobs.js";

// ===============================================================================================================================
// Invoices
// ===============================================================================================================================

const invoice = z
	.object({
		id: z.uuid(),
		invoice_number: z.string(),
		client_id: z.uuid(),
		status: z.enum([
			"Draft",
			"Issued",
			"Sent",
			"Viewed",
			"PartiallyPaid",
			"Paid",
			"Disputed",
			"Void",
		]),
		recurring_plan_id: z.uuid().nullable(),
		issue_date: z.iso.datetime().nullable(),
		due_date: z.iso.datetime().nullable(),
		payment_terms_days: z.number().int().nullable(),
		issued_at: z.iso.datetime().nullable(),
		sent_at: z.iso.datetime().nullable(),
		viewed_at: z.iso.datetime().nullable(),
		paid_at: z.iso.datetime().nullable(),
		voided_at: z.iso.datetime().nullable(),
		void_reason: z.string().nullable(),
		subtotal: decimal,
		tax_rate: decimal,
		tax_amount: decimal,
		discount_type: z.enum(["percent", "amount"]).nullable(),
		discount_value: decimal.nullable(),
		discount_amount: decimal.nullable(),
		total: decimal,
		amount_paid: decimal,
		balance_due: decimal,
		memo: z.string().nullable(),
		internal_notes: z.string().nullable(),
		qb_sync_status: z.enum(["not_synced", "synced", "failed"]),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.meta({ id: "Invoice" });

const invoicePayment = z
	.object({
		id: z.uuid(),
		invoice_id: z.uuid(),
		amount: decimal,
		paid_at: z.iso.datetime(),
		method: z.string().nullable(),
		note: z.string().nullable(),
		recorded_by_dispatcher_id: z.uuid().nullable(),
		recorded_by_tech_id: z.uuid().nullable(),
		created_at: z.iso.datetime(),
	})
	.meta({ id: "InvoicePayment" });

const invoiceNote = z
	.object({
		id: z.uuid(),
		invoice_id: z.uuid(),
		content: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
	})
	.meta({ id: "InvoiceNote" });

authed("get", "/invoices", "Invoices", "view_invoices", {
	summary: "List invoices",
	description:
		"Requires the `view_invoices` permission. Returns every invoice in the caller's organization, newest first, with its client and line items.",
	responses: {
		200: json(envelope(z.array(invoice)), "Invoices (empty array if none)"),
	},
});

authed("post", "/invoices", "Invoices", "create_invoices", {
	summary: "Create an invoice",
	description:
		"Requires the `create_invoices` permission. Created as a `Draft`; `invoice_number` is assigned by the server. Totals are recomputed from `line_items`.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createInvoiceSchema.meta({ id: "CreateInvoice" }),
					example: {
						client_id: "3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
						line_items: [
							{
								name: "Furnace tune-up",
								quantity: 1,
								unit_price: 149,
							},
						],
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(invoice), "Invoice created"),
		400: json(
			errorEnvelope,
			"Validation failed, or any other error, including client not found (`VALIDATION_ERROR`)",
		),
	},
});

authed(
	"patch",
	"/invoices/{id}",
	"Invoices",
	"edit_invoices",
	{
		summary: "Update an invoice",
		description:
			"Requires the `edit_invoices` permission; setting `status` to `Void` also requires `refund_invoices` and a `void_reason`. `line_items` replaces the whole list and is only accepted while the invoice is a draft.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateInvoiceSchema.meta({
							id: "UpdateInvoice",
						}),
						example: { memo: "Thanks for your business." },
					},
				},
			},
		},
		responses: {
			200: json(envelope(invoice), "Invoice updated"),
			400: json(
				errorEnvelope,
				"Validation failed, invoice is void, missing `void_reason`, invalid status change, open dispute, or line items locked (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Invoice or a line's tax group not found (`VALIDATION_ERROR`)",
			),
			409: json(
				errorEnvelope,
				"QuickBooks tax needs review or charged no tax; `error.details` holds the figures (`QB_TAX_REVIEW`, `QB_TAX_ZERO`)",
			),
		},
	},
	"Voiding also needs `refund_invoices`",
);

authed("post", "/invoices/{id}/send", "Invoices", "send_invoices", {
	summary: "Email an invoice",
	description:
		"Requires the `send_invoices` permission. A draft is finalized (`Issued`) before the email goes out, then marked `Sent`. Active `invoice_sent` follow-up sequences enroll the client automatically.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: z
						.object({ recipient_email: z.string() })
						.meta({ id: "SendInvoice" }),
					example: { recipient_email: "billing@acme.example" },
				},
			},
		},
	},
	responses: {
		200: json(envelope(invoice), "Invoice sent"),
		400: json(
			errorEnvelope,
			"`recipient_email` missing, or finalizing failed (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Invoice not found (`NOT_FOUND`)"),
		409: json(
			errorEnvelope,
			"QuickBooks tax needs review or charged no tax (`QB_TAX_REVIEW`, `QB_TAX_ZERO`)",
		),
		422: json(
			errorEnvelope,
			"Invoice can't move to `Sent` from its status (`VALIDATION_ERROR`), or the address was rejected (`EMAIL_RECIPIENT_REJECTED`)",
		),
		502: json(
			errorEnvelope,
			"Email could not be sent (`EMAIL_SEND_FAILED`)",
		),
	},
});

authed("post", "/invoices/{id}/payments", "Invoices", "edit_invoices", {
	summary: "Record a payment",
	description:
		"Requires the `edit_invoices` permission. Updates the invoice's `amount_paid`, `balance_due` and status. `paid_at` defaults to now.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: createInvoicePaymentSchema.meta({
						id: "CreateInvoicePayment",
					}),
					example: { amount: 149, method: "card" },
				},
			},
		},
	},
	responses: {
		201: json(envelope(invoicePayment), "Payment recorded"),
		400: json(
			errorEnvelope,
			"Validation failed, invoice is a draft or void, or payment would exceed the total (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Invoice not found (`VALIDATION_ERROR`)"),
	},
});

authed("post", "/invoices/{id}/notes", "Invoices", "edit_invoices", {
	summary: "Add a note to an invoice",
	description:
		"Requires the `edit_invoices` permission. The author is the caller, taken from the token.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: createInvoiceNoteSchema.meta({
						id: "CreateInvoiceNote",
					}),
					example: { content: "Client asked for net 30." },
				},
			},
		},
	},
	responses: {
		201: json(envelope(invoiceNote), "Note created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(errorEnvelope, "Invoice not found (`VALIDATION_ERROR`)"),
	},
});

authed("get", "/invoices/{id}", "Invoices", "view_invoices", {
	summary: "Get an invoice",
	description:
		"Requires the `view_invoices` permission. Also includes `client`, `created_by_dispatcher`, `line_items`, `jobs`, `visits`, `payments`, `notes`, `recurring_plan`, the revision and adjustment links (`previous_invoice`, `revised_invoice`, `adjusts_invoice`, `adjustments`), `lineage`, `unlinked_sources` and `parent_tax_snapshot`.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(envelope(invoice), "Invoice"),
		404: json(
			errorEnvelope,
			"Invoice not in the caller's organization (`NOT_FOUND`)",
		),
	},
});

authed("delete", "/invoices/{id}", "Invoices", "delete_invoices", {
	summary: "Delete an invoice",
	description:
		"Requires the `delete_invoices` permission. Only `Draft` invoices can be deleted, and not ones that are part of a dispute; void the invoice instead.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: deletedId,
		400: json(
			errorEnvelope,
			"Invoice isn't a Draft or is part of a dispute, or the delete failed (`DELETE_ERROR`)",
		),
		404: json(errorEnvelope, "Invoice not found (`DELETE_ERROR`)"),
	},
});

authed("get", "/clients/{clientId}/invoices", "Clients", "view_clients", {
	summary: "List a client's invoices",
	description:
		"Requires the `view_clients` permission. Newest first, with the same related records as `GET /invoices/{id}` (without `lineage`). An unknown client returns an empty array.",
	request: { params: clientParams },
	responses: {
		200: json(envelope(z.array(invoice)), "Invoices (empty array if none)"),
	},
});

authed("get", "/jobs/{jobId}/invoices", "Jobs", "view_invoices", {
	summary: "List a job's invoices",
	description:
		"Requires the `view_invoices` permission. Every invoice the job is on, newest first, with the same related records as `GET /invoices/{id}` (without `lineage`). An unknown job returns an empty array.",
	request: { params: jobParams },
	responses: {
		200: json(envelope(z.array(invoice)), "Invoices (empty array if none)"),
	},
});

authed(
	"get",
	"/jobs/{jobId}/visits/{visitId}/invoices",
	"Jobs",
	"view_invoices",
	{
		summary: "List a visit's invoices",
		description:
			"Requires the `view_invoices` permission. Every invoice the visit is on, newest first, with the same related records as `GET /invoices/{id}` (without `lineage`). `jobId` isn't checked. An unknown visit returns an empty array.",
		request: { params: jobVisitParams },
		responses: {
			200: json(
				envelope(z.array(invoice)),
				"Invoices (empty array if none)",
			),
		},
	},
);

const invoiceParams = z.object({ invoiceId: z.uuid() });
const invoiceNoteParams = invoiceParams.extend({ noteId: z.uuid() });
const invoiceNoteRow = invoiceNote.extend(noteEditors);
const overlapWarning = z
	.object({
		visit_id: z.uuid(),
		scheduled_start_at: z.iso.datetime(),
		existing_invoices: z.array(
			z.object({
				invoice_id: z.uuid(),
				invoice_number: z.string(),
				status: z.string(),
				billed_amount: z.number().nullable(),
			}),
		),
	})
	.describe("A visit that's already on another invoice")
	.meta({ id: "OverlapWarning" });

authed("get", "/invoices/{id}/pdf", "Invoices", "view_invoices", {
	summary: "Download an invoice PDF",
	description:
		"Requires the `view_invoices` permission. Sent as an attachment named `invoice-{id}.pdf`.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: {
			description: "The PDF",
			content: {
				"application/pdf": {
					schema: z.string().meta({ format: "binary" }),
				},
			},
		},
		404: json(errorEnvelope, "Invoice not found (`NOT_FOUND`)"),
	},
});

authed(
	"post",
	"/invoices/{id}/tax-review/acknowledge",
	"Invoices",
	"send_invoices",
	{
		summary: "Acknowledge an invoice's tax review",
		description:
			"Requires the `send_invoices` permission. Clears a tax review flagged on the invoice (`tax_needs_review`) by recording who acknowledged it and when. Office users only.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(
					z.object({
						id: z.uuid(),
						tax_review_ack_by: z.uuid(),
						tax_review_ack_at: z.iso.datetime(),
					}),
				),
				"Acknowledged",
			),
			400: json(
				errorEnvelope,
				"The caller isn't an office user (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Invoice not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The invoice has no tax review to acknowledge (`CONFLICT`)",
			),
		},
	},
);

authed("post", "/invoices/overlap-check", "Invoices", "create_invoices", {
	summary: "Check visits for double billing",
	description:
		"Requires the `create_invoices` permission. Before invoicing a set of visits, lists the ones already on another invoice. Nothing is created.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: overlapCheckSchema.meta({ id: "OverlapCheck" }),
				},
			},
		},
	},
	responses: {
		200: json(
			envelope(z.object({ warnings: z.array(overlapWarning) })),
			"Warnings (empty array if none)",
		),
		400: json(
			errorEnvelope,
			"Validation failed, or the visits belong to different clients (`VALIDATION_ERROR`)",
		),
		500: json(
			errorEnvelope,
			'None of the visit ids were found (`SERVER_ERROR`, message "No visits found for provided IDs")',
		),
	},
});

authed(
	"post",
	"/invoices/generate",
	"Invoices",
	"create_invoices",
	{
		summary: "Generate an invoice from a recurring plan",
		description:
			"Requires the `create_invoices` permission. Builds a Draft invoice from the plan's invoice schedule and billing basis, then advances the schedule's next invoice date (except `on_visit_completion` schedules).",
		request: {
			body: {
				content: {
					"application/json": {
						schema: generateInvoiceSchema.meta({
							id: "GenerateInvoice",
						}),
					},
				},
			},
		},
		responses: {
			201: json(
				envelope(
					z.object({ invoice, warnings: z.array(overlapWarning) }),
				),
				"Invoice created",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			409: json(
				errorEnvelope,
				"An invoice is already being generated for this plan (`CONFLICT`)",
			),
			500: json(
				errorEnvelope,
				"The plan wasn't found, has no invoice schedule or job container, or its billing setup is incomplete (`SERVER_ERROR`)",
			),
		},
	},
	moduleOff("recurring_plans"),
);

authed("get", "/invoices/{invoiceId}/payments", "Invoices", "view_invoices", {
	summary: "List an invoice's payments",
	description:
		"Requires the `view_invoices` permission. Oldest first, each with `recorded_by_dispatcher` and `recorded_by_tech` (`id`, `name`). Refunds have a negative `amount`. An unknown invoice returns an empty array.",
	request: { params: invoiceParams },
	responses: {
		200: json(
			envelope(
				z.array(
					invoicePayment.extend({
						recorded_by_dispatcher: idName.nullable(),
						recorded_by_tech: idName.nullable(),
					}),
				),
			),
			"Payments (empty array if none)",
		),
	},
});

authed(
	"delete",
	"/invoices/{invoiceId}/payments/{paymentId}",
	"Invoices",
	"refund_invoices",
	{
		summary: "Delete a payment",
		description:
			"Requires the `refund_invoices` permission. Recomputes the invoice's paid total and status, and removes the payment from QuickBooks if it was synced. Not allowed on Void invoices.",
		request: { params: invoiceParams.extend({ paymentId: z.uuid() }) },
		responses: {
			200: deletedId,
			400: json(
				errorEnvelope,
				"The invoice is Void, or the delete failed (`DELETE_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Payment or invoice not found (`DELETE_ERROR`)",
			),
		},
	},
);

authed("post", "/invoices/{invoiceId}/refunds", "Invoices", "refund_invoices", {
	summary: "Record a refund",
	description:
		"Requires the `refund_invoices` permission. Stored as a payment with a negative `amount` and the reason as its `note`; the invoice drops out of Paid on its own. Can't exceed what's been paid, and not allowed on Void invoices.",
	request: {
		params: invoiceParams,
		body: {
			content: {
				"application/json": {
					schema: createRefundSchema.meta({ id: "CreateRefund" }),
					example: {
						amount: 50,
						reason: "Overcharged for parts",
						method: "card",
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(invoicePayment), "Refund recorded"),
		404: json(errorEnvelope, "Invoice not found (`VALIDATION_ERROR`)"),
		422: json(
			errorEnvelope,
			"Validation failed, the invoice is Void, or the amount is more than has been paid (`VALIDATION_ERROR`)",
		),
	},
});

authed("get", "/invoices/{invoiceId}/notes", "Invoices", "view_invoices", {
	summary: "List an invoice's notes",
	description:
		"Requires the `view_invoices` permission. Newest first. An unknown invoice returns an empty array.",
	request: { params: invoiceParams },
	responses: {
		200: json(
			envelope(z.array(invoiceNoteRow)),
			"Notes (empty array if none)",
		),
	},
});

authed(
	"put",
	"/invoices/{invoiceId}/notes/{noteId}",
	"Invoices",
	"edit_invoices",
	{
		summary: "Update an invoice note",
		description:
			"Requires the `edit_invoices` permission. Any user with the permission can edit any note; the caller is recorded as the last editor.",
		request: {
			params: invoiceNoteParams,
			body: {
				content: {
					"application/json": {
						schema: updateInvoiceNoteSchema.meta({
							id: "UpdateInvoiceNote",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(invoiceNoteRow), "Note updated"),
			400: json(
				errorEnvelope,
				"Validation failed, or the update failed (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Note not found on this invoice (`VALIDATION_ERROR`)",
			),
		},
	},
);

authed(
	"delete",
	"/invoices/{invoiceId}/notes/{noteId}",
	"Invoices",
	"edit_invoices",
	{
		summary: "Delete an invoice note",
		description:
			"Requires the `edit_invoices` permission. Any user with the permission can delete any note.",
		request: { params: invoiceNoteParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Note deleted",
			),
			400: json(errorEnvelope, "The delete failed (`DELETE_ERROR`)"),
			404: json(
				errorEnvelope,
				"Note not found on this invoice (`DELETE_ERROR`)",
			),
		},
	},
);

authed("get", "/invoices/{invoiceId}/changes", "Invoices", "view_invoices", {
	summary: "Get an invoice's history",
	description:
		"Requires the `view_invoices` permission. Activity on the invoice, its notes and its payments.",
	request: { params: invoiceParams, query: historyQuery },
	responses: historyResponses,
});

const invoiceDisputesOff = "The `disputes` module is off or not in the plan";

authed(
	"get",
	"/invoices/{invoiceId}/disputes",
	"Invoices",
	"view_invoices",
	{
		summary: "List an invoice's disputes",
		description:
			"Requires the `view_invoices` permission. Newest first. Each open dispute lists the resolution `outcomes` with whether the caller may pick each one and why not. `open_refusal` says why a new dispute can't be opened, `void_refusal` why the invoice can't be voided (null when allowed).",
		request: { params: invoiceParams },
		responses: {
			200: json(
				envelope(
					z.object({
						disputes: z.array(
							documentDispute.extend({
								opened_by_dispatcher: idName.nullable(),
								resolved_by_dispatcher: idName.nullable(),
								outcomes: z
									.array(z.record(z.string(), z.unknown()))
									.nullable()
									.describe("Only on open disputes"),
							}),
						),
						open_refusal: z.string().nullable(),
						sold_refusal: z.null().describe("Quotes only"),
						void_refusal: z.string().nullable(),
					}),
				),
				"Disputes",
			),
		},
	},
	invoiceDisputesOff,
);

authed(
	"post",
	"/invoices/{invoiceId}/disputes",
	"Invoices",
	"view_invoices and open_disputes",
	{
		summary: "Open a dispute on an invoice",
		description:
			"Requires both `view_invoices` and `open_disputes`. Office users only. One open dispute per invoice. Notifies the office.",
		request: {
			params: invoiceParams,
			body: {
				content: {
					"application/json": {
						schema: openDisputeSchema,
						example: {
							reason: "Client says the second visit was never done",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(documentDispute), "Dispute opened"),
			404: json(errorEnvelope, "Invoice not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The invoice already has an open dispute (`CONFLICT`)",
			),
			422: json(
				errorEnvelope,
				"Validation failed, the invoice's status can't be disputed, or a contested line item isn't on this invoice (`VALIDATION_ERROR`)",
			),
		},
	},
	`Not an office user (\`FORBIDDEN\`); ${invoiceDisputesOff}`,
);

authed(
	"post",
	"/invoices/{invoiceId}/disputes/{disputeId}/resolve",
	"Invoices",
	"view_invoices and resolve_disputes",
	{
		summary: "Resolve an invoice dispute",
		description:
			"Requires both `view_invoices` and `resolve_disputes`. Office users only, and not the person who opened the dispute. `ReviseAndResend` voids the invoice and creates a replacement (`replacement_invoice_id`); `IssueAdjustment` creates an adjustment invoice from `adjustment_lines` (`adjustment_invoice_id`); `Repeal` voids it and needs a `note`. Voids are mirrored to QuickBooks. Check `GET /invoices/{invoiceId}/disputes` for which outcomes the caller may pick.",
		request: {
			params: invoiceParams.extend({ disputeId: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: resolveDisputeSchema,
						example: {
							resolution: "Repeal",
							note: "Billed in error",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(documentDispute), "Dispute resolved"),
			404: json(errorEnvelope, "Invoice not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"Another change landed at the same moment (`CONFLICT`)",
			),
			422: json(
				errorEnvelope,
				"Validation failed, no open dispute, or the outcome isn't allowed for this invoice (`VALIDATION_ERROR`)",
			),
		},
	},
	`Not an office user or the dispute's opener (\`FORBIDDEN\`, \`SELF_RESOLUTION_FORBIDDEN\`), or an outcome withheld from the caller; ${invoiceDisputesOff}`,
);
