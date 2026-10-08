import z from "zod";
import type { JobStatus, VisitStatus, ArrivalConstraint, FinishConstraint, VisitStatusEvent } from "./jobs";
import type { Priority } from "./common";
import type { ClientWithPrimaryContact } from "./clients";
import type { Coordinates } from "./location";
import type { JobVisit } from "./jobs";

// ============================================================================
// STATUS
// ============================================================================

export const TechnicianStatusValues = [
	"Available", "Working", "OnSite", "EnRoute", "Paused", "WrappingUp", "Break", "Offline",
] as const;
export type TechnicianStatus = (typeof TechnicianStatusValues)[number];

export const TechnicianStatusLabels: Record<TechnicianStatus, string> = {
	Available:  "Available",
	Working:    "Working",
	EnRoute:    "En Route",
	OnSite:     "On Site",
	Paused:     "Paused",
	WrappingUp: "Wrapping Up",
	Break:      "Break",
	Offline:    "Offline",
};

export const TechnicianStatusColors: Record<TechnicianStatus, string> = {
	Available:  "bg-success/10 text-success-text border-success/20",
	Working:    "bg-reviewing/10 text-reviewing-text border-reviewing/20",
	EnRoute:    "bg-sky-500/10 text-sky-400 border-sky-500/20",
	OnSite:     "bg-warning/10 text-warning-text border-warning/20",
	Paused:     "bg-orange/10 text-orange-text border-orange/20",
	WrappingUp: "bg-teal-400/10 text-teal-300 border-teal-400/20",
	Break:      "bg-amber-400/10 text-amber-300 border-amber-400/20",
	Offline:    "bg-neutral/10 text-text-tertiary border-border-strong/20",
};

export const TechnicianStatusDotColors: Record<TechnicianStatus, string> = {
	Available:  "bg-success",
	Working:    "bg-reviewing",
	EnRoute:    "bg-sky-500",
	OnSite:     "bg-warning",
	Paused:     "bg-orange",
	WrappingUp: "bg-teal-400",
	Break:      "bg-amber-400",
	Offline:    "bg-neutral",
};

// ============================================================================
// INTERFACES
// ============================================================================

export interface VisitTechInfo {
	id: string;
	name: string;
	email: string;
	phone: string | null;
	title: string;
	status: TechnicianStatus;
}

export interface VisitTech {
	tech_id: string;
	visit_id: string;
	tech: VisitTechInfo;
}

export interface VisitTechnician {
	visit_id: string;
	tech_id: string;
	tech_status?: "Assigned" | "EnRoute" | "OnSite" | "Done";
	visit: {
		id: string;
		job_id: string;

		arrival_constraint: ArrivalConstraint;
		finish_constraint: FinishConstraint;
		scheduled_start_at: Date | string;
		scheduled_end_at: Date | string;
		arrival_time?: string | null;
		arrival_window_start?: string | null;
		arrival_window_end?: string | null;
		finish_time?: string | null;

		actual_start_at?: Date | null;
		actual_end_at?: Date | null;
		status: VisitStatus;
		job: {
			id: string;
			name: string;
			description: string;
			status: JobStatus;
			address: string;
			coords: Coordinates;
			priority: Priority;
			created_at: Date | string;
			client_id: string;
			client: ClientWithPrimaryContact;
		};
	};
}

export interface TechnicianWithVisits extends Technician {
	activeVisits: JobVisit[];
	scheduledVisits: JobVisit[];
	totalVisitsToday: number;
}

export interface Technician {
	id: string;
	name: string;
	email: string;
	phone: string;
	title: string;
	description: string;
	coords: Coordinates;
	status: TechnicianStatus;
	hire_date: Date;
	last_login: Date | null;
	last_ping_at?: string | null;
	current_vehicle_id: string | null;
	current_vehicle?: { id: string; name: string; type: string; license_plate: string | null; color: string | null; notes: string | null } | null;
	visit_techs?: VisitTechnician[];
	logs?: unknown[];
	created_client_notes?: unknown[];
	last_edited_client_notes?: unknown[];
	created_job_notes?: unknown[];
	last_edited_job_notes?: unknown[];
	role_id: string | null;
	organization_role: { id: string; name: string } | null;
	permissions: string[];
	theme: "dark" | "light" | "system";
	mfaEnabled?: boolean;
}

export interface CreateTechnicianInput {
	name: string;
	email: string;
	phone: string;
	password?: string;
	title: string;
	description?: string;
	organization_role_id?: string | null;
	status?: TechnicianStatus;
	hire_date?: Date;
	coords?: {
		lat: number;
		lon: number;
	};
}

export interface UpdateTechnicianInput {
	name?: string;
	email?: string;
	phone?: string;
	password?: string;
	title?: string;
	description?: string;
	status?: TechnicianStatus;
	hire_date?: Date;
	last_login?: Date;
	theme?: "dark" | "light" | "system";
}

// ============================================================================
// SCHEMAS
// ============================================================================

export const CreateTechnicianSchema = z.object({
	name: z.string().min(1, "Technician name is required"),
	email: z.string().email("Invalid email address"),
	phone: z.string().min(1, "Phone number is required"),
	password: z.string().min(8, "Password must be at least 8 characters").optional(),
	title: z.string().min(1, "Title is required"),
	description: z.string().default(""),
	organization_role_id: z.string().uuid("Invalid role ID").nullable().optional(),
	status: z.enum(TechnicianStatusValues).default("Offline"),
	hire_date: z.coerce
		.date()
		.optional()
		.default(() => new Date()),
	coords: z
		.object({
			lat: z.number(),
			lon: z.number(),
		})
		.default({ lat: 0, lon: 0 }),
});

export const UpdateTechnicianSchema = z
	.object({
		name: z.string().min(1, "Technician name is required").optional(),
		email: z.string().email("Invalid email address").optional(),
		phone: z.string().min(1, "Phone number is required").optional(),
		password: z.string().min(8, "Password must be at least 8 characters").optional(),
		title: z.string().min(1, "Title is required").optional(),
		description: z.string().optional(),
		status: z.enum(TechnicianStatusValues).optional(),
		hire_date: z.coerce.date().optional(),
		last_login: z.coerce.date().optional(),
		theme: z.enum(["dark", "light", "system"]).optional(),
	})
	.refine(
		(data) =>
			data.name !== undefined ||
			data.email !== undefined ||
			data.phone !== undefined ||
			data.password !== undefined ||
			data.title !== undefined ||
			data.description !== undefined ||
			data.status !== undefined ||
			data.hire_date !== undefined ||
			data.last_login !== undefined ||
			data.theme !== undefined,
		{ message: "At least one field must be provided for update" }
	);

// ============================================================================
// LIVE FEED EVENT TYPES
// ============================================================================

export type TechStatusChangeType =
	| "shift_start"
	| "shift_end"
	| "break_start"
	| "break_end"
	| "wrapping_up_cleared";

export interface TechStatusEvent {
	kind: "tech";
	techId: string;
	techName: string;
	newStatus: TechnicianStatus;
	changeType: TechStatusChangeType;
	changedAt: string;
}

export type VisitFeedEvent = VisitStatusEvent & { kind: "visit" };
export type FeedEvent = VisitFeedEvent | TechStatusEvent;
