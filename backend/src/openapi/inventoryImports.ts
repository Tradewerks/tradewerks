import z from "zod";
import { authed, envelope, errorEnvelope, json, moduleOff } from "./shared.js";
import {
	badQuery,
	inventoryOff,
	manageInvText,
	viewInv,
	viewInvText,
} from "./inventory.js";

// Draft imports: upload files, review the extracted rows, then commit. Off unless the
// server sets INVENTORY_AI_IMPORT_ENABLED.
const importsOff = json(
	errorEnvelope,
	"Draft imports aren't enabled on this server (`FEATURE_DISABLED`)",
);
const importParams = z.object({ id: z.uuid() });
const importNotFound = json(errorEnvelope, "Import not found (`NOT_FOUND`)");
const importStatus = z.enum([
	"uploaded",
	"processing",
	"ready_for_review",
	"committing",
	"committed",
	"undoing",
	"undone",
	"failed",
	"cancelled",
]);
const importRecord = z
	.record(z.string(), z.unknown())
	.describe(
		"The import: `id`, `status`, `revision`, `error_code`, `error_message`, `retryable`, `committed_at`, `undo_expires_at`, `created_at` and more",
	);
const pageMeta = z.object({
	timestamp: z.string(),
	total: z.number().int(),
	page: z.number().int(),
	pageSize: z.number().int(),
	hasMore: z.boolean(),
});
const importsIntro =
	"Off unless the server sets `INVENTORY_AI_IMPORT_ENABLED` (404 `FEATURE_DISABLED`).";

authed(
	"post",
	"/inventory/imports",
	"Inventory",
	"manage_inventory",
	{
		summary: "Start a draft import",
		description: `${manageInvText} ${importsIntro} Upload spreadsheets, CSVs, PDFs or photos (invoices, packing slips, products) as \`files[]\`; rows are extracted in the background. Poll \`GET /inventory/imports/{id}\` until the status is \`ready_for_review\` (or \`failed\`). Up to 20 files of 10 MB each by default.`,
		request: {
			body: {
				content: {
					"multipart/form-data": {
						schema: z.object({
							"files[]": z
								.array(z.string().meta({ format: "binary" }))
								.describe(
									"xlsx, xls, csv, pdf, png, jpg, jpeg, webp, heic or heif",
								),
						}),
					},
				},
			},
		},
		responses: {
			202: json(
				envelope(
					z.object({
						id: z.uuid(),
						status: importStatus,
						revision: z.number().int(),
					}),
				),
				"Accepted; processing has started",
			),
			400: json(
				errorEnvelope,
				"No files, or an unsupported file type (`VALIDATION_ERROR`, `INVALID_IMPORT_SOURCE`)",
			),
			404: importsOff,
			413: json(
				errorEnvelope,
				"Too many files, or a file is too big (`UPLOAD_LIMIT_EXCEEDED`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/imports",
	"Inventory",
	viewInv,
	{
		summary: "List draft imports",
		description: `${viewInvText} ${importsIntro} Newest first, with each import's files.`,
		request: {
			query: z.object({
				page: z.coerce
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Default 1"),
				page_size: z.coerce
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Default 25"),
				status: importStatus.optional(),
			}),
		},
		responses: {
			200: json(
				envelope(z.array(importRecord)).extend({ meta: pageMeta }),
				"A page of imports",
			),
			400: badQuery,
			404: importsOff,
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/imports/{id}",
	"Inventory",
	viewInv,
	{
		summary: "Get a draft import",
		description: `${viewInvText} ${importsIntro} The import and its files, plus \`blocking_count\` (selected rows that must be fixed or approved before commit), \`actionable_count\` (rows that will create or update an item) and \`financial_summary\` (totals of quantity, cost and price on rows needing financial approval).`,
		request: { params: importParams },
		responses: {
			200: json(
				envelope(
					z
						.object({
							blocking_count: z.number().int(),
							actionable_count: z.number().int(),
							financial_summary: z.record(z.string(), z.number()),
						})
						.catchall(z.unknown()),
				),
				"Import",
			),
			404: json(
				errorEnvelope,
				"Import not found, or draft imports are off (`NOT_FOUND`, `FEATURE_DISABLED`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"get",
	"/inventory/imports/{id}/candidates",
	"Inventory",
	viewInv,
	{
		summary: "List an import's rows",
		description: `${viewInvText} ${importsIntro} The extracted rows (candidates) in file order, each with its proposed action (\`create\`, \`update\`, \`skip\`, \`conflict\`), proposed values, validation issues, and the matched existing item.`,
		request: {
			params: importParams,
			query: z.object({
				page: z.coerce
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Default 1"),
				page_size: z.coerce
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe("Default 50"),
				action: z
					.enum(["create", "update", "skip", "conflict"])
					.optional(),
				low_confidence: z.enum(["true", "false"]).optional(),
				selected: z.enum(["true", "false"]).optional(),
				search: z.string().max(100).optional(),
			}),
		},
		responses: {
			200: json(
				envelope(z.array(z.record(z.string(), z.unknown()))).extend({
					meta: pageMeta,
				}),
				"A page of rows",
			),
			400: badQuery,
			404: json(
				errorEnvelope,
				"Import not found, or draft imports are off (`NOT_FOUND`, `FEATURE_DISABLED`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"patch",
	"/inventory/imports/{id}/candidates/{candidateId}",
	"Inventory",
	"manage_inventory",
	{
		summary: "Edit an import row",
		description: `${manageInvText} ${importsIntro} Only while the import is \`ready_for_review\`. Send the row's current \`revision\` and at least one change: \`values\` overrides proposed fields, \`proposed_action\` and \`existing_item_id\` change what happens, \`selected\` includes or leaves out the row. Changing quantity, cost, price, action or match clears any financial approval.`,
		request: {
			params: importParams.extend({ candidateId: z.uuid() }),
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								revision: z.number().int().positive(),
								proposed_action: z
									.enum([
										"create",
										"update",
										"skip",
										"conflict",
									])
									.optional(),
								existing_item_id: z
									.uuid()
									.nullable()
									.optional(),
								selected: z.boolean().optional(),
								accept_non_financial: z.boolean().optional(),
								values: z
									.record(z.string(), z.unknown())
									.optional(),
							})
							.meta({ id: "PatchImportCandidate" }),
						example: {
							revision: 1,
							values: { location: "Shelf B2" },
						},
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(z.record(z.string(), z.unknown())),
				"The updated row",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Import or row not found, or draft imports are off (`NOT_FOUND`, `FEATURE_DISABLED`)",
			),
			409: json(
				errorEnvelope,
				"The import isn't in review, the row changed since loaded, or `existing_item_id` wasn't found (`INVALID_STATUS`, `STALE_REVISION`, `MATCH_REQUIRED`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/imports/{id}/financial-approval",
	"Inventory",
	"manage_inventory",
	{
		summary: "Approve an import's financial values",
		description: `${manageInvText} ${importsIntro} Office users only. Approves quantity, cost and price changes on the selected create/update rows, or only \`candidate_ids\`. Send the import's current \`revision\`.`,
		request: {
			params: importParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({
								revision: z.number().int().positive(),
								candidate_ids: z
									.array(z.uuid())
									.max(10000)
									.optional(),
							})
							.meta({ id: "ApproveImportFinancials" }),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						approved_count: z.number().int(),
						revision: z.number().int(),
						approved_at: z.iso.datetime(),
					}),
				),
				"Approved",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Import not found, or draft imports are off (`NOT_FOUND`, `FEATURE_DISABLED`)",
			),
			409: json(
				errorEnvelope,
				"The import isn't in review, or changed since loaded (`INVALID_STATUS`, `STALE_REVISION`)",
			),
		},
	},
	`${moduleOff("inventory")}; or the caller isn't an office user (\`FORBIDDEN\`)`,
);

authed(
	"post",
	"/inventory/imports/{id}/retry",
	"Inventory",
	"manage_inventory",
	{
		summary: "Retry a failed import",
		description: `${manageInvText} ${importsIntro} Only a \`failed\` import marked \`retryable\`. Files that failed are processed again.`,
		request: {
			params: importParams,
			body: {
				content: {
					"application/json": {
						schema: z.object({
							revision: z.number().int().positive().optional(),
						}),
					},
				},
			},
		},
		responses: {
			202: json(
				envelope(
					z.object({ id: z.uuid(), status: z.literal("uploaded") }),
				),
				"Accepted; processing has restarted",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: importsOff,
			409: json(
				errorEnvelope,
				"Not found, not failed, or not retryable (`INVALID_STATUS`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/imports/{id}/commit",
	"Inventory",
	"manage_inventory",
	{
		summary: "Commit an import",
		description: `${manageInvText} ${importsIntro} Creates and updates the items on every selected row, in one transaction. Send the import's current \`revision\`. Every selected row must be free of conflicts and validation issues, with financial values approved; an updated item must not have changed since review. Committing twice returns the first result with \`idempotent: true\`. Can be undone for 30 minutes by default.`,
		request: {
			params: importParams,
			body: {
				content: {
					"application/json": {
						schema: z
							.object({ revision: z.number().int().positive() })
							.meta({ id: "CommitImport" }),
					},
				},
			},
		},
		responses: {
			200: json(
				envelope(
					z.object({
						id: z.uuid(),
						status: importStatus,
						committed_at: z.iso.datetime().nullable(),
						undo_expires_at: z.iso.datetime().nullable(),
						item_ids: z.array(z.uuid()).optional(),
						idempotent: z.boolean(),
					}),
				),
				"Committed",
			),
			400: json(errorEnvelope, "Validation failed (`VALIDATION_ERROR`)"),
			404: json(
				errorEnvelope,
				"Import not found, or draft imports are off (`NOT_FOUND`, `FEATURE_DISABLED`)",
			),
			409: json(
				errorEnvelope,
				"The import isn't in review, changed since loaded, has nothing selected, has unresolved rows or approvals, or inventory changed underneath it (`INVALID_STATUS`, `STALE_REVISION`, `NOTHING_TO_COMMIT`, `UNRESOLVED_CONFLICTS`, `VALIDATION_ISSUES`, `FINANCIAL_APPROVAL_REQUIRED`, `MATCH_REQUIRED`, `STOCK_CHANGED_SINCE_REVIEW`, `DUPLICATE_IDENTITY_CONFLICT`, `COMMIT_CONFLICT`, …)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/imports/{id}/undo",
	"Inventory",
	"manage_inventory",
	{
		summary: "Undo a committed import",
		description: `${manageInvText} ${importsIntro} Reverses a committed import within its undo window, as long as nothing has used or changed the affected items since. Undoing twice returns \`idempotent: true\`.`,
		request: { params: importParams },
		responses: {
			200: json(
				envelope(
					z.object({
						id: z.uuid(),
						status: z.literal("undone"),
						undone_at: z.iso.datetime().optional(),
						idempotent: z.boolean(),
					}),
				),
				"Undone",
			),
			404: json(
				errorEnvelope,
				"Import not found, or draft imports are off (`NOT_FOUND`, `FEATURE_DISABLED`)",
			),
			409: json(
				errorEnvelope,
				"Not committed, the undo window has passed, or inventory changed since (`INVALID_STATUS`, `UNDO_EXPIRED`, `UNDO_BLOCKED_BY_ACTIVITY`, `UNDO_CONFLICT`)",
			),
		},
	},
	inventoryOff,
);

authed(
	"post",
	"/inventory/imports/{id}/cancel",
	"Inventory",
	"manage_inventory",
	{
		summary: "Cancel a draft import",
		description: `${manageInvText} ${importsIntro} Before commit only.`,
		request: { params: importParams },
		responses: {
			200: json(
				envelope(
					z.object({ id: z.uuid(), status: z.literal("cancelled") }),
				),
				"Cancelled",
			),
			404: importsOff,
			409: json(
				errorEnvelope,
				"Not found, or already committed, undone or cancelled (`INVALID_STATUS`)",
			),
		},
	},
	inventoryOff,
);
