import { z } from "zod";

export const importHistoryQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	page_size: z.coerce.number().int().min(1).max(100).default(25),
	status: z.enum(["uploaded", "processing", "ready_for_review", "committing", "committed", "undoing", "undone", "failed", "cancelled"]).optional(),
});

export const candidateQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(1),
	page_size: z.coerce.number().int().min(1).max(200).default(50),
	action: z.enum(["create", "update", "skip", "conflict"]).optional(),
	low_confidence: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
	selected: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
	search: z.string().trim().max(100).optional(),
});

export const patchCandidateSchema = z.object({
	revision: z.number().int().positive(),
	proposed_action: z.enum(["create", "update", "skip", "conflict"]).optional(),
	existing_item_id: z.string().uuid().nullable().optional(),
	selected: z.boolean().optional(),
	accept_non_financial: z.boolean().optional(),
	values: z.record(z.string(), z.unknown()).optional(),
}).refine((body) => Object.keys(body).some((key) => key !== "revision"), "At least one candidate change is required");

export const approveFinancialSchema = z.object({
	revision: z.number().int().positive(),
	candidate_ids: z.array(z.string().uuid()).max(10_000).optional(),
});

export const commitImportSchema = z.object({
	revision: z.number().int().positive(),
});

export const retryImportSchema = z.object({
	revision: z.number().int().positive().optional(),
});
