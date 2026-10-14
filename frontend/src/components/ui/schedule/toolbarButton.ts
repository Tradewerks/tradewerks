export const TOOLBAR_FOCUS =
	"focus-visible:outline-none! focus-visible:ring-2 focus-visible:ring-primary/50";

export const TOOLBAR_BTN_BASE = `h-7 rounded text-[11px] font-medium border transition-colors duration-150 ${TOOLBAR_FOCUS}`;

export const TOOLBAR_BTN_ACTIVE = "bg-primary/10 border-primary/25 text-primary-text";

// A visible border at rest so every control reads as a button rather than bare text.
export const TOOLBAR_BTN_IDLE =
	"border-border text-text-secondary hover:border-border-strong hover:text-text-primary hover:bg-surface active:bg-surface-raised";
