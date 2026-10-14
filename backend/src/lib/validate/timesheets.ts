import z from "zod";

// Any day in the week; the server snaps it to that calendar week's Monday.
const weekDate = z.iso.date();

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
		z.object({ id: z.string().uuid(), started_at: z.coerce.date(), ended_at: z.coerce.date() })
		.refine((b) => b.ended_at > b.started_at, "Break end must be after start"),
	).optional(),
	entries: z.array(
		z.object({ id: z.string().uuid(), clocked_in_at: z.coerce.date(), clocked_out_at: z.coerce.date() })
		.refine((e) => e.clocked_out_at > e.clocked_in_at, "Visit clock-out must be after clock-in"),
	).optional(),
})

export const reportShiftIssueSchema = z.object({
	message: z.string().trim().min(1, "Describe the problem").max(500),
	proposed: editShiftSchema.optional()
});

export const reviewCorrectionSchema = z.object({ 
	note: z.string().trim().max(500).optional(), 
	proposed: editShiftSchema.optional() 
});
