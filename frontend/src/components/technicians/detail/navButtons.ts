import { HEADER_BTN_SECONDARY } from "../../ui/headerActions";

// Navigation on the technician page is a bordered button, never bare link text —
// the same secondary idiom as ClientDetailsCard / InventoryPage, so a dispatcher
// reads "this goes somewhere" the same way everywhere in the app.
export const NAV_BUTTON =
	"inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors duration-150 ease-out hover:border-border-strong hover:bg-surface-raised hover:text-text-primary";

// Card-header and in-tile size — the shared header button, so a technician card's
// header sits at the same height as every other card's.
export const NAV_BUTTON_SM = HEADER_BTN_SECONDARY;
