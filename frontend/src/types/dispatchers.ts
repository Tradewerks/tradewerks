import z from "zod";
import type { Layout } from "react-grid-layout";
import type { ReportCategoryId } from "./reports";
import type { DispatcherNotificationType } from "./notifications";

export type ReportLayoutEntry = { order: string[]; hidden: string[] };
export type ReportLayout = Partial<Record<ReportCategoryId, ReportLayoutEntry>>;

// ============================================================================
// INTERFACES
// ============================================================================

export interface Dispatcher {
  id: string;
  organization_id: string | null;
  role: string;
  name: string;
  email: string;
  phone: string | null;
  title: string;
  description: string;
  last_login: string;
  deactivated_at: string | null;
  email_verified_at: Date | null;
  email_verification_token: string | null;
  role_id: string | null;
  organization_role: { id: string; name: string } | null;
  permissions: string[];
  theme: "dark" | "light" | "system";
  muted_notification_types: DispatcherNotificationType[];
  dashboard_layout: Layout | null;
  report_layout: ReportLayout | null;
  kpi_layout: Layout | null;
  mfaEnabled?: boolean;
  _count?: {
    created_quotes: number;
    created_invoices: number;
    created_requests: number;
    created_recurring_plans: number;
    managed_projects: number;
  };
}

export interface CreateDispatcherInput {
  organization_id?: string;
  name: string;
  email: string;
  phone?: string;
  password?: string;
  title: string;
  description: string;
  role?: string;
  organization_role_id?: string | null;
}
 
export interface UpdateDispatcherInput {
  organization_id?: string | null;
  name?: string;
  email?: string;
  phone?: string | null;
  title?: string;
  description?: string;
  role?: string;
  theme?: "dark" | "light" | "system";
  muted_notification_types?: DispatcherNotificationType[];
  dashboard_layout?: Layout | null;
  report_layout?: ReportLayout | null;
  kpi_layout?: Layout | null;
}
 
export interface ChangeDispatcherPasswordInput {
  current_password: string;
  new_password: string;
  confirm_password: string;
}

// ============================================================================
// SCHEMAS
// ============================================================================

export const CreateDispatcherSchema = z.object({
	organization_id: z.string().uuid("Invalid organization ID").optional(),
	name: z.string().min(1, "Dispatcher name is required"),
	email: z.string().email("Invalid email address"),
	phone: z.string().min(1, "Phone number is required").optional(),
	password: z.string().min(8, "Password must be at least 8 characters").optional(),
	title: z.string().min(1, "Title is required"),
	description: z.string().default(""),
	organization_role_id: z.string().uuid("Invalid role ID").nullable().optional(),
});
 
export const UpdateDispatcherSchema = z
	.object({
		organization_id: z.string().uuid("Invalid organization ID").nullable().optional(),
		name: z.string().min(1, "Dispatcher name is required").optional(),
		email: z.string().email("Invalid email address").optional(),
		phone: z.string().min(1, "Phone number is required").nullable().optional(),
		password: z.string().min(8, "Password must be at least 8 characters").optional(),
		title: z.string().min(1, "Title is required").optional(),
		description: z.string().optional(),
		last_login: z.coerce.date().optional(),
		theme: z.enum(["dark", "light", "system"]).optional(),
		muted_notification_types: z.array(z.string()).optional(),
		dashboard_layout: z.array(z.any()).nullable().optional(),
		report_layout: z
			.record(
				z.string(),
				z.object({ order: z.array(z.string()), hidden: z.array(z.string()) }),
			)
			.nullable()
			.optional(),
		kpi_layout: z.array(z.any()).nullable().optional(),
	})
	.refine(
		(data) =>
			data.organization_id !== undefined ||
			data.name !== undefined ||
			data.email !== undefined ||
			data.phone !== undefined ||
			data.password !== undefined ||
			data.title !== undefined ||
			data.description !== undefined ||
			data.last_login !== undefined ||
			data.theme !== undefined ||
			data.muted_notification_types !== undefined ||
			data.dashboard_layout !== undefined ||
			data.report_layout !== undefined ||
			data.kpi_layout !== undefined,
		{ message: "At least one field must be provided for update" }
	);
