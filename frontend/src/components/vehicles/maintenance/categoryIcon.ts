import { Droplet, FlaskConical, Disc, Octagon, CircleCheck, FileText, Wrench, MoreHorizontal, type LucideIcon } from "lucide-react";
import type { MaintenanceCategory } from "../../../types/vehicles";

export const CATEGORY_ICON: Record<MaintenanceCategory, { icon: LucideIcon; className: string }> = {
    oil_change:   { icon: Droplet,       className: "bg-warning/15 text-warning-text" },
    fluids:       { icon: FlaskConical,  className: "bg-orange-bg text-orange-text" },
    tire:         { icon: Disc,          className: "bg-primary-bg text-primary" },
    brake:        { icon: Octagon,       className: "bg-error/15 text-error-text" },
    inspection:   { icon: CircleCheck,   className: "bg-success/15 text-success-text" },
    registration: { icon: FileText,      className: "bg-reviewing-bg text-reviewing-text" },
    repair:       { icon: Wrench,        className: "bg-info-bg text-info-text" },
    other:        { icon: MoreHorizontal, className: "bg-surface-raised text-text-muted" },
};
