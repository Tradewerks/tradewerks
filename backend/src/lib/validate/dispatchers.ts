import z from "zod";

const DispatcherRole = z.enum(["dispatcher", "admin"]);

export const DispatcherNotificationTypeEnum = z.enum([
	"vehicle_maintenance_due",
	"job_finished",
	"followup_email_opened",
	"field_purchase_preauth_requested",
	"field_purchase_submitted",
	"field_purchase_second_signoff",
	"field_purchase_grant_requested",
	"visit_delayed",
	"tech_running_late",
	"restock_shortfall",
	"vehicle_restock_requested",
	"dispute_opened",
	"tech_note_added",
	"invoice_paid",
	"quote_accepted",
	"quote_declined",
	"usage_limit_warning",
	"subscription_changed",
	"upgrade_request_resolved",
	"trial_ending",
]);

const reportLayoutSchema = z.record(
	z.string(),
	z.object({ order: z.array(z.string()), hidden: z.array(z.string()) }),
);

// Mirrors react-grid-layout's Layout[] — passthrough so extra RGL-managed
// keys (e.g. moved, isDraggable) don't get rejected as the library evolves.
// Shared by dashboard_layout and kpi_layout — both are RGL grids.
const gridLayoutSchema = z.array(
	z.object({
		i: z.string(),
		x: z.number(),
		y: z.number(),
		w: z.number(),
		h: z.number(),
		minW: z.number().optional(),
		minH: z.number().optional(),
		maxW: z.number().optional(),
		maxH: z.number().optional(),
		static: z.boolean().optional(),
	}).passthrough(),
);

export const createDispatcherSchema = z.object({
	organization_id: z.string().uuid("Valid organization ID is required").optional(),
	name: z.string().min(1, "Dispatcher name is required"),
	email: z.string().email("Valid email is required"),
	phone: z.string().min(1, "Phone number is required").optional(),
	password: z.string().min(8, "Password must be at least 8 characters").optional(),
	title: z.string().min(1, "Title is required"),
	description: z.string().default(""),
	organization_role_id: z.string().uuid("Valid role ID is required").nullable().optional(),
});

export const updateDispatcherSchema = z
	.object({
		organization_id: z.string().uuid("Valid organization ID is required").optional(),
		name: z.string().min(1, "Dispatcher name is required").optional(),
		email: z.string().email("Valid email is required").optional(),
		phone: z.string().min(1, "Phone number is required").nullable().optional(),
		title: z.string().min(1, "Title is required").optional(),
		description: z.string().optional(),
		role: DispatcherRole.optional(),
		theme: z.enum(["dark", "light", "system"]).optional(),
		muted_notification_types: z.array(DispatcherNotificationTypeEnum).optional(),
		last_login: z
			.preprocess(
				(val) =>
					typeof val === "string" || val instanceof Date
						? new Date(val)
						: val,
				z.date()
			)
			.optional(),
		dashboard_layout: gridLayoutSchema.nullable().optional(),
		report_layout: reportLayoutSchema.nullable().optional(),
		kpi_layout: gridLayoutSchema.nullable().optional(),
	})
	.refine(
		(data) =>
			data.organization_id !== undefined ||
			data.name !== undefined ||
			data.email !== undefined ||
			data.phone !== undefined ||
			data.title !== undefined ||
			data.description !== undefined ||
			data.role !== undefined ||
			data.theme !== undefined ||
			data.muted_notification_types !== undefined ||
			data.last_login !== undefined ||
			data.dashboard_layout !== undefined ||
			data.report_layout !== undefined ||
			data.kpi_layout !== undefined,
		{ message: "At least one field must be provided for update" }
	);

export const changePasswordSchema = z.object({
	current_password: z.string().min(1, "Current password is required"),
	new_password: z.string().min(8, "New password must be at least 8 characters"),
});

export type CreateDispatcherInput = z.infer<typeof createDispatcherSchema>;
export type UpdateDispatcherInput = z.infer<typeof updateDispatcherSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;