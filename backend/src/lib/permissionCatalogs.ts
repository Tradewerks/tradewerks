// Adding a permission here also needs a labelled entry in
// frontend/src/lib/permissionCatalogs.ts, or the roles editor cannot grant it.
const DISPATCHER_CATALOG = [
	{ category: "Jobs", permissions: ["view_jobs", "create_jobs", "edit_jobs", "delete_jobs"] },
	{ category: "Requests", permissions: ["view_requests", "create_requests", "edit_requests", "delete_requests"] },
	// send_quotes is separate from edit_quotes on purpose: a clerk who mails
	// finished quotes has no business changing the prices on them, and an
	// estimator who drafts them has no business contacting the client.
	{ category: "Quotes", permissions: ["view_quotes", "create_quotes", "edit_quotes", "send_quotes", "delete_quotes"] },
	// refund_invoices covers cash leaving the business — a refund row, and the
	// void of an invoice. Separate from edit_invoices, which also covers fixing a
	// due date.
	{ category: "Invoices", permissions: ["view_invoices", "create_invoices", "edit_invoices", "send_invoices", "delete_invoices", "refund_invoices"] },
	{ category: "Clients", permissions: ["view_clients", "create_clients", "edit_clients", "delete_clients"] },
	{ category: "Inventory", permissions: ["view_inventory", "manage_inventory"] },
	{ category: "Reports", permissions: ["view_reports", "export_reports"] },
	{ category: "Timesheets", permissions: ["view_timesheet", "manage_timesheet"] },
	{ category: "Recurring Plans", permissions: ["view_recurring_plans", "manage_recurring_plans"] },
	{ category: "Team", permissions: ["view_technicians", "manage_technicians", "view_dispatchers", "manage_dispatchers"] },
	{ category: "Administration", permissions: ["view_admin", "manage_roles", "manage_organization", "manage_taxes"] },
	{ category: "Vehicles", permissions: ["view_vehicles", "manage_vehicles"] },
	{ category: "Followups", permissions: ["view_followups", "manage_followups"] },
	{ category: "Projects", permissions: ["view_projects", "create_projects", "edit_projects", "delete_projects"] },
	// Reviewing is separate from granting authority: the dispatcher who approves a
	// reimbursement should not also be the one who sets its ceiling.
	// Reading a technician's captured coordinates is separate from reading the
	// purchase: it is sensitive personal information, and only a reviewer checking
	// a position against the vendor has a reason to see it.
	// Opening a dispute is not a document edit: whoever takes the client's call
	// has to be able to record the disagreement without edit rights. Resolving is
	// the money decision, and the two concessions — an adjustment or an outright
	// repeal — need concede_disputes on top of it.
	// resolve_own_disputes exists for owner-operator orgs, where the person who
	// logged the dispute is the only person who could ever close it.
	{ category: "Disputes", permissions: ["open_disputes", "resolve_disputes", "concede_disputes", "resolve_own_disputes"] },
	{ category: "Field Purchases", permissions: ["view_field_purchases", "review_field_purchases", "second_sign_off_field_purchases", "manage_field_purchase_grants", "view_field_purchase_location"] },
	{ category: "Purchases", permissions: ["view_purchases", "manage_purchases"] },
] as const;

const TECHNICIAN_CATALOG = [
	{ category: "Jobs", permissions: ["view_assigned_jobs", "view_all_jobs", "update_job_status", "add_job_notes"] },
	{ category: "Job Visits", permissions: ["view_visits", "check_in", "check_out", "update_visit_status", "add_visit_notes"] },
	{ category: "Clients", permissions: ["view_clients"] },
	{ category: "Inventory", permissions: ["view_inventory", "use_inventory"] },
	{ category: "Vehicle Stock", permissions: ["stock_own_vehicle", "complete_own_restock", "adjust_field_loss", "adjust_transfer", "adjust_audit", "adjust_warehouse_exchange"] },
	{ category: "Schedule", permissions: ["view_own_schedule", "view_team_schedule"] },
	{ category: "Forms", permissions: ["view_forms", "submit_forms"] },
	{ category: "Vehicles", permissions: ["view_vehicles", "use_vehicles"] },
	// Reaching the flow only. The spend ceiling lives on the technician's
	// field_purchase_grant, which is per-person and revocable.
	{ category: "Field Purchases", permissions: ["request_field_purchase"] },
	// no view permission right now, all techs can see their time
	{ category: "Timesheets", permissions: [ "edit_own_timesheet",]},
] as const;

export const PERMISSION_CATALOGS = {
	dispatcher: DISPATCHER_CATALOG,
	technician: TECHNICIAN_CATALOG,
} as const;

export type PermissionTier = keyof typeof PERMISSION_CATALOGS;

export function getAllPermissions(tier: PermissionTier): string[] {
	return PERMISSION_CATALOGS[tier].flatMap((section) => [...section.permissions]);
}
