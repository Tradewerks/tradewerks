import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act, createTestQueryClient } from "../../test/testUtils";
import { usePaymentsReportQuery } from "../useReports";
import * as reportsApi from "../../api/reports";
import type { ReportFetchParams } from "../../types/reports";

vi.mock("../../api/reports", () => ({
	getPaymentsReport: vi.fn(async () => ({ rows: [], total: 0, page: 0, pageSize: 50, hasMore: false })),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
);

afterEach(() => vi.useRealTimers());

// Typing fires one request after the pause; page changes go out immediately.
describe("paginated report search debounce", () => {
	it("debounces searchTerms only", async () => {
		vi.useFakeTimers();
		const fetch = vi.mocked(reportsApi.getPaymentsReport);
		const { rerender } = renderHook((p: ReportFetchParams) => usePaymentsReportQuery(p), {
			wrapper,
			initialProps: { page: 0 } as ReportFetchParams,
		});
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(fetch).toHaveBeenCalledTimes(1);

		for (const t of ["J", "Jo", "Joh", "John"]) {
			rerender({ page: 0, searchTerms: [t] });
			await act(() => vi.advanceTimersByTimeAsync(100));
		}
		expect(fetch).toHaveBeenCalledTimes(1);
		await act(() => vi.advanceTimersByTimeAsync(300));
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenLastCalledWith({ page: 0, searchTerms: ["John"] });

		rerender({ page: 1, searchTerms: ["John"] });
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(fetch).toHaveBeenCalledTimes(3);
	});
});
