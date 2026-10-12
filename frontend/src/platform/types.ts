import type { UpgradeRequest as OrgUpgradeRequest } from "../api/upgradeRequests";
export type LimitKey =
	| "dispatchers"
	| "technicians"
	| "ai_calls_month"
	| "tax_lookups_month"
	| "receipt_scans_month";
export type ModuleState = "on" | "off_by_org" | "not_in_plan";

export interface StaffSession {
	token: string;
	staff: { id: string; email: string; name: string };
}

export interface StaffRow {
	id: string;
	email: string;
	name: string;
	status: "invited" | "active" | "disabled";
	accepted: boolean;
	mfa_enrolled: boolean;
	last_login: string | null;
	invite_expires_at: string | null;
	created_at: string;
}

export interface UsageSummary {
	period_start: string;
	meters: Record<LimitKey, { used: number; limit: number | null }>;
}

export interface ResolvedEntitlements {
	planKey: string;
	planVersion: number;
	trialActive: boolean;
	modules: Record<string, ModuleState>;
	limits: Record<string, number | null>;
}

export type ModuleSource =
	| "tier"
	| "trial"
	| "grant_on"
	| "grant_off"
	| "not_in_tier"
	| "org_off"
	| "requires";

export interface ModuleBreakdown {
	state: ModuleState;
	source: ModuleSource;
	blockedBy?: string;
}

export interface LimitBreakdown {
	tier: number | null;
	trial?: number | null;
	override?: number | null;
	effective: number | null;
}

export interface TierRef {
	key: string;
	label: string;
	version: number;
}

export interface EntitlementBreakdown {
	modules: Record<string, ModuleBreakdown>;
	limits: Record<LimitKey, LimitBreakdown>;
	baseTier: TierRef;
	trialTier: (TierRef & { endsAt: string }) | null;
}

export interface OrgListRow {
	id: string;
	name: string;
	timezone: string;
	tier: { key: string; label: string; version: number } | null;
	trial: { tierLabel: string; endsAt: string } | null;
	template: string | null;
	usage: UsageSummary | null;
}

export interface OrgListPage {
	rows: OrgListRow[];
	total: number;
	page: number;
	pageSize: number;
}

export interface CreateOrgBody {
	name: string;
	admin_name: string;
	admin_email: string;
	business_type: string;
	plan_key: string;
	trial?: { plan_key: string; days: number };
}

export interface OrgDetail {
	org: { id: string; name: string; timezone: string };
	adminInvite: { email: string; expiresAt: string } | null;
	entitlement: {
		plan_version_id: string;
		plan_source: string;
		template_key: string;
		trial_plan_version_id: string | null;
		trial_ends_at: string | null;
		module_choices: Record<string, boolean>;
		module_grants: Record<string, "on" | "off">;
		limit_overrides: Record<string, number | null>;
		updated_at: string;
	} | null;
	resolved: ResolvedEntitlements;
	breakdown?: EntitlementBreakdown | null;
	usage: UsageSummary | null;
	catalog: { key: string; label: string; kind: "optional" | "plan_gated" }[];
}

export interface StaffActivityRow {
	id: string;
	timestamp: string;
	event_type: string;
	actor_type: string;
	actor_name: string | null;
	entity_id: string;
	changes: { factor?: { new: "password" | "mfa" } } | null;
	target_name: string | null;
}

export interface HistoryRow {
	id: string;
	timestamp: string;
	event_type: string;
	actor_type: string;
	actor_name: string | null;
	staff_name: string | null;
	reason: string | null;
	changes: unknown;
}

export interface TierRow {
	key: string;
	label: string;
	assignable: boolean;
	archived_at: string | null;
	is_signup_default: boolean;
	versions: {
		id: string;
		version: number;
		modules: string[];
		limits: Record<string, number | null>;
		note: string | null;
		created_at: string;
		org_count: number;
		trial_org_count: number;
	}[];
}

export type TierVersion = TierRow["versions"][number];

export type StaffChange =
	| { kind: "plan"; planVersionId: string }
	| { kind: "trial"; trial: { planVersionId: string; endsAt: string } | null }
	| { kind: "grant"; module: string; grant: "on" | "off" | null }
	| { kind: "limit"; key: LimitKey; override: number | null | "tier" };

export interface EntitlementDiff {
	lost: string[];
	gained: string[];
	lowered: { key: string; from: number | null; to: number | null }[];
	raised: { key: string; from: number | null; to: number | null }[];
}

export interface StaffChangePreview {
	before: ResolvedEntitlements;
	after: ResolvedEntitlements;
	diff: EntitlementDiff;
	blockers: { module: string; label: string; count: number; message: string }[];
	overCap: { key: string; used: number; limit: number }[];
}

export interface StaffChangesPreview extends StaffChangePreview {
	breakdown: EntitlementBreakdown;
}

export type CatalogModule = { key: string; label: string; kind: "optional" | "plan_gated" };
export type TierContents = { modules: string[]; limits: Record<LimitKey, number | null> };
export interface MovePreview {
	from: { id: string; version: number };
	to: { id: string; version: number };
	truncated: boolean;
	rows: {
		orgId: string;
		name: string;
		diff: EntitlementDiff;
		blockers: StaffChangePreview["blockers"];
		overCap: StaffChangePreview["overCap"];
		trialDefers: { tierLabel: string; endsAt: string } | null;
	}[];
}
export type SkipCause = "not_on_version" | "no_entitlement" | "conflict" | "error";
export interface MoveResult {
	toVersion: number;
	moved: { orgId: string; name: string }[];
	skipped: { orgId: string; name: string; cause: SkipCause; message?: string }[];
}
export interface UpgradeRequest extends OrgUpgradeRequest {
	org_name: string;
}
export type RequestResolution = "approved" | "declined";
export interface RequestPage {
	rows: UpgradeRequest[];
	total: number;
	page: number;
	pageSize: number;
}
export type TierPatch =
	| { label: string }
	| { archived: boolean }
	| { signupDefault: true };
