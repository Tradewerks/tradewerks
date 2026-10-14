import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LineStockDisclosure from "../LineStockDisclosure";
import { blankLine, type LineDraft } from "../lineDrafts";

const MY_TRUCK = { id: "veh-1", name: "Truck 12" };
vi.mock("../../../../hooks/useInventory", () => ({
	useCatalogSearchQuery: () => ({ data: [], isFetching: false, error: null }),
	useReconcileTargetsQuery: () => ({ data: [], isFetching: false, error: null }),
}));

const show = (
	over: Partial<LineDraft> = {},
	onChange = vi.fn(),
	myVehicle: { id: string; name: string } | null = MY_TRUCK
) => {
	render(
		<LineStockDisclosure
			draft={{ ...blankLine(), description: "Capacitor", ...over }}
			editable
			myVehicle={myVehicle}
			onChange={onChange}
		/>
	);
	return onChange;
};

const toggle = () => screen.getByRole("button", { name: /stock & billing/i });
// Scoped to the summary row: the select's own "Not recorded" option carries the
// same words once the group is open.
const badge = (text: string) => within(toggle()).getByText(text);

describe("the stock & billing disclosure", () => {
	// A line typed at the counter already carries the billable answer, so the
	// question is asked only of someone who goes looking for it.
	it("is collapsed on the default disposition", () => {
		show({ disposition: "non_stock" });
		expect(toggle()).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByLabelText(/what happened to it/i)).toBeNull();
	});

	it("summarises a billed line", () => {
		show({ disposition: "non_stock" });
		expect(badge("Billed to job")).toBeInTheDocument();
	});

	it("summarises a stocked line by where it went", () => {
		show({ disposition: "receive", disposition_vehicle_id: "veh-1" });
		expect(badge("To Truck 12")).toBeInTheDocument();
	});

	it("calls a stocked line with no vehicle the warehouse", () => {
		show({ disposition: "receive", disposition_vehicle_id: "" });
		expect(badge("To Warehouse")).toBeInTheDocument();
	});

	// Nothing is billed and nothing is stocked, which is the one state that must
	// not be hidden behind a closed disclosure.
	it("warns and opens itself when nothing is recorded", () => {
		show({ disposition: "" });
		expect(toggle()).toHaveAttribute("aria-expanded", "true");
		expect(badge("Not recorded")).toHaveClass("text-warning-text");
	});

	it("names a linked catalog item on the summary", () => {
		show({
			disposition: "non_stock",
			item: {
				id: "it-1",
				name: "Run capacitor 45uF",
			} as unknown as LineDraft["item"],
		});
		expect(badge("Run capacitor 45uF")).toBeInTheDocument();
	});

	it("opens and closes on demand", async () => {
		show({ disposition: "non_stock" });
		await userEvent.click(toggle());
		expect(toggle()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByLabelText(/what happened to it/i)).toBeInTheDocument();
		await userEvent.click(toggle());
		expect(toggle()).toHaveAttribute("aria-expanded", "false");
	});

	it("only offers the vehicle select for a stocked line", async () => {
		show({ disposition: "non_stock" });
		await userEvent.click(toggle());
		expect(screen.queryByLabelText(/goes onto/i)).toBeNull();
	});

	// The rule that keeps the submit payload identical.
	it("seeds the technician's own truck when a line turns into stock", async () => {
		const onChange = vi.fn();
		render(
			<LineStockDisclosure
				draft={{ ...blankLine(), disposition: "non_stock" }}
				editable
				myVehicle={MY_TRUCK}
				onChange={onChange}
			/>
		);
		await userEvent.click(toggle());
		await userEvent.selectOptions(
			screen.getByLabelText(/what happened to it/i),
			"receive"
		);
		expect(onChange).toHaveBeenCalledWith({
			disposition: "receive",
			disposition_vehicle_id: "veh-1",
		});
	});

	it("clears the vehicle when it stops being stock", async () => {
		const onChange = show({ disposition: "receive", disposition_vehicle_id: "veh-1" });
		await userEvent.click(toggle());
		await userEvent.selectOptions(
			screen.getByLabelText(/what happened to it/i),
			"non_stock"
		);
		expect(onChange).toHaveBeenCalledWith({
			disposition: "non_stock",
			disposition_vehicle_id: "",
		});
	});

	it("has a 44px toggle", () => {
		show();
		expect(toggle()).toHaveClass("min-h-11");
	});

	// Colour alone does not carry it: the row is scanned down a list.
	it("marks the warn state with an icon as well as the colour", () => {
		show({ disposition: "" });
		// The chevron plus the warning triangle; a recorded line has only the chevron.
		expect(toggle().querySelectorAll("svg")).toHaveLength(2);
	});

	it("leaves a recorded line's summary icon-free", () => {
		show({ disposition: "non_stock" });
		expect(toggle().querySelectorAll("svg")).toHaveLength(1);
	});

	it("points the toggle at the panel it reveals", async () => {
		show({ disposition: "non_stock" });
		await userEvent.click(toggle());
		const id = toggle().getAttribute("aria-controls");
		expect(id).toBeTruthy();
		expect(document.getElementById(id!)).not.toBeNull();
	});

	it("still says Warehouse when the warehouse is genuinely the answer", () => {
		show({ disposition: "receive", disposition_vehicle_id: "" });
		expect(badge("To Warehouse")).toBeInTheDocument();
	});

	// The whole point of the change: the fleet was offered here, and stocking
	// another crew's van is something the server now refuses outright.
	it("offers the warehouse and the technician's own truck, and nothing else", async () => {
		show({ disposition: "receive", disposition_vehicle_id: "" });
		await userEvent.click(toggle());
		const group = screen.getByRole("radiogroup", { name: /goes onto/i });
		const options = within(group).getAllByRole("radio");
		expect(options.map((o) => o.textContent)).toEqual(["Warehouse", "Truck 12"]);
	});

	it("marks the destination the line actually holds", async () => {
		show({ disposition: "receive", disposition_vehicle_id: MY_TRUCK.id });
		await userEvent.click(toggle());
		expect(screen.getByRole("radio", { name: "Truck 12" })).toHaveAttribute(
			"aria-checked",
			"true"
		);
		expect(screen.getByRole("radio", { name: "Warehouse" })).toHaveAttribute(
			"aria-checked",
			"false"
		);
	});

	it("sends the truck id when the truck is picked", async () => {
		const onChange = show({ disposition: "receive", disposition_vehicle_id: "" });
		await userEvent.click(toggle());
		await userEvent.click(screen.getByRole("radio", { name: "Truck 12" }));
		expect(onChange).toHaveBeenCalledWith({ disposition_vehicle_id: MY_TRUCK.id });
	});

	// Warehouse is never blocked, so a technician between trucks can still record
	// the line — they are told why the truck is missing rather than left guessing.
	it("offers the warehouse alone, with a reason, when no truck is assigned", async () => {
		show({ disposition: "receive", disposition_vehicle_id: "" }, vi.fn(), null);
		await userEvent.click(toggle());
		const group = screen.getByRole("radiogroup", { name: /goes onto/i });
		expect(within(group).getAllByRole("radio")).toHaveLength(1);
		expect(screen.getByText(/no truck assigned/i)).toBeInTheDocument();
	});
});
