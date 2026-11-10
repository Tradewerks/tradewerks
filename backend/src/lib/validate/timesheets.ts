import z from "zod";

// Any day in the week; the server snaps it to that calendar week's Monday.
const weekDate = z.iso.date();

export const PAID_BREAK_REASONS = new Set<string>(["Rest", "EquipmentIssue"]);

export const timesheetWeekQuerySchema = z.object({
	date: weekDate.optional(),
});

export const approveTimesheetSchema = z.object({
	technician_id: z.string().uuid(),
	date: weekDate,
});

export const editShiftSchema = z.object({
	started_at: z.coerce.date().optional(),
	ended_at: z.coerce.date().optional(),
	breaks: z.array(
		// No id = a break added after the fact; it needs a reason instead.
		z.object({
			id: z.string().uuid().optional(),
			reason: z.enum(["Lunch", "Rest", "EquipmentIssue", "Other"]).optional(),
			started_at: z.coerce.date(),
			ended_at: z.coerce.date(),
		})
		.refine((b) => b.id || b.reason, "New break needs a reason")
		.refine((b) => b.ended_at > b.started_at, "Break end must be after start"),
	).optional(),
	entries: z.array(
		z.object({ id: z.string().uuid(), clocked_in_at: z.coerce.date(), clocked_out_at: z.coerce.date() })
		.refine((e) => e.clocked_out_at > e.clocked_in_at, "Visit clock-out must be after clock-in"),
	).optional(),
	delete_break_ids: z.array(z.string().uuid()).optional(),
})

export const reportShiftIssueSchema = z.object({
	message: z.string().trim().min(1, "Describe the problem").max(500),
	proposed: editShiftSchema.optional()
});

export const reviewCorrectionSchema = z.object({ 
	note: z.string().trim().max(500).optional(), 
	proposed: editShiftSchema.optional() 
});
