import { randomUUID } from "node:crypto";
import { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { log } from "../appLogger.js";
import { inventoryImportDuplicatesPrevented, inventoryImportDuration, inventoryImportEvents } from "../metricsService.js";
import { extractInventoryDocument } from "./documentExtractor.js";
import { mapInventoryFields } from "./fieldMapper.js";
import { candidateIdentity, matchInventoryCandidate } from "./matcher.js";
import { normalizeInventoryRow } from "./normalizer.js";
import { loadImportSource } from "./sourceStorage.js";
import { parseSpreadsheet } from "./spreadsheetParser.js";
import { InventoryImportError, type ExtractedInventoryRow, type InventoryProposal } from "./types.js";

const LEASE_MS = Number(process.env.INVENTORY_IMPORT_LEASE_MS ?? 5 * 60_000);
const POLL_MS = Number(process.env.INVENTORY_IMPORT_PROCESSOR_POLL_MS ?? 5_000);

function json(value: unknown): Prisma.InputJsonValue {
	return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function baseVariantName(name: string | undefined): string | null {
	if (!name) return null;
	const stripped = name
		.toLowerCase()
		.replace(/\([^)]*\)/g, " ")
		.replace(/\b\d+(?:\.\d+)?\s*(?:in|inch|ft|oz|lb|gal|l|ml|mm|cm|kw|ton|btuh?|v|amp)s?\b/g, " ")
		.replace(/\b(?:black|white|red|blue|green|gray|grey|silver|small|medium|large|xl)\b/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return stripped || null;
}

export async function recomputeImportSummary(importId: string, organizationId: string): Promise<void> {
	const candidates = await db.inventory_import_candidate.findMany({
		where: { import_id: importId, organization_id: organizationId },
		select: { proposed_action: true, low_confidence: true },
	});
	const count = (action: "create" | "update" | "skip" | "conflict") =>
		candidates.filter((candidate) => candidate.proposed_action === action).length;
	await db.inventory_import.update({
		where: { id: importId, organization_id: organizationId },
		data: {
			total_count: candidates.length,
			create_count: count("create"),
			update_count: count("update"),
			skip_count: count("skip"),
			conflict_count: count("conflict"),
			low_confidence_count: candidates.filter((candidate) => candidate.low_confidence).length,
		},
	});
}

async function claimImport(importId?: string): Promise<{ id: string; organization_id: string; claim_token: string } | null> {
	const now = new Date();
	const candidate = await db.inventory_import.findFirst({
		where: {
			...(importId ? { id: importId } : {}),
			OR: [
				{ status: "uploaded" },
				{ status: "processing", lease_expires_at: { lt: now } },
			],
		},
		orderBy: { created_at: "asc" },
		select: { id: true, organization_id: true },
	});
	if (!candidate) return null;
	const claimToken = randomUUID();
	const claimed = await db.inventory_import.updateMany({
		where: {
			id: candidate.id,
			organization_id: candidate.organization_id,
			OR: [
				{ status: "uploaded" },
				{ status: "processing", lease_expires_at: { lt: now } },
			],
		},
		data: {
			status: "processing",
			claim_token: claimToken,
			lease_expires_at: new Date(Date.now() + LEASE_MS),
			processing_started_at: now,
			attempt_count: { increment: 1 },
			error_code: null,
			error_message: null,
			retryable: false,
		},
	});
	return claimed.count === 1 ? { ...candidate, claim_token: claimToken } : null;
}

async function refreshLease(importId: string, claimToken: string): Promise<void> {
	const result = await db.inventory_import.updateMany({
		where: { id: importId, status: "processing", claim_token: claimToken },
		data: { lease_expires_at: new Date(Date.now() + LEASE_MS) },
	});
	if (result.count !== 1) throw new InventoryImportError("Import processing lease was lost", "LEASE_LOST", 409, true);
}

async function extractRows(source: {
	storage_url: string;
	storage_key: string;
	mime_type: string;
	original_filename: string;
	source_type: string;
}): Promise<{ rows: ExtractedInventoryRow[]; metadata: Record<string, unknown> }> {
	const buffer = await loadImportSource(source.storage_url, source.storage_key);
	if (source.source_type === "spreadsheet" || source.source_type === "csv") {
		const result = parseSpreadsheet(buffer);
		return { rows: result.rows, metadata: result.metadata };
	}
	const result = await extractInventoryDocument(buffer, source.mime_type, source.original_filename);
	return { rows: result.rows, metadata: result.metadata };
}

export async function markWithinImportDuplicates(importId: string, organizationId: string): Promise<void> {
	const candidates = await db.inventory_import_candidate.findMany({
		where: { import_id: importId, organization_id: organizationId },
		select: { id: true, normalized_proposal: true, matching_evidence: true },
	});
	const groups = new Map<string, typeof candidates>();
	for (const candidate of candidates) {
		const identity = candidateIdentity(candidate.normalized_proposal as unknown as InventoryProposal);
		if (!identity) continue;
		groups.set(identity, [...(groups.get(identity) ?? []), candidate]);
	}
	for (const [identity, members] of groups) {
		if (members.length < 2) continue;
		inventoryImportDuplicatesPrevented.add(members.length, { kind: "within_import" });
		for (const candidate of members) {
			await db.inventory_import_candidate.update({
				where: { id: candidate.id },
				data: {
					proposed_action: "conflict",
					duplicate_group: identity,
					matching_evidence: json({
						...object(candidate.matching_evidence),
						tier: "within_import",
						reason: "Multiple uploaded rows share the same stable identity",
						candidate_ids: members.map((member) => member.id),
					}),
				},
			});
		}
	}
}

function object(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

async function processClaim(claim: { id: string; organization_id: string; claim_token: string }): Promise<void> {
	const record = await db.inventory_import.findFirst({
		where: { id: claim.id, organization_id: claim.organization_id, claim_token: claim.claim_token },
		include: { sources: { orderBy: { created_at: "asc" } } },
	});
	if (!record) return;
	await db.inventory_import_candidate.deleteMany({ where: { import_id: record.id, organization_id: record.organization_id } });
	const matchCache = {};

	for (const source of record.sources) {
		await refreshLease(record.id, claim.claim_token);
		await db.inventory_import_source.update({
			where: { id: source.id },
			data: { extraction_status: "processing", error_message: null },
		});

		try {
			const identical = await db.inventory_import_source.findFirst({
				where: {
					organization_id: record.organization_id,
					sha256: source.sha256,
					id: { not: source.id },
					import_record: { status: { in: ["committed", "undone"] } },
				},
				select: { import_id: true },
			});
			const extracted = await extractRows(source);
			await refreshLease(record.id, claim.claim_token);
			const prepared: Array<{
				row: ExtractedInventoryRow;
				mapped: Awaited<ReturnType<typeof mapInventoryFields>>;
				normalized: ReturnType<typeof normalizeInventoryRow>;
			}> = [];
			for (let rowIndex = 0; rowIndex < extracted.rows.length; rowIndex += 1) {
				if (rowIndex > 0 && rowIndex % 250 === 0) await refreshLease(record.id, claim.claim_token);
				const row = extracted.rows[rowIndex];
				const mapped = await mapInventoryFields(row);
				prepared.push({ row, mapped, normalized: normalizeInventoryRow(mapped) });
			}

			const identities = new Map<string, number>();
			for (let candidateIndex = 0; candidateIndex < prepared.length; candidateIndex += 1) {
				if (candidateIndex > 0 && candidateIndex % 250 === 0) await refreshLease(record.id, claim.claim_token);
				const entry = prepared[candidateIndex];
				const identity = candidateIdentity(entry.normalized.proposal);
				if (identity) identities.set(identity, (identities.get(identity) ?? 0) + 1);
			}
			const variantCounts = new Map<string, number>();
			for (const entry of prepared) {
				const base = baseVariantName(entry.normalized.proposal.name);
				if (base) variantCounts.set(base, (variantCounts.get(base) ?? 0) + 1);
			}

			for (const entry of prepared) {
				const proposal = entry.normalized.proposal;
				const identity = candidateIdentity(proposal);
				const duplicateGroup = identity && (identities.get(identity) ?? 0) > 1 ? identity : undefined;
				let match = await matchInventoryCandidate(record.organization_id, proposal, duplicateGroup, matchCache);
				if (entry.normalized.issues.length > 0) {
					match = { ...match, action: "conflict", evidence: { ...match.evidence, validation: true } };
				}
				if (identical) {
					inventoryImportDuplicatesPrevented.add(1, { kind: "identical_file" });
					match = { action: "conflict", evidence: { ...match.evidence, identical_prior_import_id: identical.import_id } };
				}
				if (!duplicateGroup && match.action === "update") inventoryImportDuplicatesPrevented.add(1, { kind: "existing_item" });
				if (source.source_type === "product_photo") {
					match = {
						...match,
						action: "conflict",
						evidence: { ...match.evidence, photo_review_required: true, filename_tokens: source.original_filename.split(/[^a-z0-9]+/i).filter(Boolean) },
					};
				}
				const base = baseVariantName(proposal.name);
				const variantSuggestion = base && (variantCounts.get(base) ?? 0) > 1
					? { display_name: base, candidate_count: variantCounts.get(base), requires_approval: true }
					: undefined;

				await db.inventory_import_candidate.create({
					data: {
						organization_id: record.organization_id,
						import_id: record.id,
						source_id: source.id,
						sheet_name: entry.row.sheetName,
						row_number: entry.row.rowNumber,
						page_number: entry.row.pageNumber,
						image_index: entry.row.imageIndex,
						...(entry.row.ocrBounds ? { ocr_bounds: json(entry.row.ocrBounds) } : {}),
						raw_values: json(entry.row.raw),
						normalized_proposal: json(proposal),
						field_confidence: json(entry.mapped.fieldConfidence),
						field_evidence: json(entry.mapped.fieldEvidence),
						matching_evidence: json(match.evidence),
						proposed_action: match.action,
						existing_item_id: match.existingItemId,
						existing_quantity_at_review: match.existingQuantity,
						duplicate_group: match.duplicateGroup,
						...(variantSuggestion ? { variant_group_suggestion: json(variantSuggestion) } : {}),
						validation_issues: json(entry.normalized.issues),
						low_confidence: entry.normalized.lowConfidence,
						financial_fields: entry.normalized.financialFields,
						requires_financial_approval: entry.normalized.financialFields.length > 0,
					},
				});
			}

			await db.inventory_import_source.update({
				where: { id: source.id },
				data: {
					extraction_status: "extracted",
					extraction_metadata: json({ ...extracted.metadata, ...(identical ? { identical_prior_import_id: identical.import_id } : {}) }),
				},
			});
		} catch (error) {
			const importError = error instanceof InventoryImportError
				? error
				: new InventoryImportError("Import processing failed. Retry the import or replace the source file.", "PROCESSING_FAILED", 500, true);
			await db.inventory_import_source.update({
				where: { id: source.id },
				data: { extraction_status: "failed", error_message: importError.message },
			});
			throw importError;
		}
	}

	await markWithinImportDuplicates(record.id, record.organization_id);
	await recomputeImportSummary(record.id, record.organization_id);
	await db.inventory_import.updateMany({
		where: { id: record.id, organization_id: record.organization_id, status: "processing", claim_token: claim.claim_token },
		data: {
			status: "ready_for_review",
			ready_at: new Date(),
			claim_token: null,
			lease_expires_at: null,
			retryable: false,
			revision: { increment: 1 },
		},
	});
	inventoryImportEvents.add(1, { event: "ready" });
	inventoryImportDuration.record((Date.now() - record.created_at.getTime()) / 1000, { stage: "ready" });
}

export async function processInventoryImport(importId?: string): Promise<boolean> {
	const claim = await claimImport(importId);
	if (!claim) return false;
	try {
		await processClaim(claim);
	} catch (error) {
		const importError = error instanceof InventoryImportError
			? error
			: new InventoryImportError("Import processing failed. Retry the import or replace the source file.", "PROCESSING_FAILED", 500, true);
		log.warn({ importId: claim.id, code: importError.code }, "inventory import processing failed");
		inventoryImportEvents.add(1, { event: "failed", code: importError.code });
		await db.inventory_import.updateMany({
			where: { id: claim.id, organization_id: claim.organization_id, claim_token: claim.claim_token },
			data: {
				status: "failed",
				error_code: importError.code,
				error_message: importError.message,
				retryable: importError.retryable,
				claim_token: null,
				lease_expires_at: null,
			},
		});
	}
	return true;
}

let processorTimer: NodeJS.Timeout | undefined;

export function startInventoryImportProcessor(): void {
	if (processorTimer || process.env.NODE_ENV === "test") return;
	processorTimer = setInterval(() => {
		void processInventoryImport();
	}, POLL_MS);
	processorTimer.unref();
	void processInventoryImport();
}

export function queueInventoryImport(importId: string): void {
	setImmediate(() => void processInventoryImport(importId));
}
