import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const getJobsPage = vi.fn();
const getJobById = vi.fn();
vi.mock("../../api/jobs", () => ({
	getJobsPage: (...a: unknown[]) => getJobsPage(...a),
	getJobById: (...a: unknown[]) => getJobById(...a),
}));

import { useJobOptions } from "../useJobs";

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
		{children}
	</QueryClientProvider>
);

describe("useJobOptions", () => {
	beforeEach(() => {
		getJobsPage.mockReset();
		getJobById.mockReset();
		getJobsPage.mockResolvedValue({ rows: [{ id: "j1", job_number: "J-1", name: "Alpha" }] });
		getJobById.mockResolvedValue({ id: "sel", job_number: "J-9", name: "Picked" });
	});

	it("sends no search request when disabled, but still resolves the selected job label", async () => {
		const { result } = renderHook(() => useJobOptions("al", "sel", false), { wrapper });
		await waitFor(() => expect(result.current.selectedLabel).toBe("#J-9 — Picked"));
		expect(getJobsPage).not.toHaveBeenCalled();
		expect(result.current.options).toEqual([]);
		expect(getJobById).toHaveBeenCalledWith("sel");
	});

	it("searches when enabled and keeps the selected label alongside the options", async () => {
		const { result } = renderHook(() => useJobOptions("", "sel", true), { wrapper });
		await waitFor(() => expect(result.current.options).toEqual([{ id: "j1", label: "#J-1 — Alpha" }]));
		await waitFor(() => expect(result.current.selectedLabel).toBe("#J-9 — Picked"));
		expect(getJobsPage).toHaveBeenCalled();
	});
});
