/**
 * The panel is portaled to <body>, so the component listens for scroll in the
 * capture phase to keep up with its input. That listener also sees the panel's
 * own wheel scroll, so it must ignore scroll events that originate inside the
 * list itself, or the technician's catalog field is unusable with a mouse.
 */
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "../../../test/testUtils";
import { describe, expect, test, vi } from "vitest";
import CatalogItemPicker from "../CatalogItemPicker";
import type { ReconcileTarget } from "../../../api/inventory";

const TARGETS = [
	{ id: "a", name: "Capacitor 45/5", sku: "CAP-455", unit: "each", cost: 12.5 },
	{ id: "b", name: "Contactor 40A", sku: "CON-40", unit: "each", cost: 31 },
	{ id: "c", name: "Blower motor", sku: null, unit: "each", cost: null },
] as unknown as ReconcileTarget[];

vi.mock("../../../hooks/useInventory", () => ({
	useCatalogSearchQuery: () => ({ data: TARGETS, isFetching: false, error: null }),
	useReconcileTargetsQuery: () => ({ data: TARGETS, isFetching: false, error: null }),
}));

async function openList() {
	const user = userEvent.setup();
	render(
		<CatalogItemPicker
			scope="catalog"
			value={null}
			onChange={() => {}}
			ariaLabel="Catalog item for this line"
		/>
	);
	await user.click(screen.getByRole("combobox"));
	return screen.getByRole("listbox");
}

describe("CatalogItemPicker", () => {
	test("scrolling the list itself keeps it open", async () => {
		const panel = await openList();

		fireEvent.scroll(panel);

		expect(screen.getByRole("listbox")).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /Capacitor 45\/5/ })).toBeInTheDocument();
	});

	test("scrolling the page around it keeps it open", async () => {
		await openList();

		fireEvent.scroll(window);

		expect(screen.getByRole("listbox")).toBeInTheDocument();
	});

	test("closes when its input has scrolled out of the viewport", async () => {
		await openList();

		// jsdom reports a zero rect for everything, so the anchor has to say it
		// left the viewport for the dismissal branch to be reachable at all.
		vi.spyOn(screen.getByRole("combobox"), "getBoundingClientRect").mockReturnValue({
			top: window.innerHeight + 200,
			bottom: window.innerHeight + 240,
			left: 0,
			right: 0,
			width: 0,
			height: 40,
			x: 0,
			y: window.innerHeight + 200,
			toJSON: () => ({}),
		});

		fireEvent.scroll(window);

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});
});
