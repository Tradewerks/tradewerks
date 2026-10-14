import { z } from "zod";
import type { Coordinates } from "./location";
import { type Priority, PriorityValues, type BaseNote } from "./common";

export const ProjectStatusValues = ["Planning","Active","OnHold","Completed","Cancelled"] as const;
export type ProjectStatus = (typeof ProjectStatusValues)[number];

export const ProjectStatusLabels: Record<ProjectStatus, string> = {
    Planning: "Planning",
    Active: "Active",
    OnHold: "On Hold",
    Completed: "Completed",
    Cancelled: "Cancelled",
};

export interface ProjectAttachedJob {
    id: string;
    job_number: string;
    name: string;
    status: string;         
    priority: Priority;
    estimated_total?: number | null;
    actual_total?: number | null;
    client: { id: string; name: string };
}

export interface Project {
    id: string;
    project_number: string;
    name: string;
    description: string;
    client_id: string;
    client?: { id: string; name: string };
    status: ProjectStatus;
    priority: Priority;
    address: string | null;
    coords: Coordinates | null;
    budget: number | null;
    starts_at: Date | string | null;
    target_end_at: Date | string | null;
    created_at: Date | string;
    updated_at?: Date | string;
    completed_at?: Date | string | null;
    cancelled_at?: Date | string | null;
    cancellation_reason?: string | null;
    jobs: ProjectAttachedJob[];
    manager_dispatcher_id?: string | null;
    manager_dispatcher?: { id: string; name: string } | null;
}

export const ProjectStatusColors: Record<ProjectStatus, string> = {
    Planning:  "bg-primary/20 text-primary-text border-primary/30",
    Active:    "bg-info/20 text-info-text border-info/30",
    OnHold:    "bg-warning/20 text-warning-text border-warning/30",
    Completed: "bg-success/20 text-success-text border-success/30",
    Cancelled: "bg-error/20 text-error-text border-error/30",
};

export interface CreateProjectInput {
    name: string;
    client_id: string;
    description?: string;
    status?: ProjectStatus;
    priority?: Priority;
    address?: string;
    coords?: Coordinates;
    budget?: number;
    starts_at?: string;
    target_end_at?: string;
    manager_dispatcher_id?: string | null;
}

export interface UpdateProjectInput {
    name?: string;
    client_id?: string;
    description?: string;
    status?: ProjectStatus;
    priority?: Priority;
    address?: string;
    coords?: Coordinates;
    budget?: number | null;
    starts_at?: string | null;
    target_end_at?: string | null;
    cancellation_reason?: string;
    manager_dispatcher_id?: string | null;
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const CoordsSchema = z.object({ lat: z.number(), lon: z.number() });

const BUDGET_MAX = 9_999_999_999.99;

const endNotBeforeStart = (d: { starts_at?: string | null; target_end_at?: string | null }) =>
    !d.starts_at ||
    !d.target_end_at ||
    new Date(d.target_end_at).getTime() >= new Date(d.starts_at).getTime();

const END_BEFORE_START = {
    message: "Target end date cannot be before the start date",
    path: ["target_end_at"],
};

export const CreateProjectSchema = z
    .object({
        name: z.string().min(1, "Project name is required"),
        client_id: z.string().uuid("Please select a client"),
        description: z.string(),
        status: z.enum(ProjectStatusValues).default("Planning"),
        priority: z.enum(PriorityValues).default("Medium"),
        address: z.string().optional(),
        coords: CoordsSchema.optional(),
        budget: z
            .number({ error: "Budget must be a valid number" })
            .nonnegative("Budget cannot be negative")
            .max(BUDGET_MAX, "Budget is too large")
            .optional(),
        starts_at: z.string().datetime().optional(),
        target_end_at: z.string().datetime().optional(),
        manager_dispatcher_id: z.string().uuid().optional().nullable(),
    })
    .refine(endNotBeforeStart, END_BEFORE_START);

export const UpdateProjectSchema = z
    .object({
        name: z.string().min(1, "Project name is required").optional(),
        client_id: z.string().uuid("Please select a client").optional(),
        description: z.string().optional(),
        status: z.enum(ProjectStatusValues).optional(),
        priority: z.enum(PriorityValues).optional(),
        address: z.string().optional(),
        coords: CoordsSchema.optional(),
        budget: z
            .number({ error: "Budget must be a valid number" })
            .nonnegative("Budget cannot be negative")
            .max(BUDGET_MAX, "Budget is too large")
            .optional()
            .nullable(),
        starts_at: z.string().datetime().optional().nullable(),
        target_end_at: z.string().datetime().optional().nullable(),
        cancellation_reason: z.string().optional(),
        manager_dispatcher_id: z.string().uuid().optional().nullable(),
    })
    .refine(endNotBeforeStart, END_BEFORE_START);

export interface ProjectRef {
	id: string;
	project_number: string;
	name: string;
	status: ProjectStatus;
}

// ============================================================================
// NOTE TYPES
// ============================================================================

export interface ProjectNotePhoto {
    id: string;
    note_id: string;
    photo_url: string;
    photo_label: "Before" | "After" | "Other";
    created_at: string;
}

export interface ProjectNote extends BaseNote {
    project_id: string;
    notify_technician: boolean;
    photos?: ProjectNotePhoto[];
}

export interface CreateProjectNoteInput {
    content: string;
    notify_technician?: boolean;
    photos?: { photo_url: string; photo_label: string }[];
}

export interface UpdateProjectNoteInput {
    content?: string;
    photos?: { id?: string; photo_url: string; photo_label: string }[];
}