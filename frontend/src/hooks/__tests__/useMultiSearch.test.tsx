import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { useMultiSearch } from "../useMultiSearch";

const run = (url: string) =>
	renderHook(() => ({ ms: useMultiSearch("status"), loc: useLocation() }), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
		),
	});

describe("useMultiSearch.removeTerm", () => {
	it("removes one repeated value", () => {
		const { result } = run("/x?status=New&status=Quoted");
		act(() => result.current.ms.removeTerm("New"));
		expect(new URLSearchParams(result.current.loc.search).getAll("status")).toEqual(["Quoted"]);
	});

	it("removes one part of a comma-joined value", () => {
		const { result } = run("/x?status=New,Quoted&page=2");
		act(() => result.current.ms.removeTerm("New"));
		const sp = new URLSearchParams(result.current.loc.search);
		expect(sp.getAll("status")).toEqual(["Quoted"]);
		expect(sp.get("page")).toBe("2");
	});

	it("keeps a search term that merely contains a comma", () => {
		const { result } = run("/x?status=a, b");
		act(() => result.current.ms.removeTerm("c"));
		expect(new URLSearchParams(result.current.loc.search).getAll("status")).toEqual(["a, b"]);
	});
});
