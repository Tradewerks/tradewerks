import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
	getTaxGroups: vi.fn(),
	updateTaxGroup: vi.fn(async () => ({})),
	getDefaultTaxGroup: vi.fn(async () => null),
}));
vi.mock("../../api/tax", () => api);

import { useTaxGroups, useUpdateTaxGroup } from "../useTaxGroups";

describe("useUpdateTaxGroup", () => {
	// Callers close their UI when mutateAsync resolves; resolving before the
	// list refetches flashes the old default back on screen.
	it("resolves only after the groups list has refetched", async () => {
		let releaseRefetch: (v: unknown[]) => void = () => {};
		api.getTaxGroups
			.mockResolvedValueOnce([])
			.mockImplementationOnce(() => new Promise((r) => (releaseRefetch = r)));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const { result } = renderHook(
			() => ({ list: useTaxGroups(false), update: useUpdateTaxGroup() }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

		let settled = false;
		let pending!: Promise<unknown>;
		act(() => {
			pending = result.current.update
				.mutateAsync({ id: "g", data: { is_default: true } })
				.then(() => (settled = true));
		});
		await waitFor(() => expect(api.getTaxGroups).toHaveBeenCalledTimes(2));
		await new Promise((r) => setTimeout(r, 20));
		expect(settled).toBe(false);

		await act(async () => {
			releaseRefetch([]);
			await pending;
		});
		expect(settled).toBe(true);
	});
});
