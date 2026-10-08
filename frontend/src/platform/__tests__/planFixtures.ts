import { vi } from "vitest";
import type { PlanDraft } from "../usePlanDraft";
import type { OrgDetail, TierRow } from "../types";

export const tiers: TierRow[] = [
	{
		key: "pro",
		label: "Pro",
		assignable: true,
		archived_at: null,
		is_signup_default: false,
		is_trial_default: false,
		versions: [
			{
				id: "pv-2",
				version: 2,
				modules: ["quickbooks"],
				limits: {},
				note: null,
				created_at: "",
				org_count: 1,
				trial_org_count: 0,
			},
		],
	},
];
export const detail = (over: Partial<OrgDetail> = {}): OrgDetail => ({
	org: { id: "org-1", name: "Acme" },
	entitlement: {
		plan_version_id: "pv-2",
		plan_source: "operator",
		template_key: "hvac",
		trial_plan_version_id: null,
		trial_ends_at: null,
		module_choices: {},
		module_grants: { quickbooks: "off" },
		limit_overrides: {},
		updated_at: "2026-10-07T00:00:00Z",
	},
	resolved: {
		planKey: "pro",
		planVersion: 2,
		trialActive: false,
		modules: {
			quickbooks: "not_in_plan",
			inventory: "not_in_plan",
			purchasing: "not_in_plan",
		},
		limits: {},
	},
	usage: null,
	catalog: [
		{ key: "quickbooks", label: "QuickBooks", kind: "plan_gated" },
		{ key: "inventory", label: "Inventory", kind: "optional" },
		{ key: "purchasing", label: "Purchasing", kind: "optional" },
	],
	breakdown: {
		modules: {
			quickbooks: { state: "not_in_plan", source: "grant_off" },
			inventory: { state: "not_in_plan", source: "not_in_tier" },
			purchasing: {
				state: "not_in_plan",
				source: "requires",
				blockedBy: "inventory",
			},
		},
		limits: {} as never,
		baseTier: { key: "pro", label: "Pro", version: 2 },
		trialTier: null,
	},
	...over,
});

export const draftOf = (over: Partial<PlanDraft> = {}): PlanDraft =>
	({
		state: null,
		changes: [],
		preview: undefined,
		previewPending: false,
		previewError: null,
		setTier: vi.fn(),
		setGrant: vi.fn(),
		seed: vi.fn(),
		discard: vi.fn(),
		save: vi.fn(),
		saving: false,
		saveError: null,
		conflict: false,
		...over,
	}) as unknown as PlanDraft;
