import type { OrgDetailPrefill } from "./pages/OrgDetailPage";
import { isAssignable } from "./components/orgDetailUi";
import type { StaffChange, TierRow, UpgradeRequest } from "./types";

export type RequestPart = {
	key: string;
	title: string;
	change: StaffChange | null;
	unavailable?: string;
};

export function requestParts(req: UpgradeRequest, tiers: TierRow[]): RequestPart[] {
	const parts: RequestPart[] = [];
	if (req.requested_plan_key) {
		const t = tiers.find((x) => x.key === req.requested_plan_key);
		const latest = t?.versions[0];
		const label = req.requested_plan_label ?? req.requested_plan_key;
		parts.push(
			t && latest && isAssignable(t)
				? {
						key: "tier",
						title: `Change tier to ${t.label} v${latest.version}`,
						change: { kind: "plan", planVersionId: latest.id },
					}
				: {
						key: "tier",
						title: `Change tier to ${label}`,
						change: null,
						unavailable: `${label} is no longer available`,
					}
		);
	}
	for (const m of req.requested_modules)
		parts.push({
			key: m.key,
			title: `Force on ${m.label}`,
			change: { kind: "grant", module: m.key, grant: "on" },
		});
	return parts;
}

export function approvePrefill(req: UpgradeRequest, tiers: TierRow[]): OrgDetailPrefill | null {
	const part = requestParts(req, tiers).find((p) => p.change);
	return part?.change ? { change: part.change, title: part.title, requestId: req.id } : null;
}
