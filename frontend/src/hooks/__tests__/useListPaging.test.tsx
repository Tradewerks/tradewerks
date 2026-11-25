import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { dateRangeToParams, useListPaging } from "../useListPaging";

// The filters come from the URL (like StatusFilter) plus `extra`, state that
// changes without any navigation (like typed search).
function setup(initial: string) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
	);
	return renderHook(
		({ extra }: { extra: string }) => {
			const loc = useLocation();
			const filters = { status: new URLSearchParams(loc.search).get("status"), extra };
			return { paging: useListPaging(filters), loc, nav: useNavigate() };
		},
		{ wrapper, initialProps: { extra: "" } }
	);
}

describe("useListPaging", () => {
	it("a user filter change resets to page 1", () => {
		const { result } = setup("/x?page=2");
		expect(result.current.paging.page).toBe(2);
		// The filter changes through the URL like a StatusFilter push.
		act(() => result.current.nav("/x?page=2&status=New"));
		expect(result.current.paging.page).toBe(1);
		expect(new URLSearchParams(result.current.loc.search).get("page")).toBeNull();
	});

	it("Back keeps the page of the entry it lands on", () => {
		const { result } = setup("/x?page=2");
		act(() => result.current.nav("/x?page=2&status=New"));
		act(() => result.current.nav(-1));
		expect(result.current.paging.page).toBe(2);
		expect(new URLSearchParams(result.current.loc.search).get("page")).toBe("2");
	});

	it("after Back, a filter change that does not navigate still resets to page 1", () => {
		const { result, rerender } = setup("/x?page=2");
		act(() => result.current.nav("/x?page=2&status=New"));
		act(() => result.current.nav(-1));
		expect(result.current.paging.page).toBe(2);
		// Typed search: the filter changes, the location does not.
		rerender({ extra: "typed" });
		expect(result.current.paging.page).toBe(1);
		expect(new URLSearchParams(result.current.loc.search).get("page")).toBeNull();
	});

	it("paginationProps maps the 1-based page to ReportPagination's 0-based one", () => {
		const { result } = setup("/x?page=2&limit=25");
		const p = result.current.paging.paginationProps(80, false);
		expect(p).toMatchObject({ page: 1, pageSize: 25, total: 80, hasMore: true });
		act(() => p.onPageChange(2));
		expect(new URLSearchParams(result.current.loc.search).get("page")).toBe("3");
	});
});

describe("dateRangeToParams", () => {
	it("makes `to` the next local midnight", () => {
		const r = dateRangeToParams({ option: "today" });
		const to = new Date(r.to!);
		expect([to.getHours(), to.getMinutes(), to.getMilliseconds()]).toEqual([0, 0, 0]);
		expect(to.getTime()).toBeGreaterThan(new Date(r.from!).getTime());
		expect(dateRangeToParams({ option: "all" })).toEqual({});
	});
});
