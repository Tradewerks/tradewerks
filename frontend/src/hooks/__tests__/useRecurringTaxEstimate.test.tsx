import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecurringTaxEstimateQuery } from "../useRecurringPlans";
import * as api from "../../api/recurringPlans";

vi.mock("../../api/recurringPlans");
vi.mock("../moduleQuery", async () => {
	const rq = await import("@tanstack/react-query");
	return { moduleQuery: () => rq.useQuery };
});

const base = { address: "1 Main", line_items: [] };
const wrapper = ({ children }: { children: ReactNode }) => {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("useRecurringTaxEstimateQuery", () => {
	beforeEach(() => {
		vi.mocked(api.getRecurringTaxEstimate).mockImplementation(async (i) =>
			i.client_id === "a"
				? { status: "estimate", subtotal_cents: 100, tax_cents: 5, total_cents: 105, place: "X" }
				: { status: "exempt" }
		);
	});

	it("returns no data after the input is cleared", async () => {
		const { result, rerender } = renderHook(
			({ input }) => useRecurringTaxEstimateQuery(input),
			{ wrapper, initialProps: { input: { ...base, client_id: "a" } as never } }
		);
		await waitFor(() => expect(result.current.data?.status).toBe("estimate"));
		rerender({ input: null as never });
		expect(result.current.data).toBeUndefined();
	});

	it("does not show the previous client's estimate while a new client loads", async () => {
		const { result, rerender } = renderHook(
			({ input }) => useRecurringTaxEstimateQuery(input),
			{ wrapper, initialProps: { input: { ...base, client_id: "a" } as never } }
		);
		await waitFor(() => expect(result.current.data?.status).toBe("estimate"));
		rerender({ input: { ...base, client_id: "b" } as never });
		expect(result.current.data).toBeUndefined();
		await waitFor(() => expect(result.current.data?.status).toBe("exempt"));
	});

	it("keeps the previous figure when only line items change", async () => {
		const { result, rerender } = renderHook(
			({ input }) => useRecurringTaxEstimateQuery(input),
			{ wrapper, initialProps: { input: { ...base, client_id: "a" } as never } }
		);
		await waitFor(() => expect(result.current.data?.status).toBe("estimate"));
		rerender({
			input: {
				...base,
				client_id: "a",
				line_items: [{ quantity: 1, unit_price: 1, taxable: true, tax_group_id: null }],
			} as never,
		});
		expect(result.current.data?.status).toBe("estimate");
	});
});
