import type { ResolvedEntitlements } from "./resolve.js";

export interface EntitlementDiff {
	lost: string[];
	gained: string[];
	lowered: { key: string; from: number | null; to: number | null }[];
	raised: { key: string; from: number | null; to: number | null }[];
}

const stricter = (from: number | null, to: number | null) =>
	to !== null && (from === null || to < from);

export function diffResolved(
	before: ResolvedEntitlements,
	after: ResolvedEntitlements,
): EntitlementDiff {
	const keys = Object.keys({ ...before.modules, ...after.modules });
	const lost = keys.filter(
		(k) => before.modules[k] === "on" && after.modules[k] !== "on",
	);
	const gained = keys.filter(
		(k) => before.modules[k] !== "on" && after.modules[k] === "on",
	);
	const lowered: EntitlementDiff["lowered"] = [];
	const raised: EntitlementDiff["raised"] = [];
	for (const key of Object.keys({ ...before.limits, ...after.limits })) {
		const from = before.limits[key] ?? null;
		const to = after.limits[key] ?? null;
		if (from === to) continue;
		(stricter(from, to) ? lowered : raised).push({ key, from, to });
	}
	return { lost, gained, lowered, raised };
}
