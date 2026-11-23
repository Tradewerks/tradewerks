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

const mount = () => {
	const qc = new QueryClient();
	const spy = vi.spyOn(qc, "invalidateQueries");
	const view = renderHook(() => useSocketQuerySync(), {
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		),
	});
	const keys = () => spy.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey);
	return { spy, keys, unmount: view.unmount };
};

describe("record:changed drives scoped invalidation", () => {
	test("record:changed visit invalidates board, jobVisits, jobs prefix and the named job", () => {
		const { keys } = mount();
		handlers.get("record:changed")!({ type: "visit", id: "v1", jobId: "j1" });
		expect(keys()).toEqual(
			expect.arrayContaining([
				["board"],
				["jobVisits"],
				["jobs"],
				["technicians"],
				["jobs", "j1"],
				["reports", "dashboard-today"],
			]),
		);
	});

	test("record:changed quote invalidates the quotes prefix and that quote, and not jobs", () => {
		const { keys } = mount();
		handlers.get("record:changed")!({ type: "quote", id: "q1" });
		expect(keys()).toEqual(expect.arrayContaining([["quotes"], ["quotes", "q1"]]));
		expect(keys().filter((k) => k[0] === "jobs" || k[0] === "board")).toEqual([]);
	});

	test("job_visit:updated (legacy) now invalidates the jobs prefix", () => {
		const { keys } = mount();
		handlers.get("job_visit:updated")!({ visitId: "v1", organizationId: "o1" });
		expect(keys()).toEqual(expect.arrayContaining([["jobs"], ["board"]]));
	});

	test("reconnect invalidates board, lists and detail prefixes", () => {
		const { keys } = mount();
		managerHandlers.get("reconnect")!();
		expect(keys()).toEqual(
			expect.arrayContaining([
				["board"],
				["jobVisits"],
				["jobs"],
				["clients"],
				["requests"],
				["quotes"],
				["invoices"],
				["arrivals"],
				["technicians"],
			]),
		);
	});

	test("unmount removes the record:changed and reconnect listeners", () => {
		const { unmount } = mount();
		expect(handlers.has("record:changed")).toBe(true);
		expect(managerHandlers.has("reconnect")).toBe(true);
		unmount();
		expect(handlers.has("record:changed")).toBe(false);
		expect(managerHandlers.has("reconnect")).toBe(false);
	});
});
