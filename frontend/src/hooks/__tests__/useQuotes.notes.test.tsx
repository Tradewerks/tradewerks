/**
 * An in-place note edit closes as soon as mutateAsync resolves, and the view
 * card then renders from the notes cache. If the mutation resolves before the
 * notes refetch lands, the old text flashes back for a moment.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useUpdateQuoteNoteMutation } from "../useQuotes";
import * as quotesApi from "../../api/quotes";

const wrapper =
	(qc: QueryClient) =>
	({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);

describe("useUpdateQuoteNoteMutation", () => {
	test("mutateAsync resolves only after the notes query is refetched", async () => {
		vi.spyOn(quotesApi, "updateQuoteNote").mockResolvedValue({} as never);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		let refetched = false;
		vi.spyOn(qc, "invalidateQueries").mockImplementation(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						refetched = true;
						resolve();
					}, 20)
				)
		);
		const { result } = renderHook(() => useUpdateQuoteNoteMutation(), { wrapper: wrapper(qc) });
		await result.current.mutateAsync({ quoteId: "q1", noteId: "n1", data: { content: "x" } });
		expect(refetched).toBe(true);
	});
});
