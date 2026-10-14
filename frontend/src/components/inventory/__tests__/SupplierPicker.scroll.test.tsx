/**
 * The suggestion panel is portaled to <body> and overflows past ~5 vendors, so
 * the capture-phase scroll listener that dismisses it also sees the panel's own
 * scroll. Same defect the catalog picker had, same guard.
 */
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "../../../test/testUtils";
import { describe, expect, test, vi } from "vitest";
import SupplierPicker from "../SupplierPicker";
import type { Supplier } from "../../../types/suppliers";

const SUPPLIERS = [
	{ id: "s1", name: "Ferguson", account_number: "F-1001" },
	{ id: "s2", name: "Johnstone Supply", account_number: null },
	{ id: "s3", name: "Grainger", account_number: "G-77" },
] as unknown as Supplier[];

vi.mock("../../../hooks/useSuppliers", () => ({
	useSuppliers: () => ({ data: SUPPLIERS }),
}));

async function openList() {
	const user = userEvent.setup();
	render(<SupplierPicker value={{}} onChange={() => {}} />);
	await user.click(screen.getByLabelText("Supplier"));
	return screen.getByText("Ferguson").closest("div[class*='overflow-y-auto']") as HTMLElement;
}

describe("SupplierPicker", () => {
	test("scrolling the suggestion list keeps it open", async () => {
		const panel = await openList();

		fireEvent.scroll(panel);

		expect(screen.getByText("Johnstone Supply")).toBeInTheDocument();
	});

	test("scrolling the page behind it still dismisses", async () => {
		await openList();

		fireEvent.scroll(window);

		expect(screen.queryByText("Johnstone Supply")).not.toBeInTheDocument();
	});
});
