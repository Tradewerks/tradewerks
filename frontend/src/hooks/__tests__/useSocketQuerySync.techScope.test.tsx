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

const mount = (scope: "dispatch" | "tech") => {
	const qc = new QueryClient();
	const spy = vi.spyOn(qc, "invalidateQueries");
	renderHook(() => useSocketQuerySync(scope), {
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		),
	});
	return () => spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
};

describe("useSocketQuerySync tech scope", () => {
	// ["jobVisits"] prefixes the assigned list, the dashboard/map/mileage
	// ["jobVisits", "tech", uid], the picker's ["jobVisits", "mine"] and the open detail.
	test("tech scope invalidates only assigned visits on record:changed visit", () => {
		const keys = mount("tech");
		handlers.get("record:changed")!({ type: "visit", id: "v1", jobId: "j1" });
		expect(keys()).toEqual([["jobVisits"]]);
	});

	test("tech scope refreshes the open visit detail on record:changed job", () => {
		const keys = mount("tech");
		handlers.get("record:changed")!({ type: "job", id: "j1" });
		expect(keys()).toEqual([["jobVisits"]]);
	});

	test("tech scope never refetches the board or job lists on legacy visit events", () => {
		const keys = mount("tech");
		handlers.get("job_visit:updated")!({ visitId: "v1", organizationId: "o1" });
		handlers.get("job:updated")!({ jobId: "j1" });
		managerHandlers.get("reconnect")!();
		expect(keys().filter((k) => k[0] === "jobs" || k[0] === "board")).toEqual([]);
		expect(keys()).toEqual(expect.arrayContaining([["jobVisits"]]));
	});

	test("dispatch scope keeps the board and jobs on record:changed visit", () => {
		const keys = mount("dispatch");
		handlers.get("record:changed")!({ type: "visit", id: "v1", jobId: "j1" });
		expect(keys()).toEqual(expect.arrayContaining([["board"], ["jobs"], ["jobVisits"]]));
	});
});
