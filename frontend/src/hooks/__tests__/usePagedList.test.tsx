import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
	listParamsFromSearch,
	listParamsToSearch,
	pagedResultFrom,
	usePagedList,
} from "../usePagedList";
import type { ListParams, PagedResult } from "../../types/paging";

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("listParamsFromSearch / listParamsToSearch", () => {
	it("listParamsFromSearch round-trips status=Sent,Viewed", () => {
		const parsed = listParamsFromSearch(
			new URLSearchParams("status=Sent,Viewed&page=2")
		);
		expect(parsed.status).toEqual(["Sent", "Viewed"]);
		expect(parsed.page).toBe(2);
		expect(parsed.limit).toBe(50);

		const search = listParamsToSearch(parsed);
		expect(search.get("status")).toBe("Sent,Viewed");
		expect(listParamsFromSearch(search)).toEqual(parsed);
	});

	it("falls back to page 1 for a garbage page and drops empty filters", () => {
		const parsed = listParamsFromSearch(
			new URLSearchParams("page=abc&limit=-3&q=&status=&dir=sideways")
		);
		expect(parsed).toEqual({ page: 1, limit: 50 });
		const search = listParamsToSearch(parsed);
		expect(search.toString()).toBe("page=1");
	});

	it("keeps sort, dir, q and the date range", () => {
		const p: ListParams = {
			page: 3,
			limit: 100,
			sort: "created_at",
			dir: "asc",
			q: "smith",
			from: "2026-01-01",
			to: "2026-02-01",
		};
		expect(listParamsFromSearch(listParamsToSearch(p))).toEqual(p);
	});
});

describe("listParamsToSearch with a base", () => {
	it("keeps unrelated URL params and replaces the list ones", () => {
		const base = new URLSearchParams("tab=open&selected=q-1&status=Draft&q=old");
		const search = listParamsToSearch({ page: 2, limit: 50, status: ["Sent"] }, base);
		expect(search.get("tab")).toBe("open");
		expect(search.get("selected")).toBe("q-1");
		expect(search.get("status")).toBe("Sent");
		expect(search.get("page")).toBe("2");
		expect(search.has("q")).toBe(false);
		expect(base.get("status")).toBe("Draft");
	});
});

describe("pagedResultFrom", () => {
	it("reads rows, total, page and limit from the envelope", () => {
		expect(
			pagedResultFrom(
				{
					success: true,
					data: [{ id: "a" }],
					error: null,
					meta: { timestamp: "", count: 41, page: 2, limit: 20 },
				},
				{ page: 2, limit: 20 }
			)
		).toEqual({ rows: [{ id: "a" }], total: 41, page: 2, limit: 20 });
	});
});

describe("usePagedList", () => {
	it("keeps the previous page on screen while the next one loads", async () => {
		let release: (v: PagedResult<string>) => void = () => {};
		const fetcher = vi.fn((p: ListParams) =>
			p.page === 1
				? Promise.resolve({ rows: ["a"], total: 2, page: 1, limit: 1 })
				: new Promise<PagedResult<string>>((r) => {
						release = r;
					})
		);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const { result, rerender } = renderHook(
			({ params }: { params: ListParams }) =>
				usePagedList(["quotes", "list"], fetcher, params),
			{
				wrapper: wrapperFor(client),
				initialProps: { params: { page: 1, limit: 1 } },
			}
		);
		await waitFor(() => expect(result.current.data?.rows).toEqual(["a"]));

		rerender({ params: { page: 2, limit: 1 } });
		await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		expect(result.current.data?.rows).toEqual(["a"]);
		expect(result.current.isPlaceholderData).toBe(true);

		act(() => release({ rows: ["b"], total: 2, page: 2, limit: 1 }));
		await waitFor(() => expect(result.current.data?.rows).toEqual(["b"]));
		expect(client.getQueryData(["quotes", "list", { page: 2, limit: 1 }])).toBeTruthy();
	});
});
