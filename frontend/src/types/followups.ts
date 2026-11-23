import z from "zod";

// ============================================================================
// ENUMS
// ============================================================================

export type EmailTemplateCategory =
	| "followup"
	| "reminder"
	| "quote_chase"
	| "invoice_chase"
	| "request_ack"
	| "custom";

export const EmailTemplateCategoryValues: EmailTemplateCategory[] = [
	"followup",
	"reminder",
	"quote_chase",
	"invoice_chase",
	"request_ack",
	"custom",
];

export const EmailTemplateCategoryLabels: Record<EmailTemplateCategory, string> = {
	followup: "Follow-up",
	reminder: "Reminder",
	quote_chase: "Quote Chase",
	invoice_chase: "Invoice Chase",
	request_ack: "Request Acknowledgement",
	custom: "Custom",
};

export type FollowupTriggerType =
	| "manual"
	| "date_based"
	| "quote_sent"
	| "invoice_sent"
	| "request_created"
	| "visit_scheduled";

export const FollowupTriggerTypeValues: FollowupTriggerType[] = [
	"manual",
	"date_based",
	"quote_sent",
	"invoice_sent",
	"request_created",
	"visit_scheduled",
];

export const FollowupTriggerTypeLabels: Record<FollowupTriggerType, string> = {
	manual: "Manual",
	date_based: "Date-based",
	quote_sent: "Quote Sent",
	invoice_sent: "Invoice Sent",
	request_created: "Request Created",
	visit_scheduled: "Visit Scheduled (Reminder)",
};

export type FollowupStepCondition = "always" | "if_previous_not_opened";

export const FollowupStepConditionValues: FollowupStepCondition[] = [
	"always",
	"if_previous_not_opened",
];

export const FollowupStepConditionLabels: Record<FollowupStepCondition, string> = {
	always: "Always",
	if_previous_not_opened: "If previous not opened",
};

export type FollowupEnrollmentStatus = "active" | "completed" | "stopped" | "failed";

export const FollowupEnrollmentStatusValues: FollowupEnrollmentStatus[] = [
	"active",
	"completed",
	"stopped",
	"failed",
];

export const FollowupEnrollmentStatusLabels: Record<FollowupEnrollmentStatus, string> = {
	active: "Active",
	completed: "Completed",
	stopped: "Stopped",
	failed: "Failed",
};

export type DelayUnit = "hours" | "days";

export const DelayUnitValues: DelayUnit[] = ["hours", "days"];

export const DelayUnitLabels: Record<DelayUnit, string> = {
	hours: "Hours",
	days: "Days",
};

// ============================================================================
// TYPES
// ============================================================================

export interface FollowupStep {
	id: string;
	sequence_id: string;
	step_order: number;
	// The category IS the Postmark template alias sent for this step.
	category: EmailTemplateCategory;
	delay_amount: number;
	delay_unit: DelayUnit;
	condition: FollowupStepCondition;
	created_at: Date | string;
}

export interface FollowupSequence {
	id: string;
	name: string;
	description: string | null;
	trigger_type: FollowupTriggerType;
	trigger_config: unknown;
	stop_on_open: boolean;
	is_active: boolean;
	steps: FollowupStep[];
	_count?: { enrollments: number };
	created_at: Date | string;
	updated_at: Date | string;
}

export interface FollowupSend {
	id: string;
	step_id: string | null;
	template_alias: string | null;
	recipient_email: string;
	postmark_message_id: string | null;
	status: "sent" | "skipped" | "failed" | "sending";
	sent_at: Date | string;
	opened_at: string | null;
	open_count: number;
	error: string | null;
}

export interface FollowupEnrollment {
	id: string;
	sequence_id: string;
	client_id: string;
	recipient_email: string;
	status: FollowupEnrollmentStatus;
	current_step_order: number;
	next_send_at: string | null;
	anchor_entity_type: string | null;
	anchor_at: string | null;
	started_at: Date | string;
	completed_at: string | null;
	stopped_at: string | null;
	stop_reason: string | null;
	sequence?: { name: string; trigger_type: FollowupTriggerType };
	client?: { name: string };
	sends?: FollowupSend[];
}

// ============================================================================
// INPUT TYPES (requests)
// ============================================================================

export interface FollowupStepInput {
	// The category IS the Postmark template alias sent for this step.
	category: EmailTemplateCategory;
	step_order: number;
	delay_amount: number;
	delay_unit: DelayUnit;
	condition: FollowupStepCondition;
}

export interface CreateSequenceInput {
	name: string;
	description?: string | null;
	trigger_type: FollowupTriggerType;
	trigger_config?: unknown;
	stop_on_open: boolean;
	is_active: boolean;
	steps: FollowupStepInput[];
}

export type UpdateSequenceInput = Partial<CreateSequenceInput>;

export interface EnrollInput {
	sequence_id: string;
	client_id: string;
	contact_id?: string | null;
	recipient_email?: string | null;
	scheduled_at?: string | null;
}

// ============================================================================
// ZOD SCHEMAS (client-side validation, mirrors backend/src/lib/validate/followups.ts)
// ============================================================================

const FollowupStepSchema = z.object({
	category: z.enum(EmailTemplateCategoryValues as [EmailTemplateCategory, ...EmailTemplateCategory[]]),
	step_order: z.number().int().min(1),
	delay_amount: z.number().int().min(0, "Delay must be 0 or more"),
	delay_unit: z.enum(DelayUnitValues as [DelayUnit, ...DelayUnit[]]),
	condition: z.enum(FollowupStepConditionValues as [FollowupStepCondition, ...FollowupStepCondition[]]),
});

export const CreateSequenceSchema = z.object({
	name: z.string().min(1, "Name is required"),
	description: z.string().nullable().optional(),
	trigger_type: z.enum(FollowupTriggerTypeValues as [FollowupTriggerType, ...FollowupTriggerType[]]),
	stop_on_open: z.boolean(),
	is_active: z.boolean(),
	steps: z.array(FollowupStepSchema).min(1, "At least one step is required"),
});

export const EnrollSchema = z.object({
	sequence_id: z.string().min(1, "Select a sequence"),
	client_id: z.string().min(1, "Select a client"),
	contact_id: z.string().nullable().optional(),
	recipient_email: z.string().email("Invalid email address").nullable().optional().or(z.literal("")),
	scheduled_at: z.string().nullable().optional(),
});

export type CreateSequenceFormInput = z.infer<typeof CreateSequenceSchema>;
export type EnrollFormInput = z.infer<typeof EnrollSchema>;
