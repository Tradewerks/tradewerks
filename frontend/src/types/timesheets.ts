// Mirrors the timesheet_week row returned by backend/src/routes/timesheets.ts.
export interface TimesheetWeek {
	id: string;
	organization_id: string;
	technician_id: string;
	/** Monday of the week, ISO string at UTC midnight. */
	week_start: string;
	approved_at: string | null;
	approved_by_dispatcher_id: string | null;
	qb_sync_status: "not_synced" | "synced" | "failed";
	qb_synced_at: string | null;
	qb_error: string | null;
}

export interface ApproveTimesheetInput {
	technician_id: string;
	/** Any day in the week, "YYYY-MM-DD". */
	date: string;
}

// Dates are ISO strings over JSON.
type Span = { start: string; end: string; label: string; sub: string };
export type SegType = "job" | "drive" | "break" | "unassigned";
export type Segment = Span & { type: SegType; paid?: boolean };

export interface TechWeekDetails {
	weekStart: string;
	technicianName: string;
    days: {
        shiftId: string;
        start: string;
        end: string | null;
        payableHours: number;
        segments: Segment[];
    }[];
}
