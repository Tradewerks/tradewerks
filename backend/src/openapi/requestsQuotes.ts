import z from "zod";
import {
	createRequestSchema,
	updateRequestSchema,
	createRequestNoteSchema,
	updateRequestNoteSchema,
} from "../lib/validate/requests.js";
import {
	createQuoteSchema,
	updateQuoteSchema,
	createQuoteNoteSchema,
	updateQuoteNoteSchema,
	createQuoteItemSchema,
	updateQuoteItemSchema,
} from "../lib/validate/quotes.js";
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

export { deletedId, coords, priority, documentDispute };

// ===============================================================================================================================
// Requests & Quotes
// ===============================================================================================================================

const priority = z.enum(["Low", "Medium", "High", "Urgent", "Emergency"]);
const coords = z.object({ lat: z.number(), lon: z.number() });

const serviceRequest = z
	.object({
		id: z.uuid(),
		client_id: z.uuid(),
		title: z.string(),
		description: z.string(),
		priority,
		address: z.string().nullable(),
		coords: coords.nullable(),
		status: z.enum([
			"New",
			"Reviewing",
			"Quoted",
			"QuoteApproved",
			"QuoteRejected",
			"ConvertedToJob",
			"Cancelled",
		]),
		requires_quote: z.boolean(),
		estimated_value: z.string().nullable().describe("Decimal as a string"),
		source: z.string().nullable(),
		source_reference: z.string().nullable(),
		cancelled_at: z.iso.datetime().nullable(),
		cancellation_reason: z.string().nullable(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		client: z.object({ id: z.uuid(), name: z.string() }),
		quotes: z.array(
			z.object({
				id: z.uuid(),
				quote_number: z.string(),
				status: z.string(),
				total: z.string().describe("Decimal as a string"),
			}),
		),
		jobs: z.array(
			z.object({
				id: z.uuid(),
				job_number: z.string(),
				name: z.string(),
				status: z.string(),
			}),
		),
	})
	.meta({ id: "Request" });

const requestNote = z
	.object({
		id: z.uuid(),
		request_id: z.uuid(),
		content: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
	})
	.meta({ id: "RequestNote" });

authed("get", "/requests", "Requests", "view_requests", {
	summary: "List requests",
	description:
		"Requires the `view_requests` permission. Returns every request in the caller's organization, newest first.",
	responses: {
		200: json(
			envelope(z.array(serviceRequest)),
			"Requests (empty array if none)",
		),
	},
});

authed("post", "/requests", "Requests", "create_requests", {
	summary: "Create a request",
	description:
		"Requires the `create_requests` permission. `coords` is looked up from `address` when omitted; if that fails the request is still created without coords.",
	request: {
		body: {
			content: {
				"application/json": {
					schema: createRequestSchema.meta({ id: "CreateRequest" }),
					example: {
						client_id: "3f1c2a9e-8b7d-4e6f-9a01-2b3c4d5e6f70",
						title: "No heat",
						description: "Furnace won't ignite.",
						priority: "High",
					},
				},
			},
		},
	},
	responses: {
		201: json(envelope(serviceRequest), "Request created"),
		400: json(
			errorEnvelope,
			"Validation failed, or client not in the caller's organization (`VALIDATION_ERROR`)",
		),
	},
});

authed("put", "/requests/{id}", "Requests", "edit_requests", {
	summary: "Update a request",
	description:
		"Requires the `edit_requests` permission. Send at least one field. Setting `status` to `Cancelled` stamps `cancelled_at`.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: updateRequestSchema.meta({ id: "UpdateRequest" }),
					example: { status: "Reviewing" },
				},
			},
		},
	},
	responses: {
		200: json(envelope(serviceRequest), "Request updated"),
		400: json(
			errorEnvelope,
			"Validation failed, request already converted to a job, or status change not allowed (`VALIDATION_ERROR`)",
		),
		404: json(errorEnvelope, "Request not found (`VALIDATION_ERROR`)"),
	},
});

authed("post", "/requests/{id}/notes", "Requests", "edit_requests", {
	summary: "Add a note to a request",
	description:
		"Requires the `edit_requests` permission. The author is the caller, taken from the token.",
	request: {
		params: z.object({ id: z.uuid() }),
		body: {
			content: {
				"application/json": {
					schema: createRequestNoteSchema.meta({
						id: "CreateRequestNote",
					}),
					example: { content: "Client prefers mornings." },
				},
			},
		},
	},
	responses: {
		201: json(envelope(requestNote), "Note created"),
		400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
		404: json(errorEnvelope, "Request not found (`VALIDATION_ERROR`)"),
	},
});

const quote = z
	.object({
		id: z.uuid(),
		quote_number: z.string(),
		client_id: z.uuid(),
		request_id: z.uuid().nullable(),
		title: z.string(),
		description: z.string(),
		status: z.enum([
			"Draft",
			"Issued",
			"Sent",
			"Viewed",
			"Approved",
			"Disputed",
			"Rejected",
			"Revised",
			"Expired",
			"Cancelled",
		]),
		address: z.string(),
		coords: coords.nullable(),
		priority,
		is_active: z.boolean(),
		version: z.number().int(),
		previous_quote_id: z.uuid().nullable(),
		subtotal: z.string().describe("Decimal as a string"),
		tax_rate: z.string().describe("Decimal as a string"),
		tax_amount: z.string().describe("Decimal as a string"),
		discount_type: z.enum(["percent", "amount"]).nullable(),
		discount_value: z.string().nullable().describe("Decimal as a string"),
		discount_amount: z.string().nullable().describe("Decimal as a string"),
		total: z.string().describe("Decimal as a string"),
		valid_until: z.iso.datetime().nullable(),
		expires_at: z.iso.datetime().nullable(),
		issued_at: z.iso.datetime().nullable(),
		sent_at: z.iso.datetime().nullable(),
		viewed_at: z.iso.datetime().nullable(),
		approved_at: z.iso.datetime().nullable(),
		rejected_at: z.iso.datetime().nullable(),
		rejection_reason: z.string().nullable(),
		tax_needs_review: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		client: z.object({ id: z.uuid(), name: z.string() }),
		request: z
			.object({ id: z.uuid(), title: z.string(), status: z.string() })
			.nullable(),
	})
	.meta({ id: "Quote" });

const quoteNote = z
	.object({
		id: z.uuid(),
		quote_id: z.uuid(),
		content: z.string(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		creator_tech: noteAuthor,
		creator_dispatcher: noteAuthor,
	})
	.meta({ id: "QuoteNote" });

authed(
	"get",
	"/quotes",
	"Quotes",
	"view_quotes",
	{
		summary: "List quotes",
		description:
			"Requires the `view_quotes` permission. Returns every quote in the caller's organization, newest first.",
		responses: {
			200: json(envelope(z.array(quote)), "Quotes (empty array if none)"),
		},
	},
	moduleOff("quotes"),
);

authed(
	"post",
	"/quotes",
	"Quotes",
	"create_quotes",
	{
		summary: "Create a quote",
		description:
			"Requires the `create_quotes` permission. With `request_id`, missing `title`, `description`, `address`, `coords` and `priority` are copied from the request and the request moves to `Quoted`. Without it, `title`, `description` and `address` are required. In automatic tax mode `status` must be `Draft`.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createQuoteSchema.meta({ id: "CreateQuote" }),
						example: {
							client_id: "3f1c2a9e-8b7d-4e6f-9a01-2b3c4d5e6f70",
							request_id: "7a2b9c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(quote), "Quote created"),
			400: json(
				errorEnvelope,
				"Validation failed, client or request not in the caller's organization, a required field is missing, or a non-Draft `status` in automatic tax mode (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("quotes"),
);

authed(
	"put",
	"/quotes/{id}",
	"Quotes",
	"edit_quotes",
	{
		summary: "Update a quote",
		description:
			"Requires the `edit_quotes` permission. `Approved`, `Disputed` and `Expired` quotes only take `status` (and `rejection_reason`); `Cancelled`, `Rejected`, `Revised` and converted quotes take nothing.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: updateQuoteSchema.meta({ id: "UpdateQuote" }),
						example: { title: "Furnace replacement" },
					},
				},
			},
		},
		responses: {
			200: json(envelope(quote), "Quote updated"),
			400: json(
				errorEnvelope,
				"Validation failed, quote is Cancelled, Rejected or Revised, already converted to a job, has an open dispute, a field other than `status` sent to an Approved, Disputed or Expired quote, or status change not allowed (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Quote not found (`VALIDATION_ERROR`)"),
			409: json(
				errorEnvelope,
				"Address change needs a tax choice: resend with `address_tax_choice` (`ADDRESS_TAX_CHOICE_REQUIRED`)",
			),
		},
	},
	moduleOff("quotes"),
);

authed(
	"post",
	"/quotes/{id}/send",
	"Quotes",
	"send_quotes",
	{
		summary: "Email a quote to the client",
		description:
			"Requires the `send_quotes` permission. Emails the quote PDF and marks it `Sent`. A Draft is finalized to `Issued` first, so if the email fails it stays `Issued` and can be re-sent.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: z
							.object({ recipient_email: z.string() })
							.meta({ id: "SendQuote" }),
						example: { recipient_email: "jane@example.com" },
					},
				},
			},
		},
		responses: {
			200: json(envelope(quote), "Quote sent"),
			400: json(
				errorEnvelope,
				"`recipient_email` missing, or the quote couldn't be finalized (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Quote not found (`NOT_FOUND`)"),
			422: json(
				errorEnvelope,
				"Quote can't be sent from its current status (`VALIDATION_ERROR`), or the recipient address was rejected (`EMAIL_RECIPIENT_REJECTED`)",
			),
			502: json(
				errorEnvelope,
				"Email provider failed (`EMAIL_SEND_FAILED`)",
			),
		},
	},
	moduleOff("quotes"),
);

authed(
	"post",
	"/quotes/{id}/notes",
	"Quotes",
	"edit_quotes",
	{
		summary: "Add a note to a quote",
		description:
			"Requires the `edit_quotes` permission. The author is the caller, taken from the token.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: createQuoteNoteSchema.meta({
							id: "CreateQuoteNote",
						}),
						example: { content: "Client wants a second option." },
					},
				},
			},
		},
		responses: {
			201: json(envelope(quoteNote), "Note created"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(errorEnvelope, "Quote not found (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("quotes"),
);

const deletedId = json(envelope(z.object({ id: z.uuid() })), "Deleted");

authed("get", "/requests/{id}", "Requests", "view_requests", {
	summary: "Get a request",
	description:
		"Requires the `view_requests` permission. Also includes `client` (with its primary contact), `quotes`, `jobs` and `notes`.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(envelope(serviceRequest), "Request"),
		404: json(
			errorEnvelope,
			"Request not in the caller's organization (`NOT_FOUND`)",
		),
	},
});

authed("delete", "/requests/{id}", "Requests", "delete_requests", {
	summary: "Delete a request",
	description:
		"Requires the `delete_requests` permission. Blocked once the request has quotes or was converted to a job. Its notes are deleted with it.",
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: deletedId,
		400: json(
			errorEnvelope,
			"Request has quotes or was converted to a job (`DELETE_ERROR`)",
		),
		404: json(errorEnvelope, "Request not found (`DELETE_ERROR`)"),
	},
});

authed(
	"get",
	"/quotes/{id}",
	"Quotes",
	"view_quotes",
	{
		summary: "Get a quote",
		description:
			"Requires the `view_quotes` permission. Also includes `client`, `request`, `job`, `line_items`, `notes`, `previous_quote`, `revised_quote` and `lineage` (the revision chain).",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(envelope(quote), "Quote"),
			404: json(
				errorEnvelope,
				"Quote not in the caller's organization (`NOT_FOUND`)",
			),
		},
	},
	moduleOff("quotes"),
);

authed(
	"delete",
	"/quotes/{id}",
	"Quotes",
	"delete_quotes",
	{
		summary: "Delete a quote",
		description:
			"Requires the `delete_quotes` permission. Blocked once the quote was converted to a job or has any dispute history; cancel it instead. Its notes and line items are deleted with it.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: deletedId,
			400: json(
				errorEnvelope,
				"Quote was converted to a job or is part of a dispute (`DELETE_ERROR`)",
			),
			404: json(errorEnvelope, "Quote not found (`DELETE_ERROR`)"),
		},
	},
	moduleOff("quotes"),
);

const requestNoteParams = z.object({ requestId: z.uuid(), noteId: z.uuid() });
const requestNoteRow = requestNote.extend(noteEditors);

authed("get", "/requests/{requestId}/notes", "Requests", "view_requests", {
	summary: "List a request's notes",
	description:
		"Requires the `view_requests` permission. An unknown request returns an empty array.",
	request: { params: z.object({ requestId: z.uuid() }) },
	responses: {
		200: json(
			envelope(z.array(requestNoteRow)),
			"Notes (empty array if none)",
		),
	},
});

authed(
	"get",
	"/requests/{requestId}/notes/{noteId}",
	"Requests",
	"view_requests",
	{
		summary: "Get a request note",
		description: "Requires the `view_requests` permission.",
		request: { params: requestNoteParams },
		responses: {
			200: json(envelope(requestNoteRow), "Note"),
			404: json(
				errorEnvelope,
				"Note not found on this request (`NOT_FOUND`)",
			),
		},
	},
);

authed(
	"put",
	"/requests/{requestId}/notes/{noteId}",
	"Requests",
	"edit_requests",
	{
		summary: "Update a request note",
		description:
			"Requires the `edit_requests` permission. Any user with the permission can edit any note; the caller is recorded as the last editor.",
		request: {
			params: requestNoteParams,
			body: {
				content: {
					"application/json": {
						schema: updateRequestNoteSchema.meta({
							id: "UpdateRequestNote",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(requestNoteRow), "Note updated"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Note not found on this request (`VALIDATION_ERROR`)",
			),
		},
	},
);

authed(
	"delete",
	"/requests/{requestId}/notes/{noteId}",
	"Requests",
	"edit_requests",
	{
		summary: "Delete a request note",
		description:
			"Requires the `edit_requests` permission. Any user with the permission can delete any note.",
		request: { params: requestNoteParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Note deleted",
			),
			404: json(
				errorEnvelope,
				"Note not found on this request (`DELETE_ERROR`)",
			),
		},
	},
);

authed("get", "/requests/{requestId}/changes", "Requests", "view_requests", {
	summary: "Get a request's history",
	description:
		"Requires the `view_requests` permission. Activity on the request and its notes.",
	request: { params: z.object({ requestId: z.uuid() }), query: historyQuery },
	responses: historyResponses,
});

authed("get", "/clients/{clientId}/requests", "Clients", "view_clients", {
	summary: "List a client's requests",
	description:
		"Requires the `view_clients` permission. Newest first, each with its `client`, `quotes` and `jobs`. An unknown client returns an empty array.",
	request: { params: clientParams },
	responses: {
		200: json(
			envelope(z.array(serviceRequest)),
			"Requests (empty array if none)",
		),
	},
});

authed(
	"get",
	"/clients/{clientId}/quotes",
	"Clients",
	"view_clients",
	{
		summary: "List a client's quotes",
		description:
			"Requires the `view_clients` permission. Newest first, each with its `client`, `request`, `job` and `line_items`. An unknown client returns an empty array.",
		request: { params: clientParams },
		responses: {
			200: json(envelope(z.array(quote)), "Quotes (empty array if none)"),
		},
	},
	moduleOff("quotes"),
);

const quoteParams = z.object({ quoteId: z.uuid() });
const quoteItemParams = quoteParams.extend({ itemId: z.uuid() });
const quoteNoteParams = quoteParams.extend({ noteId: z.uuid() });
const quoteNoteRow = quoteNote.extend(noteEditors);
const quoteLineItem = z
	.object({
		id: z.uuid(),
		quote_id: z.uuid(),
		name: z.string(),
		description: z.string().nullable(),
		quantity: decimal,
		unit_price: decimal,
		total: decimal,
		item_type: z
			.enum(["labor", "material", "equipment", "other"])
			.nullable(),
		sort_order: z.number().int(),
		tax_group_id: z.uuid().nullable(),
		taxable: z.boolean(),
		tax_amount: decimal.nullable(),
		inventory_item_id: z.uuid().nullable(),
	})
	.meta({ id: "QuoteLineItem" });
const documentDispute = z
	.object({
		id: z.uuid(),
		document_kind: z.enum(["quote", "invoice"]),
		quote_id: z.uuid().nullable(),
		invoice_id: z.uuid().nullable(),
		status: z.enum(["Open", "Resolved"]),
		reason: z.string(),
		contested_line_item_ids: z.array(z.uuid()).nullable(),
		status_at_open: z
			.string()
			.describe("The document's status when the dispute was opened"),
		opened_by_dispatcher_id: z.uuid().nullable(),
		opened_at: z.iso.datetime(),
		resolution: z
			.enum(["ReviseAndResend", "IssueAdjustment", "Repeal"])
			.nullable(),
		resolution_note: z.string().nullable(),
		resolved_by_dispatcher_id: z.uuid().nullable(),
		resolved_at: z.iso.datetime().nullable(),
		replacement_quote_id: z.uuid().nullable(),
		replacement_invoice_id: z.uuid().nullable(),
		adjustment_invoice_id: z.uuid().nullable(),
	})
	.meta({ id: "DocumentDispute" });
const quotesOff = moduleOff("quotes");
const disputesOff = `${moduleOff("quotes")}; or the \`disputes\` module is off`;

authed(
	"get",
	"/quotes/{id}/pdf",
	"Quotes",
	"view_quotes",
	{
		summary: "Download a quote PDF",
		description:
			"Requires the `view_quotes` permission. Sent as an attachment named `quote-{id}.pdf`.",
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
			404: json(errorEnvelope, "Quote not found (`NOT_FOUND`)"),
		},
	},
	quotesOff,
);

authed(
	"post",
	"/quotes/{id}/reject",
	"Quotes",
	"edit_quotes",
	{
		summary: "Reject a quote",
		description:
			"Requires the `edit_quotes` permission. Records that the client declined. Use cancel instead when you withdraw the quote.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({
							rejection_reason: z.string().min(1),
						}),
						example: {
							rejection_reason: "Went with another contractor",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(quote), "Quote rejected"),
			404: json(errorEnvelope, "Quote not found (`VALIDATION_ERROR`)"),
			422: json(
				errorEnvelope,
				"No reason given, or the quote can't move to Rejected from its current status (`VALIDATION_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"post",
	"/quotes/{id}/cancel",
	"Quotes",
	"edit_quotes",
	{
		summary: "Cancel a quote",
		description:
			"Requires the `edit_quotes` permission. Withdraws the quote; the reason is stored as `rejection_reason`.",
		request: {
			params: z.object({ id: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: z.object({ reason: z.string().min(1) }),
						example: { reason: "Customer moved" },
					},
				},
			},
		},
		responses: {
			200: json(envelope(quote), "Quote cancelled"),
			404: json(errorEnvelope, "Quote not found (`VALIDATION_ERROR`)"),
			422: json(
				errorEnvelope,
				"No reason given, or the quote can't move to Cancelled from its current status (`VALIDATION_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"post",
	"/quotes/{id}/revise",
	"Quotes",
	"edit_quotes",
	{
		summary: "Revise a quote",
		description:
			"Requires the `edit_quotes` permission. Creates a new draft revision and marks this quote `Revised`. Refused once the quote has been sold as a job.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.object({ id: z.uuid(), quote_number: z.string() })),
				"The new revision",
			),
			404: json(errorEnvelope, "Quote not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The quote has already been revised (`CONFLICT`)",
			),
			422: json(
				errorEnvelope,
				"The quote can't be revised from its current status, is under dispute (resolve it with `ReviseAndResend` instead), or was sold as a job (`VALIDATION_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"post",
	"/quotes/{id}/tax-review/acknowledge",
	"Quotes",
	"send_quotes",
	{
		summary: "Acknowledge a quote's tax review",
		description:
			"Requires the `send_quotes` permission. Clears a tax review flagged on the quote (`tax_needs_review`) by recording who acknowledged it and when. Office users only.",
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
			404: json(errorEnvelope, "Quote not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The quote has no tax review to acknowledge (`CONFLICT`)",
			),
		},
	},
	quotesOff,
);

authed(
	"get",
	"/quotes/{quoteId}/line-items",
	"Quotes",
	"view_quotes",
	{
		summary: "List a quote's line items",
		description:
			"Requires the `view_quotes` permission. In `sort_order`. An unknown quote returns an empty array.",
		request: { params: quoteParams },
		responses: {
			200: json(
				envelope(z.array(quoteLineItem)),
				"Line items (empty array if none)",
			),
		},
	},
	quotesOff,
);

authed(
	"get",
	"/quotes/{quoteId}/line-items/{itemId}",
	"Quotes",
	"view_quotes",
	{
		summary: "Get a quote line item",
		description: "Requires the `view_quotes` permission.",
		request: { params: quoteItemParams },
		responses: {
			200: json(envelope(quoteLineItem), "Line item"),
			404: json(
				errorEnvelope,
				"Line item not found on this quote (`NOT_FOUND`)",
			),
		},
	},
	quotesOff,
);

authed(
	"post",
	"/quotes/{quoteId}/line-items",
	"Quotes",
	"edit_quotes",
	{
		summary: "Add a quote line item",
		description:
			"Requires the `edit_quotes` permission. The quote's totals and tax are recomputed. Only `Draft`, `Issued`, `Sent` and `Viewed` quotes not converted to a job can change line items.",
		request: {
			params: quoteParams,
			body: {
				content: {
					"application/json": {
						schema: createQuoteItemSchema.meta({
							id: "CreateQuoteLineItem",
						}),
					},
				},
			},
		},
		responses: {
			201: json(envelope(quoteLineItem), "Line item added"),
			400: json(
				errorEnvelope,
				"Validation failed, the quote is locked (status or converted to a job), or `inventory_item_id` or `tax_group_id` isn't in the caller's organization (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Quote not found (`VALIDATION_ERROR`)"),
		},
	},
	quotesOff,
);

authed(
	"put",
	"/quotes/{quoteId}/line-items/{itemId}",
	"Quotes",
	"edit_quotes",
	{
		summary: "Update a quote line item",
		description:
			"Requires the `edit_quotes` permission. Send only the fields to change. The quote's totals and tax are recomputed. Only `Draft`, `Issued`, `Sent` and `Viewed` quotes not converted to a job can change line items.",
		request: {
			params: quoteItemParams,
			body: {
				content: {
					"application/json": {
						schema: updateQuoteItemSchema.meta({
							id: "UpdateQuoteLineItem",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(quoteLineItem), "Line item updated"),
			400: json(
				errorEnvelope,
				"Validation failed, the quote is locked (status or converted to a job), or `inventory_item_id` or `tax_group_id` isn't in the caller's organization (`VALIDATION_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Line item not found on this quote (`VALIDATION_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"delete",
	"/quotes/{quoteId}/line-items/{itemId}",
	"Quotes",
	"edit_quotes",
	{
		summary: "Delete a quote line item",
		description:
			"Requires the `edit_quotes` permission. The quote's totals and tax are recomputed. Only `Draft`, `Issued`, `Sent` and `Viewed` quotes not converted to a job can change line items.",
		request: { params: quoteItemParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Line item deleted",
			),
			400: json(
				errorEnvelope,
				"The quote is locked by its status, or was converted to a job (`DELETE_ERROR`)",
			),
			404: json(
				errorEnvelope,
				"Line item not found on this quote (`DELETE_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"get",
	"/quotes/{quoteId}/notes",
	"Quotes",
	"view_quotes",
	{
		summary: "List a quote's notes",
		description:
			"Requires the `view_quotes` permission. Newest first. An unknown quote returns an empty array.",
		request: { params: quoteParams },
		responses: {
			200: json(
				envelope(z.array(quoteNoteRow)),
				"Notes (empty array if none)",
			),
		},
	},
	quotesOff,
);

authed(
	"get",
	"/quotes/{quoteId}/notes/{noteId}",
	"Quotes",
	"view_quotes",
	{
		summary: "Get a quote note",
		description: "Requires the `view_quotes` permission.",
		request: { params: quoteNoteParams },
		responses: {
			200: json(envelope(quoteNoteRow), "Note"),
			404: json(
				errorEnvelope,
				"Note not found on this quote (`NOT_FOUND`)",
			),
		},
	},
	quotesOff,
);

authed(
	"put",
	"/quotes/{quoteId}/notes/{noteId}",
	"Quotes",
	"edit_quotes",
	{
		summary: "Update a quote note",
		description:
			"Requires the `edit_quotes` permission. Any user with the permission can edit any note; the caller is recorded as the last editor.",
		request: {
			params: quoteNoteParams,
			body: {
				content: {
					"application/json": {
						schema: updateQuoteNoteSchema.meta({
							id: "UpdateQuoteNote",
						}),
					},
				},
			},
		},
		responses: {
			200: json(envelope(quoteNoteRow), "Note updated"),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Note not found on this quote (`VALIDATION_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"delete",
	"/quotes/{quoteId}/notes/{noteId}",
	"Quotes",
	"edit_quotes",
	{
		summary: "Delete a quote note",
		description:
			"Requires the `edit_quotes` permission. Any user with the permission can delete any note.",
		request: { params: quoteNoteParams },
		responses: {
			200: json(
				envelope(z.object({ message: z.string() })),
				"Note deleted",
			),
			404: json(
				errorEnvelope,
				"Note not found on this quote (`DELETE_ERROR`)",
			),
		},
	},
	quotesOff,
);

authed(
	"get",
	"/quotes/{quoteId}/changes",
	"Quotes",
	"view_quotes",
	{
		summary: "Get a quote's history",
		description:
			"Requires the `view_quotes` permission. Activity on the quote and its notes.",
		request: { params: quoteParams, query: historyQuery },
		responses: historyResponses,
	},
	quotesOff,
);

authed(
	"get",
	"/quotes/{quoteId}/disputes",
	"Quotes",
	"view_quotes",
	{
		summary: "List a quote's disputes",
		description:
			"Requires the `view_quotes` permission. Newest first. Each open dispute lists the resolution `outcomes` with whether the caller may pick each one and why not. `open_refusal` says why a new dispute can't be opened, `sold_refusal` why the quote can't be converted to a job (null when allowed).",
		request: { params: quoteParams },
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
						sold_refusal: z.string().nullable(),
						void_refusal: z.null().describe("Invoices only"),
					}),
				),
				"Disputes",
			),
		},
	},
	disputesOff,
);

authed(
	"post",
	"/quotes/{quoteId}/disputes",
	"Quotes",
	"view_quotes and open_disputes",
	{
		summary: "Open a dispute on a quote",
		description:
			"Requires both `view_quotes` and `open_disputes`. Office users only. One open dispute per quote. Notifies the office.",
		request: {
			params: quoteParams,
			body: {
				content: {
					"application/json": {
						schema: openDisputeSchema.meta({
							id: "OpenDisputeInput",
						}),
						example: {
							reason: "Client says the labor estimate is too high",
						},
					},
				},
			},
		},
		responses: {
			201: json(envelope(documentDispute), "Dispute opened"),
			404: json(errorEnvelope, "Quote not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"The quote already has an open dispute (`CONFLICT`)",
			),
			422: json(
				errorEnvelope,
				"Validation failed, the quote's status can't be disputed, or a contested line item isn't on this quote (`VALIDATION_ERROR`)",
			),
		},
	},
	`Not an office user (\`FORBIDDEN\`); ${disputesOff}`,
);

authed(
	"post",
	"/quotes/{quoteId}/disputes/{disputeId}/resolve",
	"Quotes",
	"view_quotes and resolve_disputes",
	{
		summary: "Resolve a quote dispute",
		description:
			"Requires both `view_quotes` and `resolve_disputes`. Office users only, and not the person who opened the dispute. `ReviseAndResend` creates a revised quote (`replacement_quote_id`); `Repeal` needs a `note`. Check `GET /quotes/{quoteId}/disputes` for which outcomes the caller may pick.",
		request: {
			params: quoteParams.extend({ disputeId: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: resolveDisputeSchema.meta({
							id: "ResolveDispute",
						}),
						example: {
							resolution: "ReviseAndResend",
							note: "Lowered labor to 6 hours",
						},
					},
				},
			},
		},
		responses: {
			200: json(envelope(documentDispute), "Dispute resolved"),
			404: json(errorEnvelope, "Quote not found (`NOT_FOUND`)"),
			409: json(
				errorEnvelope,
				"Another change landed at the same moment (`CONFLICT`)",
			),
			422: json(
				errorEnvelope,
				"Validation failed, no open dispute, or the outcome isn't allowed for this quote (`VALIDATION_ERROR`)",
			),
		},
	},
	`Not an office user or the dispute's opener (\`FORBIDDEN\`, \`SELF_RESOLUTION_FORBIDDEN\`), or an outcome withheld from the caller; ${disputesOff}`,
);
