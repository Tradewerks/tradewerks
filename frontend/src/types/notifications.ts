export type NotificationType =
	| "visit_assigned"
	| "visit_changed"
	| "visit_cancelled"
	| "note_added"
	| "visit_reminder"
	| "field_purchase_preauth"
	| "field_purchase_reviewed"
	| "vehicle_maintenance_due"
	| "tech_running_late"
	| "time_correction_accepted"
	| "time_correction_rejected";

export interface TechnicianNotification {
	id: string;
	technician_id: string;
	type: NotificationType;
	title: string;
	body: string;
	action_url: string | null;
	read_at: string | null;
	created_at: string;
}

export type DispatcherNotificationType =
	| "vehicle_maintenance_due"
	| "job_finished"
	| "followup_email_opened"
	| "field_purchase_preauth_requested"
	| "field_purchase_submitted"
	| "field_purchase_second_signoff"
	| "field_purchase_grant_requested"
	| "visit_delayed"
	| "tech_running_late"
	| "restock_shortfall"
	| "vehicle_restock_requested"
	| "dispute_opened"
	| "tech_note_added"
	| "invoice_paid"
	| "quote_accepted"
	| "quote_declined"
	| "timesheet_issue_reported"

export interface DispatcherNotification {
	id: string;
	dispatcher_id: string;
	type: DispatcherNotificationType;
	title: string;
	body: string;
	action_url: string | null;
	read_at: string | null;
	created_at: string;
}

// Display order of the preference groups
export const DISPATCHER_NOTIFICATION_GROUPS = ["Jobs", "Timesheets", "Purchases", "Vehicles & inventory", "Sales & billing"] as const;

export const DISPATCHER_NOTIFICATION_OPTIONS: {
	type: DispatcherNotificationType;
	group: (typeof DISPATCHER_NOTIFICATION_GROUPS)[number];
	label: string;
	description: string;
	// Must match DISPATCHER_NOTIFICATION_PERMISSIONS in the backend notificationsController
	permission: string;
}[] = [
	{ type: "job_finished", group: "Jobs", permission: "view_jobs", label: "Jobs finished", description: "A job's last visit was completed" },
	{ type: "visit_delayed", group: "Jobs", permission: "view_jobs", label: "Delayed visits", description: "A visit was marked delayed" },
	{ type: "tech_running_late", group: "Jobs", permission: "view_jobs", label: "Running late", description: "A technician is likely to miss a visit's arrival time" },
	{ type: "tech_note_added", group: "Jobs", permission: "view_jobs", label: "Technician notes", description: "A technician added a note to a job" },
	{ type: "timesheet_issue_reported", group: "Timesheets", permission: "view_timesheet", label: "Time issue reports", description: "A technician reported a problem with their hours" },
	{ type: "field_purchase_preauth_requested", group: "Purchases", permission: "review_field_purchases", label: "Pre-approval requests", description: "A technician needs approval before a purchase" },
	{ type: "field_purchase_submitted", group: "Purchases", permission: "review_field_purchases", label: "Purchases submitted", description: "A technician submitted a purchase for review" },
	{ type: "field_purchase_second_signoff", group: "Purchases", permission: "second_sign_off_field_purchases", label: "Second sign-offs", description: "A purchase is waiting on a second signature" },
	{ type: "field_purchase_grant_requested", group: "Purchases", permission: "manage_field_purchase_grants", label: "Spending limit requests", description: "A technician asked for a purchase grant" },
	{ type: "vehicle_maintenance_due", group: "Vehicles & inventory", permission: "view_vehicles", label: "Maintenance reminders", description: "A vehicle is overdue or due soon" },
	{ type: "vehicle_restock_requested", group: "Vehicles & inventory", permission: "view_inventory", label: "Restock requests", description: "A technician requested vehicle stock" },
	{ type: "restock_shortfall", group: "Vehicles & inventory", permission: "view_inventory", label: "Restock shortfalls", description: "A restock couldn't be fully filled" },
	{ type: "quote_accepted", group: "Sales & billing", permission: "view_quotes", label: "Quotes accepted", description: "A client accepted a quote" },
	{ type: "quote_declined", group: "Sales & billing", permission: "view_quotes", label: "Quotes declined", description: "A client declined a quote" },
	{ type: "followup_email_opened", group: "Sales & billing", permission: "view_followups", label: "Follow-up opens", description: "A client opened a follow-up email" },
	{ type: "invoice_paid", group: "Sales & billing", permission: "view_invoices", label: "Invoice payments", description: "A payment was recorded on an invoice" },
	{ type: "dispute_opened", group: "Sales & billing", permission: "resolve_disputes", label: "Disputes", description: "A dispute was opened on a document" },
];
