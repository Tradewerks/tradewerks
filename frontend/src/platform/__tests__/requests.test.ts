import { describe, expect, it } from "vitest";
import { approvePrefill, requestParts } from "../requests";
import type { TierRow, UpgradeRequest } from "../types";

const tier = (over: Partial<TierRow> = {}): TierRow => ({
	key: "pro",
	label: "Pro",
	assignable: true,
	archived_at: null,
	is_signup_default: false,
	versions: [
		{
			id: "pv-3",
			version: 3,
			modules: [],
			limits: {},
			note: null,
			created_at: "",
			org_count: 0,
			trial_org_count: 0,
		},
		{
			id: "pv-2",
			version: 2,
			modules: [],
			limits: {},
			note: null,
			created_at: "",
			org_count: 1,
			trial_org_count: 0,
		},
	],
	...over,
});
const req = (over: Partial<UpgradeRequest> = {}): UpgradeRequest => ({
	id: "r1",
	organization_id: "org-1",
	org_name: "Acme",
	requested_by_id: "d-1",
	requested_by_name: "Dana",
	requested_plan_key: "pro",
	requested_plan_label: "Pro",
	requested_modules: [{ key: "quickbooks", label: "QuickBooks" }],
	note: null,
	status: "open",
	resolution_note: null,
	resolved_at: null,
	created_at: "2026-10-07T00:00:00Z",
	...over,
});

describe("request parts", () => {
	it("maps the tier to its latest version and modules to force-on", () => {
		const parts = requestParts(req(), [tier()]);
		expect(parts.map((p) => p.change)).toEqual([
			{ kind: "plan", planVersionId: "pv-3" },
			{ kind: "grant", module: "quickbooks", grant: "on" },
		]);
		expect(approvePrefill(req(), [tier()])).toEqual({
			change: { kind: "plan", planVersionId: "pv-3" },
			title: "Change tier to Pro v3",
			requestId: "r1",
		});
	});

	it("marks an archived or unassignable tier unavailable and prefills the next part", () => {
		const parts = requestParts(req(), [tier({ archived_at: "2026-10-08T00:00:00Z" })]);
		expect(parts[0]).toMatchObject({
			change: null,
			unavailable: "Pro is no longer available",
		});
		expect(approvePrefill(req(), [tier({ assignable: false })])?.change).toEqual({
			kind: "grant",
			module: "quickbooks",
			grant: "on",
		});
	});

	it("has no prefill for a note-only request", () => {
		const noteOnly = req({
			requested_plan_key: null,
			requested_plan_label: null,
			requested_modules: [],
			note: "Need 3 seats",
		});
		expect(requestParts(noteOnly, [tier()])).toEqual([]);
		expect(approvePrefill(noteOnly, [tier()])).toBeNull();
	});
});
