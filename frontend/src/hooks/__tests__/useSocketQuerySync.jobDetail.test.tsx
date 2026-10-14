import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown) => void>(),
}));

vi.mock("../../lib/socket", () => ({
	socket: {
		on: (event: string, fn: (e: unknown) => void) => handlers.set(event, fn),
		off: (event: string) => handlers.delete(event),
	},
}));

import { useSocketQuerySync } from "../useSocketQuerySync";

const mount = () => {
	const qc = new QueryClient();
	const spy = vi.spyOn(qc, "invalidateQueries");
	renderHook(() => useSocketQuerySync(), {
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		),
	});
	return spy;
};

describe("visit status changes refresh the owning job page", () => {
	test("status_changed invalidates that job's queries", () => {
		const spy = mount();
		handlers.get("job_visit:status_changed")!({
			visitStatusChanged: true,
			visitStatus: "Driving",
			previousVisitStatus: "Scheduled",
			actor: null,
			visit: {
				id: "v1",
				scheduledAt: "2026-10-01T15:00:00Z",
				job: { id: "j1", client: { name: "Acme" } },
			},
			changedAt: "2026-10-01T15:00:00Z",
		});
		expect(spy).toHaveBeenCalledWith({ queryKey: ["jobs", "j1"] });
	});

	test("a plain visit update carries no job id and touches no job key", () => {
		const spy = mount();
		handlers.get("job_visit:updated")!({ visitId: "v1", organizationId: "o1" });
		const jobCalls = spy.mock.calls.filter(
			([arg]) => (arg as { queryKey?: unknown[] })?.queryKey?.[0] === "jobs",
		);
		expect(jobCalls).toEqual([]);
	});
});
