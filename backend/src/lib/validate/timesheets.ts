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
