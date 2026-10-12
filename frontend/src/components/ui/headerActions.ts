// Card-header controls. All are h-7 so every header row stays at Card's 57px
// whether it holds a button, a summary, or nothing — paired cards' dividers only
// line up if no header action can push its row taller.

/** Shape only, for a header button whose colour is its own (e.g. the payment green). */
export const HEADER_BTN_BASE =
	"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 ease-out";

const ENABLED = "cursor-pointer disabled:cursor-not-allowed disabled:opacity-40";

export const HEADER_BTN_PRIMARY = `${HEADER_BTN_BASE} ${ENABLED} bg-primary-hover text-on-primary hover:enabled:bg-primary-active`;

export const HEADER_BTN_SECONDARY = `${HEADER_BTN_BASE} ${ENABLED} border border-border text-text-secondary hover:border-border-strong hover:bg-surface-raised hover:text-text-primary`;

// The `aria-disabled` form of the secondary button, for controls that stay focusable
// so their no-permission reason is reachable.
export const HEADER_BTN_SECONDARY_INERT = `${HEADER_BTN_BASE} cursor-not-allowed border border-border-subtle text-text-muted`;

export const HEADER_BTN_ICON =
	"inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-text-primary disabled:hover:bg-transparent disabled:cursor-not-allowed disabled:opacity-40";

export const HEADER_META = "text-xs tabular-nums text-text-tertiary";
