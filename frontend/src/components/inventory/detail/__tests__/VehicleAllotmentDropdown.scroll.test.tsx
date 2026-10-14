/**
 * The drill-in dismisses on scroll on purpose — it does not track the trigger's
 * rect. Its own vehicle list scrolls past ~6 trucks though, and the capture
 * listener sees that too, so it must not treat that internal scroll as the
 * dismiss signal, or scrolling to the truck you wanted closes the panel first.
 */
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "../../../../test/testUtils";
import { describe, expect, test, vi } from "vitest";
import VehicleAllotmentDropdown from "../VehicleAllotmentDropdown";

const ROWS = [
	{ vehicle_id: "v1", vehicle_name: "Truck 12", quantity: 4 },
	{ vehicle_id: "v2", vehicle_name: "Truck 30", quantity: 2 },
];

vi.mock("../../../../hooks/useTracking", () => ({
	useItemVehicleStockQuery: () => ({
		data: { rows: ROWS },
		isLoading: false,
		isError: false,
		refetch: () => {},
	}),
}));

async function openPanel() {
	const user = userEvent.setup();
	render(<VehicleAllotmentDropdown itemId="i1" label="On vehicles" value={6} unit="each" />);
	await user.click(screen.getByRole("button", { name: /On vehicles/ }));
	return screen.getByRole("listbox");
}

describe("VehicleAllotmentDropdown", () => {
	test("scrolling the vehicle list keeps the panel open", async () => {
		const panel = await openPanel();

		fireEvent.scroll(panel);

		expect(screen.getByText("Truck 30")).toBeInTheDocument();
	});

	test("scrolling the page behind it still dismisses", async () => {
		await openPanel();

		fireEvent.scroll(window);

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});
});
