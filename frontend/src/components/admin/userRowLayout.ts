// Shared by the Users list header and every row so the two can never drift.
// Hidden cells drop out of auto-placement, so each breakpoint's track count must
// equal its visible cell count. From md up (where the header shows) no track may
// be `auto` — every row is its own grid, so `auto` would size per row.
// Display class is left to callers (`grid`) so the header can wrap it in a md-only shell.
// Order: who (user, type, role) → account (MFA, contact, last login) → actions.
// From lg up Role is capped (not fr) so wide screens hand the slack to the name track rather
// than opening a gap inside a short role name's column. At md a cap would starve the name.
export const USER_ROW_COLS =
	"items-center gap-x-4 grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_7.5rem_auto] md:grid-cols-[minmax(0,1.4fr)_7.5rem_minmax(0,1fr)_3rem] lg:grid-cols-[minmax(0,1.4fr)_7.5rem_minmax(0,14rem)_3rem_4.5rem_3rem] xl:grid-cols-[minmax(0,1.4fr)_7.5rem_minmax(0,14rem)_3rem_4.5rem_7rem_3rem]";

export const USER_COL_VISIBILITY = {
	type: "hidden sm:flex",
	role: "hidden md:block",
	mfa: "hidden lg:flex",
	contact: "hidden lg:flex",
	lastLogin: "hidden xl:block",
} as const;
