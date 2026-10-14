import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useOpenDisputeMutation, useOpenDisputesQuery, useResolveDisputeMutation } from "../useDisputes";
import * as disputesApi from "../../api/disputes";
import { useAuthStore } from "../../auth/authStore";
import type { Dispute } from "../../types/disputes";

const wrapper =
	(qc: QueryClient) =>
	({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);

const setUser = (role: "dispatcher" | "admin", permissions: string[]) =>
	useAuthStore.setState({
		user: { role, name: "D", userId: "u1", orgId: "o1", orgTimezone: "UTC", permissions },
	});

const openKey = JSON.stringify(["disputes", "open"]);

beforeEach(() => vi.restoreAllMocks());

describe("open disputes query", () => {
	test("does not fetch without view_quotes or view_invoices", () => {
		setUser("dispatcher", ["view_jobs"]);
		const spy = vi.spyOn(disputesApi, "getOpenDisputes");
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useOpenDisputesQuery(), { wrapper: wrapper(qc) });
		expect(spy).not.toHaveBeenCalled();
	});

	test("fetches the org-wide list and a client-scoped list under separate keys", async () => {
		setUser("dispatcher", ["view_invoices"]);
		const empty = { items: [], counts: { quote: 0, invoice: 0 }, total: 0 };
		const spy = vi.spyOn(disputesApi, "getOpenDisputes").mockResolvedValue(empty);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		renderHook(() => useOpenDisputesQuery(), { wrapper: wrapper(qc) });
		renderHook(() => useOpenDisputesQuery("c1"), { wrapper: wrapper(qc) });
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
		expect(spy).toHaveBeenCalledWith(undefined);
		expect(spy).toHaveBeenCalledWith("c1");
		await waitFor(() => expect(qc.getQueryData(["disputes", "open", "all"])).toEqual(empty));
		expect(qc.getQueryData(["disputes", "open", "c1"])).toEqual(empty);
	});
});

describe("dispute mutations refresh the open-disputes lists", () => {
	test("opening a dispute", async () => {
		vi.spyOn(disputesApi, "openDispute").mockResolvedValue({} as Dispute);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useOpenDisputeMutation("invoice", "i1"), { wrapper: wrapper(qc) });
		result.current.mutate({ reason: "x" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(openKey);
	});

	test("resolving a dispute", async () => {
		vi.spyOn(disputesApi, "resolveDispute").mockResolvedValue({} as Dispute);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const spy = vi.spyOn(qc, "invalidateQueries");
		const { result } = renderHook(() => useResolveDisputeMutation("quote", "q1"), { wrapper: wrapper(qc) });
		result.current.mutate({ disputeId: "d1", resolution: "Repeal" });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toContain(openKey);
	});
});
