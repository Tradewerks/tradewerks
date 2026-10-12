import { getAllPermissions } from "../permissionCatalogs.js";

export type ModuleKind = "core" | "optional" | "plan_gated";
export type Access = "read" | "write";

export interface ModuleDef {
	key: string;
	label: string;
	description: string;
	kind: ModuleKind;
	requires: string[];
	permissions: Record<string, Access>;
	// Shown before an org switches the module off. Stored data is always kept;
	// this says what stops and what does not come back on re-enable.
	disableWarning?: string;
}

const r = "read" as const;
const w = "write" as const;

export const MODULES: ModuleDef[] = [
	{
		key: "core",
		label: "Core",
		description:
			"Clients, requests, jobs, visits, schedule, invoices, team.",
		kind: "core",
		requires: [],
		permissions: {
			view_jobs: r,
			create_jobs: w,
			edit_jobs: w,
			delete_jobs: w,
			view_requests: r,
			create_requests: w,
			edit_requests: w,
			delete_requests: w,
			view_invoices: r,
			create_invoices: w,
			edit_invoices: w,
			send_invoices: w,
			delete_invoices: w,
			refund_invoices: w,
			view_clients: r,
			create_clients: w,
			edit_clients: w,
			delete_clients: w,
			view_reports: r,
			export_reports: r,
			view_technicians: r,
			manage_technicians: w,
			view_timesheet: r,
			manage_timesheet: w,
			view_dispatchers: r,
			manage_dispatchers: w,
			view_admin: r,
			manage_roles: w,
			manage_organization: w,
			manage_taxes: w,
			view_assigned_jobs: r,
			view_all_jobs: r,
			update_job_status: w,
			add_job_notes: w,
			view_visits: r,
			check_in: w,
			check_out: w,
			update_visit_status: w,
			add_visit_notes: w,
			view_own_schedule: r,
			view_team_schedule: r,
			view_forms: r,
			submit_forms: w,
		},
	},
	{
		key: "quotes",
		label: "Quotes",
		kind: "optional",
		requires: [],
		description: "Estimates sent to clients before work is booked.",
		permissions: {
			view_quotes: r,
			create_quotes: w,
			edit_quotes: w,
			send_quotes: w,
			delete_quotes: w,
		},
		disableWarning:
			"Existing quotes stay readable. No quotes can be created, edited or sent.",
	},
	{
		key: "recurring_plans",
		label: "Recurring Plans",
		kind: "optional",
		requires: [],
		description: "Repeating service agreements that generate visits.",
		permissions: { view_recurring_plans: r, manage_recurring_plans: w },
		disableWarning:
			"Plans are kept but stop generating visits. Dates missed while off are not created later.",
	},
	{
		key: "projects",
		label: "Projects",
		kind: "optional",
		requires: [],
		description: "Group related jobs under one project.",
		permissions: {
			view_projects: r,
			create_projects: w,
			edit_projects: w,
			delete_projects: w,
		},
		disableWarning:
			"Existing projects stay readable. No projects can be created or edited.",
	},
	{
		key: "inventory",
		label: "Inventory",
		kind: "optional",
		requires: [],
		description: "Stock items, suppliers, serials and batches.",
		permissions: {
			view_inventory: r,
			manage_inventory: w,
			use_inventory: w,
		},
		disableWarning:
			"Stock is not deducted while Inventory is off, and is not corrected afterwards. Counts will need checking if you turn it back on.",
	},
	{
		key: "fleet",
		label: "Fleet",
		kind: "optional",
		requires: [],
		description: "Vehicles, odometer readings and maintenance.",
		permissions: { view_vehicles: r, manage_vehicles: w, use_vehicles: w },
		disableWarning:
			"Vehicles are kept and readable. No vehicle changes can be made.",
	},
	{
		key: "vehicle_stock",
		label: "Vehicle Stock",
		kind: "optional",
		requires: ["inventory", "fleet"],
		description:
			"Stock carried on each vehicle, restocking and adjustments.",
		permissions: {
			stock_own_vehicle: w,
			complete_own_restock: w,
			adjust_field_loss: w,
			adjust_transfer: w,
			adjust_audit: w,
			adjust_warehouse_exchange: w,
		},
		disableWarning:
			"Vehicle stock is not moved while off, and is not corrected afterwards.",
	},
	{
		key: "purchasing",
		label: "Purchasing",
		kind: "optional",
		requires: ["inventory"],
		description: "Purchase orders to suppliers.",
		permissions: { view_purchases: r, manage_purchases: w },
		disableWarning:
			"Existing purchases stay readable. No purchases can be created or received.",
	},
	{
		key: "field_purchases",
		label: "Field Purchases",
		kind: "optional",
		requires: ["inventory"],
		description: "Parts bought by technicians in the field, with review.",
		permissions: {
			view_field_purchases: r,
			review_field_purchases: w,
			second_sign_off_field_purchases: w,
			manage_field_purchase_grants: w,
			view_field_purchase_location: r,
			request_field_purchase: w,
		},
		disableWarning:
			"Existing field purchases stay readable. Technicians cannot start new ones.",
	},
	{
		key: "followups",
		label: "Followups",
		kind: "optional",
		requires: [],
		description:
			"Automatic follow-up emails after quotes, invoices and visits.",
		permissions: { view_followups: r, manage_followups: w },
		disableWarning:
			"Sequences pause. Messages missed while off are not sent later.",
	},
	{
		key: "disputes",
		label: "Disputes",
		kind: "optional",
		requires: [],
		description:
			"Record and resolve client disputes on quotes and invoices.",
		permissions: {
			open_disputes: w,
			resolve_disputes: w,
			concede_disputes: w,
			resolve_own_disputes: w,
		},
		disableWarning:
			"Existing disputes stay readable. No disputes can be opened or resolved.",
	},
	{
		key: "advanced_reporting",
		label: "Advanced Reporting",
		kind: "plan_gated",
		requires: [],
		description:
			"KPI, report builder, P&L, COGS, job profitability, scorecards.",
		permissions: {},
	},
	{
		key: "quickbooks",
		label: "QuickBooks",
		kind: "plan_gated",
		requires: [],
		description:
			"Sync customers, invoices and payments with QuickBooks Online.",
		permissions: {},
		disableWarning:
			"Sync pauses and the connection is kept. Nothing syncs until it is back on.",
	},
	{
		key: "tax_auto",
		label: "Automated Tax",
		kind: "plan_gated",
		requires: [],
		description: "Address-based tax rates.",
		permissions: {},
	},
	{
		key: "ai_assistant",
		label: "AI Assistant",
		kind: "plan_gated",
		requires: [],
		description: "Ask questions and take actions in plain language.",
		permissions: {},
	},
	{
		key: "security_plus",
		label: "Security+",
		kind: "plan_gated",
		requires: [],
		description: "Single sign-on and enforced two-step login.",
		permissions: {},
		disableWarning: "SSO login stops; users sign in with their password.",
	},
];

export const MODULE_KEYS = MODULES.map((m) => m.key);
export type ModuleKey = (typeof MODULE_KEYS)[number];

// The tab id stays "entitlements"; customers know the tab as Subscription.
export const SUBSCRIPTION_PATH = "/dispatch/admin?tab=entitlements";

export const getModule = (key: string): ModuleDef | undefined =>
	MODULES.find((m) => m.key === key);

export const moduleCatalog = () =>
	MODULES.filter((m) => m.kind !== "core").map((m) => ({
		key: m.key,
		label: m.label,
		kind: m.kind,
	}));

export const PERMISSION_MAP: Record<
	string,
	{ module: string; access: Access }
> = Object.create(null);
const duplicates: string[] = [];
const badAccess: string[] = [];
for (const m of MODULES) {
	for (const [perm, access] of Object.entries(m.permissions)) {
		if (PERMISSION_MAP[perm]) duplicates.push(perm);
		if (access !== "read" && access !== "write") badAccess.push(perm);
		PERMISSION_MAP[perm] = { module: m.key, access };
	}
}

// A permission nobody owns would be silently ungated, so this runs at boot.
export function assertRegistry(): void {
	const problems: string[] = [
		...duplicates.map((p) => `owned twice: ${p}`),
		...badAccess.map((p) => `bad access: ${p}`),
	];
	for (const tier of ["dispatcher", "technician"] as const) {
		for (const perm of getAllPermissions(tier)) {
			if (!PERMISSION_MAP[perm]) problems.push(`unowned: ${perm}`);
		}
	}
	for (const m of MODULES) {
		for (const dep of m.requires) {
			if (!getModule(dep))
				problems.push(`${m.key} requires unknown module ${dep}`);
			if (getModule(dep)?.requires.includes(m.key))
				problems.push(`cycle: ${m.key} <-> ${dep}`);
		}
	}
	if (problems.length)
		throw new Error(`Entitlement registry invalid: ${problems.join("; ")}`);
}

// Adding a meter is a code change; changing a limit value is data (spec §3.1).
export const LIMIT_KEYS = [
	"dispatchers",
	"technicians",
	"tax_lookups_month",
	"ai_calls_month",
	"receipt_scans_month",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const METER_KEYS = [
	"ai_calls_month",
	"tax_lookups_month",
	"receipt_scans_month",
] as const satisfies readonly LimitKey[];
export type MeterKey = (typeof METER_KEYS)[number];
