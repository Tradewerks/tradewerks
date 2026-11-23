import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
	getAllJobs: vi.fn(),
	patchVisitTechnicians: vi.fn(async () => ({
		id: "v1",
		job_id: "j1",
		visit_techs: [{ tech_id: "t2" }],
	})),
}));
vi.mock("../../api/jobs", () => api);

import { useAllJobsQuery, usePatchVisitTechniciansMutation } from "../useJobs";

describe("usePatchVisitTechniciansMutation", () => {
	it("sends only the diff", async () => {
		api.getAllJobs.mockResolvedValue([]);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => usePatchVisitTechniciansMutation(), { wrapper });
		await act(async () => {
			await result.current.mutateAsync({ visitId: "v1", add: ["t2"], remove: ["t1"] });
		});
		expect(api.patchVisitTechnicians).toHaveBeenCalledWith("v1", { add: ["t2"], remove: ["t1"] });
	});

	// AssignTechnicianPage no longer refetches the jobs list itself, so the
	// mutation must not resolve before that list has.
	it("resolves only after the jobs list has refetched", async () => {
		let releaseRefetch: (v: unknown[]) => void = () => {};
		api.getAllJobs
			.mockResolvedValueOnce([])
			.mockImplementationOnce(() => new Promise((r) => (releaseRefetch = r)));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => ({ jobs: useAllJobsQuery(), patch: usePatchVisitTechniciansMutation() }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.jobs.isSuccess).toBe(true));

		let settled = false;
		let pending!: Promise<unknown>;
		act(() => {
			pending = result.current.patch
				.mutateAsync({ visitId: "v1", add: ["t2"] })
				.then(() => (settled = true));
		});
		await waitFor(() => expect(api.getAllJobs).toHaveBeenCalledTimes(2));
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);

		await act(async () => {
			releaseRefetch([]);
			await pending;
		});
		expect(settled).toBe(true);
	});
});
