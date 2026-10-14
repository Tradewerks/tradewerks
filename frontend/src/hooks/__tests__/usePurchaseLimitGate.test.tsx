/**
 * A cleared verdict is a statement about one purchase's spend windows. Both halves
 * matter: the request has to name the purchase so the server can leave its own
 * total out, and the cache has to key on it so one purchase's clearance never
 * answers for another's.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { usePurchaseLimitGate } from "../useFieldPurchases";
import { qk } from "../../lib/queryKeys";

const mockCheckLimit = vi.fn();
vi.mock("../../api/fieldPurchases", () => ({
	checkLimit: (...args: unknown[]) => mockCheckLimit(...args),
}));

const clear = { verdict: { authorized: true, requires_preauth: false, breaches: [] } };

const wrapper = (qc: QueryClient) =>
	function Wrapper({ children }: { children: React.ReactNode }) {
		return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
	};

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
	mockCheckLimit.mockResolvedValue(clear);
});

describe("usePurchaseLimitGate", () => {
	test("sends the purchase id it is scoped to", async () => {
		renderHook(
			() =>
				usePurchaseLimitGate({
					scopeKey: "p1",
					total: 120,
					allocations: [{ job_id: "job-a", amount: 120 }],
				}),
			{ wrapper: wrapper(client()) }
		);

		await waitFor(() => expect(mockCheckLimit).toHaveBeenCalled());
		expect(mockCheckLimit).toHaveBeenCalledWith(120, [{ job_id: "job-a", amount: 120 }], "p1");
	});

	// Without the id in the key, a figure cleared against one purchase's spend is
	// served from cache for another purchase that has never been checked.
	test("keys the cache by purchase id", async () => {
		const qc = client();
		const opts = { total: 120, allocations: [{ job_id: "job-a", amount: 120 }] };

		const first = renderHook(() => usePurchaseLimitGate({ scopeKey: "p1", ...opts }), {
			wrapper: wrapper(qc),
		});
		await waitFor(() => expect(mockCheckLimit).toHaveBeenCalledTimes(1));
		first.unmount();

		renderHook(() => usePurchaseLimitGate({ scopeKey: "p2", ...opts }), {
			wrapper: wrapper(qc),
		});
		await waitFor(() => expect(mockCheckLimit).toHaveBeenCalledTimes(2));

		const keys = qc
			.getQueryCache()
			.getAll()
			.map((q) => JSON.stringify(q.queryKey));
		const keyFor = (purchaseId: string) =>
			JSON.stringify(
				qk.fieldPurchases.limitCheck({
					amount: 120,
					jobs: [{ job_id: "job-a", amount: 120 }],
					purchaseId,
				})
			);
		expect(keys).toContain(keyFor("p1"));
		expect(keys).toContain(keyFor("p2"));
	});
});
