import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Express } from "express";
import { Prisma } from "../../generated/prisma/client.js";
import { db } from "../db.js";
import { getUserContext } from "../lib/context.js";
import {
	approveFinancialSchema,
	candidateQuerySchema,
	commitImportSchema,
	importHistoryQuerySchema,
	patchCandidateSchema,
	retryImportSchema,
} from "../lib/validate/inventoryImports.js";
import { logActivity } from "../services/logger.js";
import { inventoryImportConflicts, inventoryImportEvents, inventoryImportMappingDecisions } from "../services/metricsService.js";
import { commitInventoryImport, undoInventoryImport } from "../services/inventoryImport/commitInventoryImport.js";
import { normalizeInventoryRow } from "../services/inventoryImport/normalizer.js";
import { queueInventoryImport, recomputeImportSummary } from "../services/inventoryImport/processor.js";
import { storeImportSource } from "../services/inventoryImport/sourceStorage.js";
import { FINANCIAL_FIELDS, InventoryImportError } from "../services/inventoryImport/types.js";
import { createSuccessResponse } from "../types/responses.js";

export function inventoryImportEnabled(): boolean {
	return ["1", "true", "yes", "on"].includes((process.env.INVENTORY_AI_IMPORT_ENABLED ?? "").toLowerCase());
}

function orgId(req: Request): string {
	const id = req.user?.organization_id;
	if (!id) throw new InventoryImportError("Organization is required", "FORBIDDEN", 403);
	return String(id);
}

function dispatcherId(req: Request): string | undefined {
	return req.user?.role === "dispatcher" || req.user?.role === "admin" ? String(req.user.uid) : undefined;
}

function assertEnabled(): void {
	if (!inventoryImportEnabled()) throw new InventoryImportError("Inventory import drafts are not enabled", "FEATURE_DISABLED", 404);
}

function sourceType(file: Express.Multer.File): "spreadsheet" | "csv" | "pdf" | "invoice_image" | "product_photo" {
	const extension = file.originalname.split(".").pop()?.toLowerCase();
	if (extension === "csv" || file.mimetype.includes("csv")) return "csv";
	if (["xlsx", "xls"].includes(extension ?? "")) return "spreadsheet";
	if (extension === "pdf" || file.mimetype === "application/pdf") return "pdf";
	return /invoice|receipt|packing[-_ ]?slip/i.test(file.originalname) ? "invoice_image" : "product_photo";
}

function parse<S extends { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } } }>(schema: S, value: unknown) {
	const result = schema.safeParse(value);
	if (!result.success) throw new InventoryImportError(result.error!.issues.map((issue) => issue.message).join(", "), "VALIDATION_ERROR", 400);
	return result.data as never;
}

function object(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export async function createImport(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const files = req.files as Express.Multer.File[] | undefined;
		if (!files?.length) throw new InventoryImportError("At least one file[] is required", "VALIDATION_ERROR", 400);
		const organizationId = orgId(req);
		const creator = dispatcherId(req);
		const creatorExists = creator ? await db.dispatcher.findFirst({ where: { id: creator, organization_id: organizationId }, select: { id: true } }) : null;
		const record = await db.inventory_import.create({
			data: { organization_id: organizationId, created_by_id: creatorExists?.id },
		});
		try {
			for (const file of files) {
				const stored = await storeImportSource(file.buffer, file.mimetype, file.originalname);
				await db.inventory_import_source.create({
					data: {
						organization_id: organizationId,
						import_id: record.id,
						original_filename: file.originalname,
						mime_type: file.mimetype || "application/octet-stream",
						size_bytes: file.size,
						sha256: createHash("sha256").update(file.buffer).digest("hex"),
						storage_url: stored.url,
						storage_key: stored.key,
						source_type: sourceType(file),
					},
				});
			}
		} catch (error) {
			await db.inventory_import.update({
				where: { id: record.id },
				data: { status: "failed", error_code: "SOURCE_STORAGE_FAILED", error_message: "One or more source files could not be stored", retryable: true },
			});
			throw error;
		}
		await logActivity({
			event_type: "inventory_import.created",
			action: "created",
			entity_type: "inventory_import",
			entity_id: record.id,
			organization_id: organizationId,
			actor_type: creator ? "dispatcher" : "system",
			actor_id: creator,
			changes: { source_count: { old: null, new: files.length } },
		});
		queueInventoryImport(record.id);
		inventoryImportEvents.add(1, { event: "created" });
		res.status(202).json(createSuccessResponse({ id: record.id, status: record.status, revision: record.revision }));
	} catch (error) {
		next(error);
	}
}

export async function listImports(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const query = parse(importHistoryQuerySchema, req.query) as { page: number; page_size: number; status?: string };
		const where = { organization_id: orgId(req), ...(query.status ? { status: query.status as never } : {}) };
		const [items, total] = await Promise.all([
			db.inventory_import.findMany({ where, orderBy: { created_at: "desc" }, skip: (query.page - 1) * query.page_size, take: query.page_size, include: { sources: { select: { id: true, original_filename: true, source_type: true, extraction_status: true } } } }),
			db.inventory_import.count({ where }),
		]);
		res.json(createSuccessResponse(items, { total, page: query.page, pageSize: query.page_size, hasMore: query.page * query.page_size < total }));
	} catch (error) { next(error); }
}

export async function getImport(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const record = await db.inventory_import.findFirst({
			where: { id: String(req.params.id), organization_id: orgId(req) },
			include: { sources: true },
		});
		if (!record) throw new InventoryImportError("Import not found", "NOT_FOUND", 404);
		const reviewRows = await db.inventory_import_candidate.findMany({
			where: {
				import_id: record.id,
				organization_id: record.organization_id,
				selected: true,
			},
			select: {
				proposed_action: true,
				validation_issues: true,
				requires_financial_approval: true,
				financial_approved_at: true,
				normalized_proposal: true,
				user_overrides: true,
			},
		});
		const actionableRows = reviewRows.filter((candidate) =>
			candidate.proposed_action === "create" || candidate.proposed_action === "update",
		);
		const blocking = reviewRows.filter((candidate) =>
			candidate.proposed_action !== "skip" && (
				candidate.proposed_action === "conflict" ||
				Array.isArray(candidate.validation_issues) && candidate.validation_issues.length > 0 ||
				candidate.requires_financial_approval && !candidate.financial_approved_at
			)
		).length;
		const financialRows = reviewRows.filter((candidate) => candidate.requires_financial_approval && candidate.proposed_action !== "skip");
		const financialSummary = financialRows.reduce((summary, candidate) => {
			const proposal = { ...object(candidate.normalized_proposal), ...object(candidate.user_overrides) };
			for (const field of FINANCIAL_FIELDS) {
				const value = Number(proposal[field]);
				if (Number.isFinite(value)) summary[`${field}_total`] += value;
			}
			if (!candidate.financial_approved_at) summary.unapproved_count += 1;
			return summary;
		}, { row_count: financialRows.length, unapproved_count: 0, quantity_total: 0, cost_total: 0, unit_price_total: 0, cost_at_receipt_total: 0 } as Record<string, number>);
		res.json(createSuccessResponse({
			...record,
			blocking_count: blocking,
			actionable_count: actionableRows.length,
			financial_summary: financialSummary,
		}));
	} catch (error) { next(error); }
}

export async function listCandidates(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const organizationId = orgId(req);
		const importId = String(req.params.id);
		const exists = await db.inventory_import.findFirst({ where: { id: importId, organization_id: organizationId }, select: { id: true } });
		if (!exists) throw new InventoryImportError("Import not found", "NOT_FOUND", 404);
		const query = parse(candidateQuerySchema, req.query) as { page: number; page_size: number; action?: string; low_confidence?: boolean; selected?: boolean; search?: string };
		const where: Prisma.inventory_import_candidateWhereInput = {
			organization_id: organizationId,
			import_id: importId,
			...(query.action ? { proposed_action: query.action as never } : {}),
			...(query.low_confidence !== undefined ? { low_confidence: query.low_confidence } : {}),
			...(query.selected !== undefined ? { selected: query.selected } : {}),
			...(query.search ? {
				OR: [
					{ normalized_proposal: { path: ["name"], string_contains: query.search } },
					{ existing_item: { name: { contains: query.search, mode: "insensitive" } } },
				],
			} : {}),
		};
		const [items, total] = await Promise.all([
			db.inventory_import_candidate.findMany({
				where,
				orderBy: [{ source_id: "asc" }, { sheet_name: "asc" }, { row_number: "asc" }, { created_at: "asc" }],
				skip: (query.page - 1) * query.page_size,
				take: query.page_size,
				include: {
					source: { select: { id: true, original_filename: true, source_type: true } },
					existing_item: { select: { id: true, name: true, sku: true, barcode: true, quantity: true, unit: true, location: true, cost: true, unit_price: true } },
				},
			}),
			db.inventory_import_candidate.count({ where }),
		]);
		res.json(createSuccessResponse(items, { total, page: query.page, pageSize: query.page_size, hasMore: query.page * query.page_size < total }));
	} catch (error) { next(error); }
}

export async function patchCandidate(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const organizationId = orgId(req);
		const importId = String(req.params.id);
		const candidateId = String(req.params.candidateId);
		const body = parse(patchCandidateSchema, req.body) as {
			revision: number;
			proposed_action?: "create" | "update" | "skip" | "conflict";
			existing_item_id?: string | null;
			selected?: boolean;
			accept_non_financial?: boolean;
			values?: Record<string, unknown>;
		};
		const updated = await db.$transaction(async (tx) => {
			const record = await tx.inventory_import.findFirst({ where: { id: importId, organization_id: organizationId }, select: { status: true } });
			if (!record) throw new InventoryImportError("Import not found", "NOT_FOUND", 404);
			if (record.status !== "ready_for_review") throw new InventoryImportError("Import is not editable", "INVALID_STATUS", 409);
			const current = await tx.inventory_import_candidate.findFirst({ where: { id: candidateId, import_id: importId, organization_id: organizationId } });
			if (!current) throw new InventoryImportError("Candidate not found", "NOT_FOUND", 404);
			const mergedValues = { ...object(current.user_overrides), ...(body.values ?? {}) };
			const normalized = normalizeInventoryRow({
				proposal: { ...object(current.normalized_proposal), ...mergedValues },
				fieldConfidence: Object.fromEntries(Object.keys({ ...object(current.normalized_proposal), ...mergedValues }).map((field) => [field, 1])),
				fieldEvidence: {},
			});
			const normalizedOverrides = { ...object(current.user_overrides) };
			for (const [field, rawValue] of Object.entries(body.values ?? {})) {
				normalizedOverrides[field] = Object.prototype.hasOwnProperty.call(normalized.proposal, field)
					? normalized.proposal[field as keyof typeof normalized.proposal]
					: rawValue;
			}
			let matchData: Record<string, unknown> = {};
			if (body.existing_item_id !== undefined) {
				if (body.existing_item_id) {
					const item = await tx.inventory_item.findFirst({ where: { id: body.existing_item_id, organization_id: organizationId }, select: { id: true, quantity: true, updated_at: true } });
					if (!item) throw new InventoryImportError("Selected inventory item was not found", "MATCH_REQUIRED", 409);
					matchData = {
						existing_item_id: item.id,
						existing_quantity_at_review: item.quantity,
						matching_evidence: plainJson({ ...object(current.matching_evidence), tier: "user_selected", existing_updated_at: item.updated_at.toISOString() }),
					};
				} else {
					matchData = { existing_item_id: null, existing_quantity_at_review: null };
				}
			}
			const touchedFinancial = Object.keys(body.values ?? {}).some((field) => (FINANCIAL_FIELDS as readonly string[]).includes(field));
			const financialImpactChanged = touchedFinancial ||
				body.proposed_action !== undefined ||
				body.existing_item_id !== undefined;
			const result = await tx.inventory_import_candidate.updateMany({
				where: { id: candidateId, import_id: importId, organization_id: organizationId, revision: body.revision },
				data: {
					...(body.proposed_action ? { proposed_action: body.proposed_action } : {}),
					...(body.selected !== undefined ? { selected: body.selected } : {}),
					...(body.accept_non_financial && current.financial_fields.length === 0 ? { low_confidence: false } : {}),
					...matchData,
					user_overrides: plainJson(normalizedOverrides),
					validation_issues: plainJson(normalized.issues),
					financial_fields: [...new Set([...current.financial_fields, ...normalized.financialFields])],
					requires_financial_approval: current.requires_financial_approval || normalized.financialFields.length > 0,
					...(financialImpactChanged ? { financial_approved_at: null, financial_approved_by_id: null } : {}),
					revision: { increment: 1 },
				},
			});
			if (result.count !== 1) throw new InventoryImportError("Candidate changed since it was loaded", "STALE_REVISION", 409);
			await tx.inventory_import.update({ where: { id: importId }, data: { revision: { increment: 1 }, financial_approved_at: financialImpactChanged ? null : undefined, financial_approved_by_id: financialImpactChanged ? null : undefined } });
			return tx.inventory_import_candidate.findFirst({ where: { id: candidateId, organization_id: organizationId }, include: { existing_item: true, source: true } });
		});
		await recomputeImportSummary(importId, organizationId);
		inventoryImportMappingDecisions.add(1, { decision: body.values ? "edited" : "accepted" });
		res.json(createSuccessResponse(updated));
	} catch (error) { next(error); }
}

function plainJson(value: unknown): Prisma.InputJsonValue {
	return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function approveFinancial(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const organizationId = orgId(req);
		const importId = String(req.params.id);
		const approver = dispatcherId(req);
		if (!approver) throw new InventoryImportError("A dispatcher must approve financial values", "FORBIDDEN", 403);
		const body = parse(approveFinancialSchema, req.body) as { revision: number; candidate_ids?: string[] };
		const approved = await db.$transaction(async (tx) => {
			const record = await tx.inventory_import.findFirst({ where: { id: importId, organization_id: organizationId } });
			if (!record) throw new InventoryImportError("Import not found", "NOT_FOUND", 404);
			if (record.status !== "ready_for_review") throw new InventoryImportError("Import is not ready for approval", "INVALID_STATUS", 409);
			if (record.revision !== body.revision) throw new InventoryImportError("Import changed since it was loaded", "STALE_REVISION", 409);
			const now = new Date();
			const result = await tx.inventory_import_candidate.updateMany({
				where: {
					organization_id: organizationId,
					import_id: importId,
					selected: true,
					requires_financial_approval: true,
					proposed_action: { in: ["create", "update"] },
					...(body.candidate_ids ? { id: { in: body.candidate_ids } } : {}),
				},
				data: { financial_approved_by_id: approver, financial_approved_at: now, revision: { increment: 1 } },
			});
			const nextRecord = await tx.inventory_import.update({
				where: { id: importId },
				data: { financial_approved_by_id: approver, financial_approved_at: now, revision: { increment: 1 } },
			});
			return { approved_count: result.count, revision: nextRecord.revision, approved_at: now };
		});
		res.json(createSuccessResponse(approved));
	} catch (error) { next(error); }
}

export async function retryImport(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		parse(retryImportSchema, req.body);
		const organizationId = orgId(req);
		const importId = String(req.params.id);
		const result = await db.inventory_import.updateMany({
			where: { id: importId, organization_id: organizationId, status: "failed", retryable: true },
			data: { status: "uploaded", error_code: null, error_message: null, claim_token: null, lease_expires_at: null, revision: { increment: 1 } },
		});
		if (result.count !== 1) throw new InventoryImportError("Import cannot be retried", "INVALID_STATUS", 409);
		await db.inventory_import_source.updateMany({ where: { import_id: importId, organization_id: organizationId, extraction_status: "failed" }, data: { extraction_status: "pending", error_message: null } });
		queueInventoryImport(importId);
		res.status(202).json(createSuccessResponse({ id: importId, status: "uploaded" }));
	} catch (error) { next(error); }
}

export async function commitImport(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const body = parse(commitImportSchema, req.body) as { revision: number };
		const result = await commitInventoryImport({ importId: String(req.params.id), organizationId: orgId(req), revision: body.revision, dispatcherId: dispatcherId(req) });
		res.json(createSuccessResponse(result));
	} catch (error) {
		if (error instanceof InventoryImportError && error.statusCode === 409) inventoryImportConflicts.add(1, { operation: "commit", code: error.code });
		next(error);
	}
}

export async function undoImport(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const result = await undoInventoryImport({ importId: String(req.params.id), organizationId: orgId(req), dispatcherId: dispatcherId(req) });
		res.json(createSuccessResponse(result));
	} catch (error) {
		if (error instanceof InventoryImportError && error.statusCode === 409) inventoryImportConflicts.add(1, { operation: "undo", code: error.code });
		next(error);
	}
}

export async function cancelImport(req: Request, res: Response, next: NextFunction) {
	try {
		assertEnabled();
		const organizationId = orgId(req);
		const importId = String(req.params.id);
		const result = await db.inventory_import.updateMany({
			where: { id: importId, organization_id: organizationId, status: { in: ["uploaded", "processing", "ready_for_review", "failed"] } },
			data: { status: "cancelled", claim_token: null, lease_expires_at: null, revision: { increment: 1 } },
		});
		if (result.count !== 1) throw new InventoryImportError("Import cannot be cancelled", "INVALID_STATUS", 409);
		inventoryImportEvents.add(1, { event: "abandoned" });
		res.json(createSuccessResponse({ id: importId, status: "cancelled" }));
	} catch (error) { next(error); }
}
