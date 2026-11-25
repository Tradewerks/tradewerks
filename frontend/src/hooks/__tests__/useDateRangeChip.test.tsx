import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { useDateRangeChip } from "../useDateRangeChip";

function setup(initial: string, key = "date", label?: string) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
	);
	return renderHook(() => ({ chip: useDateRangeChip(key, label), loc: useLocation() }), {
		wrapper,
	});
}

describe("useDateRangeChip", () => {
	it("no chip while the range is All", () => {
		expect(setup("/x?status=Open").result.current.chip).toBeNull();
	});

	it("labels a preset range", () => {
		const { result } = setup("/x?date=last_7_days");
		expect(result.current.chip?.label).toBe("Date: Last 7 days");
	});

	it("labels a custom range with the given label", () => {
		const { result } = setup(
			"/x?targetDate=custom&targetDateFrom=2026-11-01&targetDateTo=2026-11-15",
			"targetDate",
			"Target Date"
		);
		expect(result.current.chip?.label).toMatch(/^Target Date: Nov 1 . Nov 15$/);
	});

	it("removing the chip clears only that range's params", () => {
		const { result } = setup("/x?status=Open&date=custom&dateFrom=2026-11-01&dateTo=2026-11-15");
		act(() => result.current.chip!.onRemove());
		expect(result.current.loc.search).toBe("?status=Open");
		expect(result.current.chip).toBeNull();
	});
});
