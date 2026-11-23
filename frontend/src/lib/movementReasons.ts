import {
	ArrowRightLeft,
	Boxes,
	ClipboardCheck,
	PackageCheck,
	PackageX,
	RotateCcw,
	ShoppingCart,
	Truck,
	Warehouse,
	Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { StockMovementReason } from "../types/inventory";
import i18n from "../i18n";

// Single source of presentation for stock_movement.reason. Every surface that
// renders a ledger row — the dispatch serial timeline, the technician serial
// sheet — reads from here.
//
// Typed `Record<StockMovementReason, …>` on purpose: StockMovementReason mirrors
// the Prisma enum, so adding a value to the enum without adding it here is a
// compile error. The previous per-file maps were plain Record<string, …> and had
// drifted in opposite directions — one silently missing `return_to_warehouse`,
// the other carrying four keys (`field_loss`, `audit`, `warehouse_exchange`,
// `consumed`) that were never enum values and so never matched anything.

export const MOVEMENT_REASON_LABEL: Record<StockMovementReason, string> = {
	receive: "Received",
	restock: "Restocked to vehicle",
	return_to_warehouse: "Returned to warehouse",
	parts_used: "Installed",
	direct_consumption: "Installed",
	loss: "Lost",
	audit_correction: "Audit correction",
	transfer: "Transferred",
	reversal: "Reversed",
	initial: "Initial stock",
	supplier_purchase: "Supplier purchase",
};

export const MOVEMENT_REASON_ICON: Record<StockMovementReason, LucideIcon> = {
	receive: PackageCheck,
	restock: Truck,
	return_to_warehouse: Warehouse,
	parts_used: Wrench,
	direct_consumption: Wrench,
	loss: PackageX,
	audit_correction: ClipboardCheck,
	transfer: ArrowRightLeft,
	reversal: RotateCcw,
	initial: Boxes,
	supplier_purchase: ShoppingCart,
};

// Timeline dot tone. Intake/consumption read as success (stock did what it was
// bought to do), corrections and reversals as warning, loss as error, pure
// relocation as primary, and `initial` stays neutral — it is bookkeeping, not
// an event anyone performed.
export const MOVEMENT_REASON_DOT: Record<StockMovementReason, string> = {
	receive: "bg-success text-on-primary",
	restock: "bg-primary text-on-primary",
	return_to_warehouse: "bg-primary text-on-primary",
	parts_used: "bg-success text-on-primary",
	direct_consumption: "bg-success text-on-primary",
	loss: "bg-error text-on-primary",
	audit_correction: "bg-warning text-on-primary",
	transfer: "bg-primary text-on-primary",
	reversal: "bg-warning text-on-primary",
	initial: "bg-surface-raised text-text-tertiary",
	supplier_purchase: "bg-reviewing text-on-primary",
};

const NEUTRAL_DOT = "bg-surface-raised text-text-tertiary";

// The accessors take `string`, not StockMovementReason: history payloads are
// typed off the API, and a backend deployed ahead of the frontend can send a
// reason this build has never heard of. Unknown values degrade to a humanized
// spelling rather than rendering a raw snake_case token.
export function movementReasonLabel(reason: string): string {
	return i18n.t(`movement.${reason}`, {
		defaultValue: MOVEMENT_REASON_LABEL[reason as StockMovementReason] ?? reason.replace(/_/g, " "),
	});
}

export function movementReasonIcon(reason: string): LucideIcon {
	return MOVEMENT_REASON_ICON[reason as StockMovementReason] ?? Boxes;
}

export function movementReasonDot(reason: string): string {
	return MOVEMENT_REASON_DOT[reason as StockMovementReason] ?? NEUTRAL_DOT;
}
