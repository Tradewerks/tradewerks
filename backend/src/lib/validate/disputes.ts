import { z } from "zod";
import { adjustmentLineSchema } from "./invoices.js";

export const openDisputeSchema = z.object({
	reason: z.string().trim().min(1, "A reason is required").max(2000),
	contested_line_item_ids: z.array(z.string().uuid()).optional(),
});

export const resolveDisputeSchema = z
	.object({
		resolution: z.enum(["ReviseAndResend", "IssueAdjustment", "Repeal"]),
		note: z.string().trim().max(2000).optional(),
		adjustment_lines: z.array(adjustmentLineSchema).optional(),
	})
	// Repeal is terminal and irreversible; it does not get to be unexplained.
	.refine((v) => v.resolution !== "Repeal" || Boolean(v.note && v.note.length > 0), {
		message: "A reason is required when repealing a document",
		path: ["note"],
	})
	.refine(
		(v) =>
			v.resolution !== "IssueAdjustment" ||
			(v.adjustment_lines !== undefined && v.adjustment_lines.length > 0),
		{
			message: "An adjustment needs at least one line",
			path: ["adjustment_lines"],
		},
	)
	// Lines arriving with any other outcome mean the caller picked the wrong
	// outcome; silently dropping them would lose the correction.
	.refine((v) => v.resolution === "IssueAdjustment" || v.adjustment_lines === undefined, {
		message: "Adjustment lines only apply to the Issue Adjustment outcome",
		path: ["adjustment_lines"],
	})
	// Each line is already non-zero, but a set that nets to zero writes a
	// client-facing document that corrects nothing and burns an invoice
	// number. The modal blocks it; an API caller has to be stopped here too.
	.refine(
		(v) =>
			v.resolution !== "IssueAdjustment" ||
			Math.round(
				(v.adjustment_lines ?? []).reduce(
					(sum, line) => sum + line.total,
					0,
				) * 100,
			) !== 0,
		{
			message: "The net adjustment cannot be zero",
			path: ["adjustment_lines"],
		},
	);

export const openDisputesQuerySchema = z.object({
	client_id: z.string().uuid().optional(),
});

export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeSchema>;
