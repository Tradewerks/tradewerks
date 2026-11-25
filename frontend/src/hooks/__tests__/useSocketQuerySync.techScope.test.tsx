import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { handlers, managerHandlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown) => void>(),
	managerHandlers: new Map<string, () => void>(),
}));

vi.mock("../../lib/socket", () => ({
	socket: {
		on: (event: string, fn: (e: unknown) => void) => handlers.set(event, fn),
		off: (event: string) => handlers.delete(event),
		io: {
			on: (event: string, fn: () => void) => managerHandlers.set(event, fn),
			off: (event: string) => managerHandlers.delete(event),
		},
	},
}));

import { useSocketQuerySync } from "../useSocketQuerySync";

const SEEDED: [string, unknown[]][] = [
	["assigned window", ["jobVisits", "assigned", { from: "a", to: "b" }]],
	["assigned default", ["jobVisits", "assigned"]],
	["job picker", ["jobVisits", "mine"]],
	["open detail", ["jobVisits", "v1"]],
	["org-wide list", ["jobVisits", "list", { page: 1 }]],
	["dispatcher per-tech list (no tech screen mounts it)", ["jobVisits", "tech", "t9"]],
	["board", ["board", "a", "b"]],
	["jobs", ["jobs", "list"]],
];

// Seeds one query per key, mounts the hook and reports which keys ended up invalidated.
const mount = (scope: "dispatch" | "tech") => {
	const qc = new QueryClient();
	for (const [, key] of SEEDED) qc.setQueryData(key, []);
	renderHook(() => useSocketQuerySync(scope), {
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		),
	});
	return () =>
		SEEDED.filter(([, key]) => qc.getQueryState(key)?.isInvalidated).map(([name]) => name);
};

const TECH_VISIT_KEYS = ["assigned window", "assigned default", "job picker", "open detail"];

describe("useSocketQuerySync tech scope", () => {
	test("tech scope invalidates only assigned windows, the picker and the open detail on record:changed visit", () => {
		const hit = mount("tech");
		handlers.get("record:changed")!({ type: "visit", id: "v1", jobId: "j1" });
		expect(hit()).toEqual(TECH_VISIT_KEYS);
	});

	test("tech scope refreshes the open visit detail on record:changed job", () => {
		const hit = mount("tech");
		handlers.get("record:changed")!({ type: "job", id: "j1" });
		expect(hit()).toEqual(TECH_VISIT_KEYS);
	});

	test("tech scope never refetches the org-wide list, per-tech lists, board or jobs on legacy events", () => {
		const hit = mount("tech");
		handlers.get("job_visit:updated")!({ visitId: "v1", organizationId: "o1" });
		handlers.get("job:updated")!({ jobId: "j1" });
		managerHandlers.get("reconnect")!();
		expect(hit()).toEqual(TECH_VISIT_KEYS);
	});

	test("dispatch scope keeps the board, jobs and every visit key on record:changed visit", () => {
		const hit = mount("dispatch");
		handlers.get("record:changed")!({ type: "visit", id: "v1", jobId: "j1" });
		expect(hit()).toEqual(expect.arrayContaining([...TECH_VISIT_KEYS, "org-wide list", "board", "jobs"]));
	});
});
