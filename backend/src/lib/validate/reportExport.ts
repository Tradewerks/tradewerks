import { z } from "zod";
import { filterConditionSchema } from "./reportQuery.js";

const exportColumnSchema = z.object({
	key: z.string().min(1),
	label: z.string(),
});

export const exportReportSchema = z.object({
	filename: z.string().trim().min(1, "Filename is required").max(200),
	sheetName: z.string().trim().min(1).max(31).optional(),
	columns: z.array(exportColumnSchema).min(1, "At least one column is required"),
	rows: z.array(z.record(z.string(), z.unknown())),
});

// Server-side export
export const exportServerSchema = z.object({
	report: z.string().min(1),
	filename: z.string().trim().min(1, "Filename is required").max(200),
	sheetName: z.string().trim().min(1).max(31).optional(),
	columns: z.array(exportColumnSchema).min(1, "At least one column is required"),
	startDate: z.string().optional(),
	endDate: z.string().optional(),
	includeInactive: z.boolean().optional(),
	lookbackDays: z.number().int().min(1).optional(),
	paymentStatus: z.enum(["open", "paid"]).optional(),
	stage: z.enum(["approved", "in_progress", "ready"]).optional(),
	source: z.enum(["order", "field"]).optional(),
	search: z.string().optional(),
	searchTerms: z.array(z.string()).optional(),
	conditions: z.array(filterConditionSchema).optional(),
	join: z.enum(["and", "or"]).optional(),
	sortKey: z.string().optional(),
	sortDir: z.enum(["asc", "desc"]).optional(),
	sortType: z.enum(["text", "number", "date", "currency"]).optional(),
});

export type ExportColumnInput = z.infer<typeof exportColumnSchema>;
export type ExportReportInput = z.infer<typeof exportReportSchema>;
export type ExportServerInput = z.infer<typeof exportServerSchema>;
