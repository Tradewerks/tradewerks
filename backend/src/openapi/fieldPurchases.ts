import z from "zod";
import {
	listPurchasesQuerySchema as listFieldPurchasesQuerySchema,
	createPurchaseSchema as createFieldPurchaseSchema,
} from "../lib/validate/fieldPurchases.js";
import {
	authed,
	decimal,
	envelope,
	errorEnvelope,
	idName,
	json,
	moduleOff,
} from "./shared.js";
import { allocation } from "./purchases.js";

// ===============================================================================================================================
// Field Purchases
// ===============================================================================================================================

const fieldPurchase = z
	.object({
		id: z.uuid(),
		status: z.enum([
			"draft",
			"pending_preauth",
			"preauth_denied",
			"preauth_approved",
			"pending_review",
			"queried",
			"pending_second_signoff",
			"approved",
			"rejected",
		]),
		kind: z.enum(["purchase", "refund"]),
		technician_id: z.uuid(),
		parent_purchase_id: z.uuid().nullable(),
		reason: z.string().nullable(),
		estimated_amount: decimal.nullable(),
		vendor_name: z.string().nullable(),
		supplier_id: z.uuid().nullable(),
		receipt_number: z.string().nullable(),
		purchased_at: z.iso.datetime().nullable(),
		subtotal: decimal,
		tax_amount: decimal,
		total: decimal,
		receipt_image_url: z
			.string()
			.nullable()
			.describe("Signed, short-lived image URL"),
		has_geo: z
			.boolean()
			.describe("Whether a capture location was recorded"),
		captured_at: z.iso.datetime().nullable(),
		submitted_at: z.iso.datetime().nullable(),
		reviewed_at: z.iso.datetime().nullable(),
		review_note: z.string().nullable(),
		ocr_status: z.enum([
			"not_run",
			"skipped",
			"pending",
			"succeeded",
			"failed",
		]),
		flags: z.array(z.unknown()),
		qb_sync_status: z.enum([
			"not_synced",
			"synced",
			"failed",
			"tax_mismatch",
		]),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
		technician: idName,
		supplier: idName.nullable(),
		lines: z.array(z.record(z.string(), z.unknown())),
		allocations: z.array(allocation),
	})
	.meta({ id: "FieldPurchase" });

authed(
	"get",
	"/field-purchases",
	"Field Purchases",
	"request_field_purchase or view_field_purchases",
	{
		summary: "List field purchases",
		description:
			"Requires `request_field_purchase` or `view_field_purchases`. Technician receipts, newest submitted first by default. A technician only sees their own.",
		request: { query: listFieldPurchasesQuerySchema },
		responses: {
			200: json(
				envelope(z.array(fieldPurchase)).extend({
					meta: z.object({
						timestamp: z.string(),
						count: z.number().int(),
						total: z
							.number()
							.int()
							.describe("Matching rows before paging"),
						hasMore: z.boolean(),
					}),
				}),
				"One page of field purchases",
			),
			400: json(errorEnvelope, "Invalid query (`VALIDATION_ERROR`)"),
		},
	},
	moduleOff("field_purchases"),
);

authed(
	"post",
	"/field-purchases",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Create a field purchase",
		description:
			"Requires the `request_field_purchase` permission. The caller becomes the purchase's technician and needs an active field purchase authorization. Created as a `draft`.",
		request: {
			body: {
				content: {
					"application/json": {
						schema: createFieldPurchaseSchema.meta({
							id: "CreateFieldPurchase",
						}),
					},
				},
			},
		},
		responses: {
			201: json(envelope(fieldPurchase), "Field purchase created"),
			400: json(
				errorEnvelope,
				"Validation failed, duplicate or unknown job in `allocations`, a visit that isn't on its job, or no active field purchase authorization (`VALIDATION_ERROR`)",
			),
		},
	},
	moduleOff("field_purchases"),
);

authed(
	"get",
	"/field-purchases/{id}",
	"Field Purchases",
	"request_field_purchase or view_field_purchases",
	{
		summary: "Get a field purchase",
		description:
			"Requires `request_field_purchase` or `view_field_purchases`. Technicians only see their own. Returns the purchase and its event history; a refund also carries `parent`, an approved purchase `refund_summary`.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(
					z.object({
						purchase: fieldPurchase,
						events: z
							.array(
								z.object({
									id: z.uuid(),
									type: z.string(),
									actor_type: z.string(),
									actor_id: z.string().nullable(),
									detail: z.record(z.string(), z.unknown()),
									at: z.iso.datetime(),
								}),
							)
							.describe("Oldest first"),
					}),
				),
				"Field purchase",
			),
			404: json(
				errorEnvelope,
				"Field purchase not found, or another technician's (`NOT_FOUND`)",
			),
		},
	},
	moduleOff("field_purchases"),
);

authed(
	"delete",
	"/field-purchases/{id}",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Delete a field purchase",
		description:
			"Requires the `request_field_purchase` permission. Only `draft` purchases can be deleted, and technicians can only delete their own.",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: json(
				envelope(z.object({ deleted: z.literal(true) })),
				"Deleted",
			),
			400: json(
				errorEnvelope,
				"Purchase isn't a draft (`VALIDATION_ERROR`)",
			),
			404: json(errorEnvelope, "Field purchase not found (`NOT_FOUND`)"),
		},
	},
	"Another technician's purchase (`INVALID_CREDENTIALS`); " +
		moduleOff("field_purchases"),
);

// Refusals about the caller's authority ("Only a dispatcher…", "You cannot…",
// "You can only…") are 403; a missing purchase is 404; anything else is 400 with the
// reason in the message, including unexpected errors.
const fpOff = moduleOff("field_purchases");
const fpParams = z.object({ id: z.uuid() });
const fpNotFound = json(
	errorEnvelope,
	"Field purchase not found, or another technician's (`NOT_FOUND`)",
);
const fpRefused = (why: string) =>
	`${why} (\`INVALID_CREDENTIALS\`); or ${fpOff}`;
const fpBad = (why: string) =>
	json(errorEnvelope, `${why} (\`VALIDATION_ERROR\`)`);
const purchaseOut = (text = "The purchase") =>
	json(envelope(fieldPurchase), text);
const note = z.string().max(2000).nullable().optional();
const money = z.number().min(0);
const body = (schema: z.ZodType, example?: unknown) => ({
	body: {
		content: {
			"application/json": { schema, ...(example ? { example } : {}) },
		},
	},
});
const grant = z
	.object({
		id: z.uuid(),
		technician_id: z.uuid(),
		per_transaction_limit: decimal,
		daily_limit: decimal.nullable(),
		weekly_limit: decimal.nullable(),
		per_job_limit: decimal.nullable(),
		notes: z.string().nullable(),
		is_active: z.boolean(),
		created_at: z.iso.datetime(),
		updated_at: z.iso.datetime(),
	})
	.catchall(z.unknown())
	.meta({ id: "FieldPurchaseGrant" });
const spent = z.object({ today: decimal, week: decimal });
const sheet = z
	.object({
		field_reviews: z
			.record(z.string(), z.enum(["confirmed", "edited"]).nullable())
			.optional()
			.describe(
				"Per OCR header field: the technician checked it, or changed it",
			),
		vendor_name: z.string().max(120).nullable().optional(),
		receipt_number: z.string().max(64).nullable().optional(),
		purchased_at: z.string().optional(),
		tax_amount: money.optional(),
		total: money.optional(),
		allocations: z
			.array(z.record(z.string(), z.unknown()))
			.optional()
			.describe("Jobs the receipt covers"),
		lines: z
			.array(z.record(z.string(), z.unknown()))
			.max(100)
			.optional()
			.describe("Replaces every line"),
	})
	.meta({ id: "FieldPurchaseSheet" });

authed(
	"get",
	"/field-purchases/grants",
	"Field Purchases",
	"manage_field_purchase_grants",
	{
		summary: "List purchasing authorizations",
		description:
			"Requires the `manage_field_purchase_grants` permission. Every technician's spending authority: the per-transaction ceiling and optional daily, weekly and per-job ones.",
		responses: {
			200: json(
				envelope(z.array(grant)),
				"Authorizations (empty array if none)",
			),
			400: fpBad("The lookup failed"),
		},
	},
	fpOff,
);

authed(
	"post",
	"/field-purchases/grants",
	"Field Purchases",
	"manage_field_purchase_grants",
	{
		summary: "Grant or change purchasing authority",
		description:
			"Requires the `manage_field_purchase_grants` permission. Creates the technician's authorization, or replaces the limits of their existing one. The daily limit can't be below the per-transaction one, or the weekly below the daily.",
		request: {
			...body(
				z
					.object({
						technician_id: z.uuid(),
						per_transaction_limit: z.number().positive(),
						daily_limit: z
							.number()
							.positive()
							.nullable()
							.optional(),
						weekly_limit: z
							.number()
							.positive()
							.nullable()
							.optional(),
						per_job_limit: z
							.number()
							.positive()
							.nullable()
							.optional(),
						notes: note,
					})
					.meta({ id: "UpsertFieldPurchaseGrant" }),
				{
					technician_id: "3f6c2a1e-8b4d-4c2a-9e1f-1a2b3c4d5e6f",
					per_transaction_limit: 250,
					daily_limit: 500,
				},
			),
		},
		responses: {
			201: json(envelope(grant), "Saved (201 for an update too)"),
			400: fpBad("Validation failed, or the save failed"),
			404: json(errorEnvelope, "Technician not found (`NOT_FOUND`)"),
		},
	},
	fpOff,
);

authed(
	"post",
	"/field-purchases/grants/{id}/revoke",
	"Field Purchases",
	"manage_field_purchase_grants",
	{
		summary: "Revoke purchasing authority",
		description:
			"Requires the `manage_field_purchase_grants` permission. `id` is the authorization's id.",
		request: {
			params: fpParams,
			...body(
				z
					.object({ reason: note })
					.meta({ id: "RevokeFieldPurchaseGrant" }),
			),
		},
		responses: {
			200: json(envelope(grant), "Revoked"),
			400: fpBad(
				"Already revoked, validation failed, or the update failed",
			),
			404: json(errorEnvelope, "Authorization not found (`NOT_FOUND`)"),
		},
	},
	fpOff,
);

authed(
	"get",
	"/field-purchases/my-grant",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Get my purchasing authority",
		description:
			"Requires the `request_field_purchase` permission. The caller's own authorization (null if none) and what they've spent today and this week.",
		responses: {
			200: json(
				envelope(z.object({ grant: grant.nullable(), spent })),
				"Authorization and spend",
			),
		},
	},
	fpOff,
);

authed(
	"post",
	"/field-purchases/my-grant/request",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Ask for purchasing authority",
		description:
			"Requires the `request_field_purchase` permission. Notifies the office that the caller wants an authorization.",
		responses: {
			200: json(
				envelope(z.object({ requested: z.boolean() })),
				"Requested",
			),
			400: fpBad("The caller already has an active authorization"),
		},
	},
	fpOff,
);

authed(
	"post",
	"/field-purchases/limit-check",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Check a purchase against my limits",
		description:
			"Requires the `request_field_purchase` permission. Whether `amount` (and each job's share) fits the caller's limits given what they've already spent. A breach means pre-authorization is needed, not a refusal. Nothing is saved; a POST only so it can carry a body. Allowed while the module is read-only.",
		request: {
			...body(
				z
					.object({
						amount: money,
						jobs: z
							.array(
								z.object({ job_id: z.uuid(), amount: money }),
							)
							.max(50)
							.optional(),
						purchase_id: z
							.uuid()
							.optional()
							.describe(
								"The purchase being checked, so its own spend isn't counted twice",
							),
					})
					.meta({ id: "FieldPurchaseLimitCheck" }),
				{ amount: 180 },
			),
		},
		responses: {
			200: json(
				envelope(
					z.object({
						verdict: z.object({
							authorized: z
								.boolean()
								.describe(
									"False when the caller has no active authorization",
								),
							requires_preauth: z.boolean(),
							breaches: z.array(
								z.object({
									code: z.enum([
										"per_transaction",
										"daily",
										"weekly",
										"per_job",
									]),
									limit: decimal,
									would_be: decimal,
									job_id: z.uuid().optional(),
								}),
							),
						}),
						spent,
					}),
				),
				"Verdict",
			),
			400: fpBad("Validation failed"),
		},
	},
	fpOff,
);

authed(
	"get",
	"/field-purchases/summary",
	"Field Purchases",
	"request_field_purchase or view_field_purchases",
	{
		summary: "Field purchase queue summary",
		description:
			"Requires `request_field_purchase` or `view_field_purchases`. Counts for the review queue; technicians only see their own purchases counted.",
		responses: {
			200: json(
				envelope(
					z.object({
						open_count: z.number().int(),
						open_value: decimal,
						pending_preauth_count: z.number().int(),
						pending_review_count: z.number().int(),
						pending_signoff_count: z.number().int(),
						with_tech_count: z.number().int(),
						oldest_open_at: z.iso.datetime().nullable(),
						flagged_count: z.number().int(),
						unsettled_refund_count: z.number().int(),
						unsettled_refund_value: decimal,
					}),
				),
				"Summary",
			),
			400: fpBad("The lookup failed"),
		},
	},
	fpOff,
);

authed(
	"post",
	"/field-purchases/{id}/receipt",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Upload a receipt photo",
		description:
			"Requires the `request_field_purchase` permission; own purchases only, while editable. Stores the image, records where and when it was taken, and starts reading it (OCR) when that's configured and the plan has scans left (otherwise the lines are entered by hand). The same image can't be used on two purchases. JPEG, PNG, WebP or HEIC, up to 5 MB.",
		request: {
			params: fpParams,
			body: {
				content: {
					"multipart/form-data": {
						schema: z.object({
							image: z.string().meta({ format: "binary" }),
							captured_at: z
								.string()
								.optional()
								.describe("Device clock at capture"),
							capture_lat: z.number().optional(),
							capture_lng: z.number().optional(),
							capture_accuracy_m: z.number().int().optional(),
						}),
					},
				},
			},
		},
		responses: {
			200: purchaseOut(),
			400: fpBad(
				"No image, the image was already used, the purchase can't be edited, or the receipt is still being read",
			),
			404: fpNotFound,
			500: json(
				errorEnvelope,
				"The file type isn't allowed (`SERVER_ERROR`)",
			),
		},
	},
	fpRefused("Another technician's purchase"),
);

authed(
	"get",
	"/field-purchases/{id}/extraction",
	"Field Purchases",
	"request_field_purchase or view_field_purchases",
	{
		summary: "Get what the receipt reading found",
		description:
			"Requires `request_field_purchase` or `view_field_purchases`; technicians see only their own. What OCR read off the receipt, which can differ from what the purchase now holds.",
		request: { params: fpParams },
		responses: {
			200: json(
				envelope(
					z
						.record(z.string(), z.unknown())
						.describe("The reading and its provider payload"),
				),
				"Extraction",
			),
			404: fpNotFound,
		},
	},
	fpOff,
);

authed(
	"get",
	"/field-purchases/{id}/capture-location",
	"Field Purchases",
	"view_field_purchase_location",
	{
		summary: "Get where a receipt was photographed",
		description:
			"Requires the `view_field_purchase_location` permission. The device location at capture, kept off every other read because it's personal information about the technician.",
		request: { params: fpParams },
		responses: {
			200: json(
				envelope(
					z
						.record(z.string(), z.unknown())
						.describe(
							"Latitude, longitude, accuracy and capture time",
						),
				),
				"Location",
			),
			404: fpNotFound,
		},
	},
	fpOff,
);

authed(
	"post",
	"/field-purchases/{id}/ocr/retry",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Read a receipt again",
		description:
			"Requires the `request_field_purchase` permission; own purchases only. Re-reads the stored image (a new photo would change the duplicate check).",
		request: { params: fpParams },
		responses: {
			200: json(
				envelope(z.object({ started: z.literal(true) })),
				"Started",
			),
			400: fpBad(
				"No image, already being read, reading isn't configured, or it failed",
			),
			404: fpNotFound,
			429: json(
				errorEnvelope,
				"Receipt scans used up for the plan (`QUOTA_EXCEEDED`)",
			),
		},
	},
	fpRefused("Another technician's purchase"),
);

authed(
	"post",
	"/field-purchases/{id}/preauth",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Ask for pre-authorization",
		description:
			"Requires the `request_field_purchase` permission; own purchases only. For a purchase over the caller's limits, before buying: moves a `draft` (or `preauth_denied`) purchase to `pending_preauth`. `sheet` saves whatever has been entered so far. Not for refunds.",
		request: {
			params: fpParams,
			...body(
				z
					.object({
						estimated_amount: z.number().positive(),
						reason: note,
						sheet: sheet.optional(),
					})
					.meta({ id: "RequestFieldPurchasePreauth" }),
				{ estimated_amount: 640, reason: "Replacement compressor" },
			),
		},
		responses: {
			200: purchaseOut(),
			400: fpBad(
				"Validation failed, the purchase is past pre-authorization, it's a refund, or the receipt is still being read",
			),
			404: fpNotFound,
		},
	},
	fpRefused("Another technician's purchase"),
);

authed(
	"post",
	"/field-purchases/{id}/preauth-decision",
	"Field Purchases",
	"review_field_purchases",
	{
		summary: "Decide a pre-authorization",
		description:
			"Requires the `review_field_purchases` permission; office users only, and not on their own purchase. Approves (`preauth_approved`) or denies (`preauth_denied`) a `pending_preauth` purchase.",
		request: {
			params: fpParams,
			...body(
				z
					.object({ approve: z.boolean(), note })
					.meta({ id: "FieldPurchasePreauthDecision" }),
				{ approve: true },
			),
		},
		responses: {
			200: purchaseOut(),
			400: fpBad(
				"Validation failed, or the purchase isn't awaiting pre-authorization",
			),
			404: fpNotFound,
		},
	},
	fpRefused("Not an office user, or the caller's own purchase"),
);

authed(
	"post",
	"/field-purchases/{id}/submit",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Submit a purchase for review",
		description:
			"Requires the `request_field_purchase` permission; own purchases only. Applies `sheet` (everything optional; an empty body submits what's saved) and sends the purchase to `pending_review`. Needs a receipt image, at least one line, every line verified and assigned to a job, flagged receipt fields checked, and an active authorization; an amount over the limits needs pre-authorization first. A refund can't credit more than the original purchase, or jobs it didn't cover. `flags` lists anything the reviewer should look at (e.g. a duplicate receipt).",
		request: { params: fpParams, ...body(sheet) },
		responses: {
			200: json(
				envelope(
					z.object({
						purchase: fieldPurchase,
						flags: z.array(z.record(z.string(), z.unknown())),
					}),
				),
				"Submitted",
			),
			400: fpBad(
				"A requirement above isn't met, the status can't be submitted, or validation failed",
			),
			404: fpNotFound,
		},
	},
	fpRefused("Another technician's purchase"),
);

authed(
	"post",
	"/field-purchases/{id}/review",
	"Field Purchases",
	"review_field_purchases",
	{
		summary: "Review a purchase",
		description:
			"Requires the `review_field_purchases` permission; office users only, and not on their own purchase. Decides a `pending_review` purchase: `approve` (to `approved`, or `pending_second_signoff` when the total is at or over the organization's sign-off threshold), `query` (back to the technician, needs a `note`) or `reject`.",
		request: {
			params: fpParams,
			...body(
				z
					.object({
						decision: z.enum(["approve", "query", "reject"]),
						note,
					})
					.meta({ id: "FieldPurchaseReview" }),
				{
					decision: "query",
					note: "Which job was the second filter for?",
				},
			),
		},
		responses: {
			200: purchaseOut(),
			400: fpBad(
				"Validation failed, a query without a note, or the purchase isn't awaiting review",
			),
			404: fpNotFound,
		},
	},
	fpRefused("Not an office user, or the caller's own purchase"),
);

authed(
	"patch",
	"/field-purchases/{id}/lines/{lineId}/job",
	"Field Purchases",
	"review_field_purchases",
	{
		summary: "Move a line to another job",
		description:
			"Requires the `review_field_purchases` permission; office users only. While the purchase is under review, reassigns one line to another job the receipt covers; the charge moves with it.",
		request: {
			params: fpParams.extend({ lineId: z.uuid() }),
			...body(
				z
					.object({ job_id: z.uuid() })
					.meta({ id: "AssignFieldPurchaseLineJob" }),
			),
		},
		responses: {
			200: purchaseOut(),
			400: fpBad(
				"Not under review, the line isn't on this purchase, the receipt doesn't cover that job, or validation failed",
			),
			404: fpNotFound,
		},
	},
	fpRefused("Not an office user"),
);

authed(
	"patch",
	"/field-purchases/{id}/supplier",
	"Field Purchases",
	"review_field_purchases",
	{
		summary: "Link a purchase to a supplier",
		description:
			"Requires the `review_field_purchases` permission; office users only.",
		request: {
			params: fpParams,
			...body(
				z
					.object({ supplier_id: z.uuid() })
					.meta({ id: "LinkFieldPurchaseSupplier" }),
			),
		},
		responses: {
			200: purchaseOut(),
			400: fpBad("Unknown supplier, or validation failed"),
			404: fpNotFound,
		},
	},
	fpRefused("Not an office user"),
);

authed(
	"post",
	"/field-purchases/refunds",
	"Field Purchases",
	"request_field_purchase",
	{
		summary: "Start a refund",
		description:
			"Requires the `request_field_purchase` permission. Creates a draft refund against one of the caller's own `approved` purchases; fill in its credit slip and lines and submit it like a purchase.",
		request: {
			...body(
				z
					.object({ parent_purchase_id: z.uuid(), reason: note })
					.meta({ id: "CreateFieldPurchaseRefund" }),
			),
		},
		responses: {
			201: purchaseOut("The refund (a draft)"),
			400: fpBad(
				"The parent is a refund or isn't approved, or validation failed",
			),
			404: json(errorEnvelope, "Purchase not found (`NOT_FOUND`)"),
		},
	},
	fpRefused("Another technician's purchase"),
);

authed(
	"post",
	"/field-purchases/{id}/settle",
	"Field Purchases",
	"review_field_purchases",
	{
		summary: "Settle a refund",
		description:
			"Requires the `review_field_purchases` permission; office users only. Records that an approved refund's money actually came back.",
		request: { params: fpParams },
		responses: {
			200: purchaseOut(),
			400: fpBad("Not a refund, not approved, or already settled"),
			404: fpNotFound,
		},
	},
	fpRefused("Not an office user"),
);

authed(
	"post",
	"/field-purchases/{id}/second-signoff",
	"Field Purchases",
	"second_sign_off_field_purchases",
	{
		summary: "Second sign-off on a purchase",
		description:
			"Requires the `second_sign_off_field_purchases` permission; office users only, not on their own purchase and not one they approved. Approves or rejects a `pending_second_signoff` purchase; rejecting needs a `note`.",
		request: {
			params: fpParams,
			...body(
				z
					.object({ approve: z.boolean(), note })
					.meta({ id: "FieldPurchaseSecondSignoff" }),
				{ approve: true },
			),
		},
		responses: {
			200: purchaseOut(),
			400: fpBad(
				"Not awaiting a second sign-off, a refusal without a note, or validation failed",
			),
			404: fpNotFound,
		},
	},
	fpRefused(
		"Not an office user, the caller's own purchase, or one they approved",
	),
);
