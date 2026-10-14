/**
 * Every quote status-changing mutation must invalidate that quote's dispute
 * query (["disputes", "quote", id]), same as useUpdateInvoiceMutation does
 * for invoices. Without it, the "Open Dispute" button's disabled reason
 * (computed from the cached dispute list's open_refusal) goes stale after a
 * status change — e.g. Draft -> Issued via "Issue Without Sending" still
 * shows "A Draft quote can't be disputed" until an unrelated refetch.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
	useUpdateQuoteMutation,
	useSendQuoteMutation,
	useRejectQuoteMutation,
	useReviseQuoteMutation,
	useCancelQuoteMutation,
} from "../useQuotes";
import * as quotesApi from "../../api/quotes";
import type { Quote } from "../../types/quotes";

const fakeQuote = { id: "q1" } as unknown as Quote;

const wrapper =
	(qc: QueryClient) =>
	({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);

const disputesKey = JSON.stringify(["disputes", "quote", "q1"]);

describe("quote status mutations invalidate the quote's dispute query", () => {
	test("useUpdateQuoteMutation (Issue Without Sending / Approve / etc.)", async () => {
		vi.spyOn(quotesApi, "updateQuote").mockResolvedValue(fakeQuote);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useUpdateQuoteMutation(), { wrapper: wrapper(qc) });

		result.current.mutate({ id: "q1", data: {} });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
		expect(keys).toContain(disputesKey);
	});

	test("useSendQuoteMutation", async () => {
		vi.spyOn(quotesApi, "sendQuote").mockResolvedValue(fakeQuote);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useSendQuoteMutation(), { wrapper: wrapper(qc) });

		result.current.mutate({ id: "q1", recipientEmail: "a@b.com" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
		expect(keys).toContain(disputesKey);
	});

	test("useRejectQuoteMutation", async () => {
		vi.spyOn(quotesApi, "rejectQuote").mockResolvedValue(fakeQuote);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useRejectQuoteMutation(), { wrapper: wrapper(qc) });

		result.current.mutate({ id: "q1" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
		expect(keys).toContain(disputesKey);
	});

	test("useReviseQuoteMutation", async () => {
		vi.spyOn(quotesApi, "reviseQuote").mockResolvedValue(fakeQuote);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useReviseQuoteMutation(), { wrapper: wrapper(qc) });

		result.current.mutate({ id: "q1" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
		expect(keys).toContain(disputesKey);
	});

	test("useCancelQuoteMutation", async () => {
		vi.spyOn(quotesApi, "cancelQuote").mockResolvedValue(fakeQuote);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useCancelQuoteMutation(), { wrapper: wrapper(qc) });

		result.current.mutate({ id: "q1" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
		expect(keys).toContain(disputesKey);
	});
});
