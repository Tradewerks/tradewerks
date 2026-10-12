import { LIMIT_KEYS } from "./limits";
import type { LimitKey, TierContents, TierRow } from "./types";

export type LimitDraft = Record<LimitKey, string>;
export type Draft = { modules: Set<string>; limits: LimitDraft };

export function toDraft(c: TierContents | null): Draft {
	const limits = {} as LimitDraft;
	for (const k of LIMIT_KEYS) {
		const v = c?.limits[k];
		limits[k] = v === null || v === undefined ? "" : String(v);
	}
	return { modules: new Set(c?.modules ?? []), limits };
}

export function fromDraft(d: Draft): { contents: TierContents | null; error: string | null } {
	const limits = {} as TierContents["limits"];
	for (const k of LIMIT_KEYS) {
		const raw = d.limits[k].trim();
		if (raw === "") {
			limits[k] = null;
			continue;
		}
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 0)
			return {
				contents: null,
				error: "Limits must be whole numbers, 0 or more (blank = unlimited)",
			};
		limits[k] = n;
	}
	return { contents: { modules: [...d.modules].sort(), limits }, error: null };
}

export function sameContents(a: TierContents | null, b: TierContents | null): boolean {
	if (!a || !b) return false;
	return (
		JSON.stringify([...a.modules].sort()) === JSON.stringify(b.modules) &&
		LIMIT_KEYS.every((k) => (a.limits[k] ?? null) === b.limits[k])
	);
}

export function tierFlags(t: TierRow): string[] {
	return [
		t.is_signup_default && "Signup default",
		!t.assignable && "Not assignable",
		t.archived_at && "Archived",
	].filter((f): f is string => !!f);
}
