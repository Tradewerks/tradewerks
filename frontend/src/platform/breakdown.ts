import { LIMIT_KEYS, LIMIT_LABELS } from "./limits";
import type {
	EntitlementBreakdown,
	EntitlementDiff,
	LimitBreakdown,
	LimitKey,
	ModuleBreakdown,
	StaffChangePreview,
	StaffChange,
	TierRow,
	TierVersion,
} from "./types";

export const showLimit = (v: number | null) => (v === null ? "Unlimited" : String(v));
const limitLabel = (k: string) => LIMIT_LABELS[k as LimitKey] ?? k;
const rank = (v: number | null) => (v === null ? Infinity : v);

export function moduleSourceLine(
	b: ModuleBreakdown,
	bd: EntitlementBreakdown,
	moduleLabel: (k: string) => string
): string {
	switch (b.source) {
		case "tier":
			return `Included in ${bd.baseTier.label}`;
		case "trial":
			return `Included in trial (${bd.trialTier?.label ?? "trial"})`;
		case "not_in_tier":
			return `Not in ${(bd.trialTier ?? bd.baseTier).label}`;
		case "grant_on":
			return "Forced on";
		case "grant_off":
			return "Forced off";
		case "org_off":
			return "Allowed · switched off by the organization";
		case "requires":
			return `Off · requires ${moduleLabel(b.blockedBy ?? "")}`;
	}
}

export function limitSourceLine(l: LimitBreakdown): string {
	if (l.override !== undefined)
		return `Override ${showLimit(l.override)} · tier ${showLimit(l.tier)}${
			l.trial !== undefined ? ` · trial ${showLimit(l.trial)}` : ""
		}`;
	if (l.trial !== undefined) return `Trial ${showLimit(l.trial)} (tier ${showLimit(l.tier)})`;
	return `Tier ${showLimit(l.tier)}`;
}

export function findVersion(tiers: TierRow[], id: string | null | undefined): TierVersion | null {
	if (!id) return null;
	for (const t of tiers) {
		const v = t.versions.find((x) => x.id === id);
		if (v) return v;
	}
	return null;
}

export function tierContentsDiff(from: TierVersion, to: TierVersion): EntitlementDiff {
	const diff: EntitlementDiff = {
		gained: to.modules.filter((m) => !from.modules.includes(m)),
		lost: from.modules.filter((m) => !to.modules.includes(m)),
		raised: [],
		lowered: [],
	};
	for (const key of LIMIT_KEYS) {
		const a = from.limits[key] ?? null;
		const b = to.limits[key] ?? null;
		if (rank(b) > rank(a)) diff.raised.push({ key, from: a, to: b });
		else if (rank(b) < rank(a)) diff.lowered.push({ key, from: a, to: b });
	}
	return diff;
}

export function diffItems(diff: EntitlementDiff, moduleLabel: (k: string) => string): string[] {
	return [
		...diff.gained.map((m) => `${moduleLabel(m)} on`),
		...diff.lost.map((m) => `${moduleLabel(m)} off`),
		...[...diff.raised, ...diff.lowered].map(
			(l) => `${limitLabel(l.key)} ${showLimit(l.from)}→${showLimit(l.to)}`
		),
	];
}

export function appliedMessage(
	title: string,
	diff: EntitlementDiff,
	moduleLabel: (k: string) => string,
	deferred: boolean
): string {
	const items = diffItems(diff, moduleLabel);
	if (!items.length) return `${title} · ${deferred ? "Saved. No change today." : "Saved."}`;
	const more = items.length > 3 ? ` · +${items.length - 3} more` : "";
	return `${title} · ${items.slice(0, 3).join(" · ")}${more}`;
}

export function changedKeys(diff: EntitlementDiff, change: StaffChange): Set<string> {
	const keys = new Set<string>([
		...diff.gained,
		...diff.lost,
		...diff.raised.map((l) => l.key),
		...diff.lowered.map((l) => l.key),
	]);
	if (change.kind === "grant") keys.add(change.module);
	if (change.kind === "limit") keys.add(change.key);
	return keys;
}

export type LimitMode = "tier" | "custom" | "unlimited";

export const initialMode = (override: number | null | undefined): LimitMode =>
	override === undefined ? "tier" : override === null ? "unlimited" : "custom";

/** The override to send, or undefined when the input is invalid or changes nothing. */
export function nextOverride(
	mode: LimitMode,
	raw: string,
	current: number | null | undefined
): number | null | "tier" | undefined {
	if (mode === "tier") return current === undefined ? undefined : "tier";
	if (mode === "unlimited") return current === null ? undefined : null;
	if (raw.trim() === "") return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n === current) return undefined;
	return n;
}

export const isLosing = (p: StaffChangePreview | undefined) =>
	!!p && (p.diff.lost.length > 0 || p.diff.lowered.length > 0);

export const changesNothing = (p: StaffChangePreview) =>
	!p.diff.lost.length &&
	!p.diff.gained.length &&
	!p.diff.lowered.length &&
	!p.diff.raised.length;
