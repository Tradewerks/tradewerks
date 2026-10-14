// Shared by the roster's column header and every row so the two can never drift.
// Hidden cells drop out of auto-placement, so each breakpoint's track count
// must equal its visible cell count. Every row is its own grid, so from md up
// (where the header shows) no track may be `auto` — it would size per row.
// Order: who (technician, status, vehicle) → the day's work (now, visits today) → reach (contact, login).
export const TECH_ROW_COLS =
	"grid items-center gap-x-4 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto] md:grid-cols-[minmax(0,1.2fr)_8.5rem_minmax(0,1.5fr)_10rem] lg:grid-cols-[minmax(0,1.2fr)_8.5rem_minmax(0,1.6fr)_6.5rem_4.5rem_10rem] xl:grid-cols-[minmax(0,1.2fr)_8.5rem_9rem_minmax(0,1.6fr)_6.5rem_4.5rem_10rem] 2xl:grid-cols-[minmax(0,1.2fr)_8.5rem_9rem_minmax(0,1.6fr)_6.5rem_4.5rem_6rem_10rem]";

export const TECH_COL_VISIBILITY = {
	status: "hidden sm:flex",
	vehicle: "hidden xl:block",
	now: "hidden md:block",
	today: "hidden lg:block",
	contact: "hidden lg:flex",
	lastLogin: "hidden 2xl:block",
} as const;
