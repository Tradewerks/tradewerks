import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const getClientMapPoints = vi.fn();
vi.mock("../../api/clients", () => ({
	getClientMapPoints: (...a: unknown[]) => getClientMapPoints(...a),
}));

import { useClientMapPointsQuery } from "../useClients";
import { qk } from "../../lib/queryKeys";

describe("useClientMapPointsQuery", () => {
	it("reads the slim map-points source under the clients prefix, so a client change refreshes it", async () => {
		getClientMapPoints.mockResolvedValue([{ id: "c1", name: "Acme", coords: { lat: 1, lon: 2 } }]);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(() => useClientMapPointsQuery(), { wrapper });
		await waitFor(() => expect(result.current.data).toHaveLength(1));

		expect(getClientMapPoints).toHaveBeenCalledTimes(1);
		const key = qc.getQueryCache().getAll()[0].queryKey;
		expect(key.slice(0, qk.clients.all.length)).toEqual([...qk.clients.all]);
		await qc.invalidateQueries({ queryKey: qk.clients.all });
		expect(getClientMapPoints).toHaveBeenCalledTimes(2);
	});
});
