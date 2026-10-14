import type { EntitlementsData } from "./permissionAccess";
import type { Module } from "./moduleGroups";

export type Draft = Record<string, boolean>;

const optionalInTier = (modules: Module[]) =>
	modules.filter((m) => m.kind === "optional" && m.state !== "not_in_plan");

export function initialDraft(modules: Module[]): Draft {
	return Object.fromEntries(optionalInTier(modules).map((m) => [m.key, m.state === "on"]));
}

// Mirrors setModuleChoices' dependency rules so the batch save passes them in one request.
export function toggleDraft(
	modules: Module[],
	draft: Draft,
	key: string,
): { next: Draft; also: string[] } {
	if (!(key in draft)) return { next: draft, also: [] };
	const byKey = new Map(modules.map((m) => [m.key, m]));
	const next = { ...draft };
	const changed = new Set<string>();
	const turnOn = (k: string) => {
		if (!(k in next) || next[k]) return;
		next[k] = true;
		changed.add(k);
		for (const dep of byKey.get(k)?.requires ?? []) turnOn(dep);
	};
	const turnOff = (k: string) => {
		if (!next[k]) return;
		next[k] = false;
		changed.add(k);
		for (const m of modules) if (m.requires.includes(k)) turnOff(m.key);
	};
	if (next[key]) turnOff(key);
	else turnOn(key);
	changed.delete(key);
	return { next, also: [...changed].map((k) => byKey.get(k)?.label ?? k) };
}

export function draftChanges(modules: Module[], draft: Draft): Record<string, boolean> {
	return Object.fromEntries(
		optionalInTier(modules)
			.filter((m) => draft[m.key] !== (m.state === "on"))
			.map((m) => [m.key, draft[m.key]]),
	);
}

// Where the welcome step hands off: the deep link it interrupted (e.g. a trial email's
// Subscription link), else the dashboard. Only in-app dispatch paths, never back to itself.
export function welcomeReturnPath(state: unknown): string {
	const from = (state as { from?: unknown } | null)?.from;
	return typeof from === "string" &&
		from.startsWith("/dispatch") &&
		!from.startsWith("/dispatch/welcome")
		? from
		: "/dispatch";
}

export function shouldShowWelcome(ent: EntitlementsData | undefined, canManage: boolean): boolean {
	return canManage && !!ent?.setup && !ent.setup.modulesReviewed;
}
