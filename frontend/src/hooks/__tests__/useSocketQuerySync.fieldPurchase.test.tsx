/**
 * Extraction is fired and forgotten off the upload request, so this event is the
 * only thing that tells a sheet already on screen that the receipt has been read.
 * It has to reach the extraction as well as the purchase: the purchase carries what
 * the technician decided, the extraction carries what the receipt said, and it is
 * the second one an open sheet has to offer them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useSocketQuerySync } from "../useSocketQuerySync";
import { qk } from "../../lib/queryKeys";

const handlers = new Map<string, (event: unknown) => void>();

vi.mock("../../lib/socket", () => ({
	socket: {
		on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
		off: () => undefined,
	},
}));

describe("field_purchase:ocr", () => {
	test("refreshes both what the purchase holds and what the receipt read", () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		renderHook(() => useSocketQuerySync(), {
			wrapper: ({ children }) => (
				<QueryClientProvider client={qc}>{children}</QueryClientProvider>
			),
		});

		handlers.get("field_purchase:ocr")!({ id: "fp-1", status: "succeeded" });

		const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
		expect(keys).toContain(JSON.stringify(qk.fieldPurchases.detail("fp-1")));
		expect(keys).toContain(JSON.stringify(qk.fieldPurchases.extraction("fp-1")));
	});
});
