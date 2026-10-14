import { Droplet, FlaskConical, Disc, Octagon, CircleCheck, FileText, Wrench, MoreHorizontal, type LucideIcon } from "lucide-react";
import type { MaintenanceCategory } from "../../../types/vehicles";

export interface CategoryTile {
    value: MaintenanceCategory;
    icon: LucideIcon;
    tint: "warning" | "orange" | "primary" | "error" | "success" | "reviewing" | "info" | "neutral";
}

export const CATEGORY_TILES: CategoryTile[] = [
    { value: "oil_change", icon: Droplet, tint: "warning" },
    { value: "fluids", icon: FlaskConical, tint: "orange" },
    { value: "tire", icon: Disc, tint: "primary" },
    { value: "brake", icon: Octagon, tint: "error" },
    { value: "inspection", icon: CircleCheck, tint: "success" },
    { value: "registration", icon: FileText, tint: "reviewing" },
    { value: "repair", icon: Wrench, tint: "info" },
    { value: "other", icon: MoreHorizontal, tint: "neutral" },
];

export const TINT_CLASSES: Record<CategoryTile["tint"], { icon: string; selected: string }> = {
    warning: { icon: "bg-warning/15 text-warning-text", selected: "border-warning bg-warning/10 text-warning-text" },
    orange: { icon: "bg-orange-bg text-orange-text", selected: "border-orange bg-orange-bg text-orange-text" },
    primary: { icon: "bg-primary-bg text-primary", selected: "border-primary bg-primary/10 text-primary" },
    error: { icon: "bg-error/15 text-error-text", selected: "border-error bg-error/10 text-error-text" },
    success: { icon: "bg-success/15 text-success-text", selected: "border-success bg-success/10 text-success-text" },
    reviewing: { icon: "bg-reviewing-bg text-reviewing-text", selected: "border-reviewing bg-reviewing-bg text-reviewing-text" },
    info: { icon: "bg-info-bg text-info-text", selected: "border-info bg-info-bg text-info-text" },
    neutral: { icon: "bg-surface-raised text-text-muted", selected: "border-border-strong bg-surface-raised text-text-secondary" },
};
