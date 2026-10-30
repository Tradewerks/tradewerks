import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { usePageSummaryQuery } from "../useReports";

const getPageSummary = vi.fn();
vi.mock("../../api/reports", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../api/reports")>()),
	getPageSummary: (...args: unknown[]) => getPageSummary(...args),
}));

// Every list page now loads its summary on mount, so hopping between lists
// must not refetch a summary that was loaded moments ago.
describe("usePageSummaryQuery", () => {
	it("reuses a fresh summary when a list page is revisited", async () => {
		getPageSummary.mockResolvedValue({ page: "jobs", stats: [], breakdown: [], breakdownLabel: "" });
		const client = new QueryClient();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const first = renderHook(() => usePageSummaryQuery("jobs"), { wrapper });
		await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
		first.unmount();

		const second = renderHook(() => usePageSummaryQuery("jobs"), { wrapper });
		await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
		expect(getPageSummary).toHaveBeenCalledTimes(1);
	});
});
