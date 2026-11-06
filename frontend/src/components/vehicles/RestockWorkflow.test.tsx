import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi, beforeEach } from "vitest";
import RestockWorkflow from "./RestockWorkflow";
import type { VehicleStockItem } from "../../types/vehicles";

const mockCompleteMutate = vi.fn();
const mockTomorrowRequirementsQuery = vi.fn();
const mockVehicleUsageTodayQuery = vi.fn();
vi.mock("../../hooks/useVehicleStock", () => ({
	useCompleteRestockMutation: () => ({
		mutate: mockCompleteMutate,
		isPending: false,
	}),
	// mockReturnValue (not an inline arrow returning a literal) so `data` keeps
	// the same object/array reference across re-renders — RestockWorkflow's
	// useMemo/useEffect chain depends on that reference stability, exactly like
	// TanStack Query provides for real; a fresh literal each call causes an
	// infinite render loop (tomorrowVisits -> tomorrowNeeds -> effect -> setState -> …).
	useTomorrowRequirementsQuery: (...args: unknown[]) => mockTomorrowRequirementsQuery(...args),
	useVehicleUsageTodayQuery: (...args: unknown[]) => mockVehicleUsageTodayQuery(...args),
}));

const mockSerialsQuery = vi.fn();
const mockBatchesQuery = vi.fn();
vi.mock("../../hooks/useTracking", () => ({
	useSerialsQuery: (...args: unknown[]) => mockSerialsQuery(...args),
	useBatchesQuery: (...args: unknown[]) => mockBatchesQuery(...args),
	useResolveCodeMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Camera scanning depends on getUserMedia/BarcodeDetector, unavailable in jsdom.
vi.mock("../inventory/BarcodeScanner", () => ({
	BarcodeScanner: () => null,
}));

const serializedStockItem: VehicleStockItem = {
	id: "si-serial",
	vehicle_id: "v1",
	inventory_item_id: "inv-serial",
	inventory_item: {
		id: "inv-serial",
		name: "Compressor",
		category: null,
		is_serialized: true,
		is_batch_tracked: false,
		quantity: 10,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 2,
	qty_min: 1,
	qty_standard: 5,
	updated_at: "",
	created_at: "",
};

const batchStockItem: VehicleStockItem = {
	id: "si-batch",
	vehicle_id: "v1",
	inventory_item_id: "inv-batch",
	inventory_item: {
		id: "inv-batch",
		name: "Refrigerant Jug",
		category: null,
		is_serialized: false,
		is_batch_tracked: true,
		quantity: 10,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 1,
	qty_min: 1,
	qty_standard: 4,
	updated_at: "",
	created_at: "",
};

// Known client-side shortfall: qtyToRestock (standard 5 - on_hand 2 = 3) exceeds
// warehouse quantity (2) — the "already known" shortfall signal RestockPanel's
// own anyShortfall check uses, reused here per-line. qtyToRestock (3) equals the
// mocked serials list length so a "fully selected" capture is reachable in the UI.
const shortSerializedStockItem: VehicleStockItem = {
	id: "si-serial-short",
	vehicle_id: "v1",
	inventory_item_id: "inv-serial-short",
	inventory_item: {
		id: "inv-serial-short",
		name: "Rare Compressor",
		category: null,
		is_serialized: true,
		is_batch_tracked: false,
		quantity: 2,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 2,
	qty_min: 1,
	qty_standard: 5,
	updated_at: "",
	created_at: "",
};

// Already met (qtyToRestock === 0) but serialized — dimmed row, must never show
// tracking UI even though the item itself is trackable.
const metSerializedStockItem: VehicleStockItem = {
	id: "si-serial-met",
	vehicle_id: "v1",
	inventory_item_id: "inv-serial-met",
	inventory_item: {
		id: "inv-serial-met",
		name: "Stocked Compressor",
		category: null,
		is_serialized: true,
		is_batch_tracked: false,
		quantity: 10,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 5,
	qty_min: 1,
	qty_standard: 5,
	updated_at: "",
	created_at: "",
};

// Already met (qtyToRestock === 0) but batch-tracked — same dimmed-row coverage
// for the batch-picker branch.
const metBatchStockItem: VehicleStockItem = {
	id: "si-batch-met",
	vehicle_id: "v1",
	inventory_item_id: "inv-batch-met",
	inventory_item: {
		id: "inv-batch-met",
		name: "Stocked Refrigerant Jug",
		category: null,
		is_serialized: false,
		is_batch_tracked: true,
		quantity: 10,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 4,
	qty_min: 1,
	qty_standard: 4,
	updated_at: "",
	created_at: "",
};

const plainStockItem: VehicleStockItem = {
	id: "si-plain",
	vehicle_id: "v1",
	inventory_item_id: "inv-plain",
	inventory_item: {
		id: "inv-plain",
		name: "Zip Ties",
		category: null,
		is_serialized: false,
		is_batch_tracked: false,
		quantity: 10,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 2,
	qty_min: 1,
	qty_standard: 2,
	updated_at: "",
	created_at: "",
};

beforeEach(() => {
	vi.clearAllMocks();
	mockTomorrowRequirementsQuery.mockReturnValue({ data: [] });
	mockVehicleUsageTodayQuery.mockReturnValue({ data: [], isLoading: false });
	mockSerialsQuery.mockReturnValue({
		data: {
			serials: [
				{ id: "su1", serial_number: "SN-A", status: "in_warehouse" },
				{ id: "su2", serial_number: "SN-B", status: "in_warehouse" },
				{ id: "su3", serial_number: "SN-C", status: "in_warehouse" },
			],
			nextCursor: null,
		},
		isLoading: false,
	});
	mockBatchesQuery.mockReturnValue({
		data: { batches: [{ id: "batch1", batch_number: "LOT-1", qty_in_warehouse: 20, vehicles: [], recalled_at: null }] },
		isLoading: false,
	});
});

function renderWorkflow(stockItems: VehicleStockItem[]) {
	return render(<RestockWorkflow vehicleId="v1" stockItems={stockItems} />);
}

// The technician sheet's layout — full-width mode switch, usage card, tighter
// gutters. The dispatch page renders the same component without it.
function renderMobile(stockItems: VehicleStockItem[]) {
	return render(<RestockWorkflow vehicleId="v1" stockItems={stockItems} layout="mobile" />);
}

describe("RestockWorkflow — mobile field layout", () => {
	test("the mode switch is one full-width segmented control", async () => {
		renderMobile([plainStockItem]);

		const group = await screen.findByRole("group", { name: "Restock mode" });
		expect(group.className).toContain("w-full");

		const restock = screen.getByRole("button", { name: "Restock" });
		const prep = screen.getByRole("button", { name: "Prep for Tomorrow" });
		expect(restock).toHaveAttribute("aria-pressed", "true");
		expect(prep).toHaveAttribute("aria-pressed", "false");
		// Both segments live in the same control, splitting the row evenly.
		expect(group).toContainElement(restock);
		expect(group).toContainElement(prep);
		expect(restock.className).toContain("flex-1");
	});

	test("the usage panel is a labelled, collapsed disclosure", async () => {
		renderMobile([plainStockItem]);

		const toggle = await screen.findByRole("button", { name: /Usage Since Last Restock/ });
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		await userEvent.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
	});

	test("the Restock Quantities title shares one container with its rows", async () => {
		renderMobile([plainStockItem]);

		const title = await screen.findByText("Restock Quantities");
		// Walk up to the bounded table container and confirm the column heads and an
		// item row are inside it too.
		const table = title.closest("div.rounded-lg");
		expect(table).not.toBeNull();
		expect(table).toContainElement(screen.getByText("Item"));
		expect(table).toContainElement(screen.getByRole("button", { name: "Zip Ties" }));
	});
});

describe("RestockWorkflow — editing quantities", () => {
	test("a row keeps its section and focus while its qty passes through 0", async () => {
		const short = { ...plainStockItem, id: "si-short", inventory_item_id: "inv-short", qty_on_hand: 0, inventory_item: { ...plainStockItem.inventory_item, id: "inv-short", name: "Wire Nuts" } };
		renderWorkflow([short, metBatchStockItem]);

		const input = await screen.findByLabelText("Quantity to add for Wire Nuts");
		await userEvent.clear(input);
		expect(input).toHaveDisplayValue("");
		await userEvent.type(input, "5");

		expect(input).toHaveFocus();
		expect(input).toHaveValue(5);
		expect(screen.getByText("Already met").nextSibling).toHaveTextContent("1");
	});
});

describe("RestockWorkflow — tracking capture (P8-2)", () => {
	test("renders the existing-unit picker collapsed for a serialized line needing restock", async () => {
		renderWorkflow([serializedStockItem]);

		// Collapsed: summary bar and scan/browse controls present, candidate rows
		// not. Several serialized lines can need restocking at once, and each one
		// opening its own scroller buried the sheet.
		expect(await screen.findByText("Select existing units")).toBeInTheDocument();
		expect(screen.getByText("Browse")).toBeInTheDocument();
		expect(screen.queryByText("SN-A")).not.toBeInTheDocument();
		expect(mockSerialsQuery).toHaveBeenCalledWith("inv-serial", {
			status: "in_warehouse",
			vehicleId: undefined,
			search: undefined,
			cursor: undefined,
		});
		// Warn-don't-block cue, not a blocker.
		expect(screen.getByText(/0 of 3 units scanned/)).toBeInTheDocument();
	});

	test("Browse reveals the candidate list and a serial search", async () => {
		renderWorkflow([serializedStockItem]);

		await userEvent.click(await screen.findByText("Browse"));

		expect(screen.getByText("SN-A")).toBeInTheDocument();
		expect(screen.getByLabelText("Search serial numbers")).toBeInTheDocument();
		expect(screen.getByText("Hide list")).toBeInTheDocument();
	});

	test("a selected unit stays legible as a chip after the list is collapsed", async () => {
		renderWorkflow([serializedStockItem]);

		await userEvent.click(await screen.findByText("Browse"));
		await userEvent.click(screen.getByLabelText("Select unit SN-A"));
		await userEvent.click(screen.getByText("Hide list"));

		expect(screen.queryByLabelText("Select unit SN-A")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Remove SN-A")).toBeInTheDocument();
	});

	test("the over-limit advisory sits outside the input's cell and can fill the input", async () => {
		// si-serial-short wants 3 with only 2 in the warehouse. The advisory used to
		// live inside the Add cell, which knocked the input off the row's centre
		// line and got clipped by the section's overflow-hidden shell.
		renderWorkflow([shortSerializedStockItem]);

		const input = await screen.findByLabelText("Quantity to add for Rare Compressor");
		expect(input).toHaveAttribute("aria-invalid", "true");

		const advisory = screen.getByRole("status");
		expect(advisory).toHaveTextContent("Only 2 in warehouse");
		// Not a descendant of the input's grid cell — that's the whole fix.
		expect(advisory.contains(input)).toBe(false);
		expect(input.parentElement?.contains(advisory)).toBe(false);
		expect(input).toHaveAttribute("aria-describedby", advisory.id);

		await userEvent.click(screen.getByText("Use 2"));

		expect(input).toHaveValue(2);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	test("a long item name truncates and expands on tap", async () => {
		renderWorkflow([serializedStockItem]);

		const name = await screen.findByRole("button", { name: "Compressor" });
		expect(name).toHaveAttribute("aria-expanded", "false");
		expect(name.className).toContain("truncate");

		await userEvent.click(name);

		expect(name).toHaveAttribute("aria-expanded", "true");
		expect(name.className).not.toContain("truncate");
		expect(name.className).toContain("break-words");
	});

	test("renders the existing-batch picker for a batch-tracked line needing restock", async () => {
		renderWorkflow([batchStockItem]);

		expect(await screen.findByLabelText("Batch / lot")).toBeInTheDocument();
	});

	test("does not render a picker for a plain (untracked) or already-met line", () => {
		renderWorkflow([plainStockItem]);

		expect(screen.queryByText("Select existing units")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Batch / lot")).not.toBeInTheDocument();
	});

	test("submitting with zero units scanned still applies — warn, don't block", async () => {
		renderWorkflow([serializedStockItem]);

		await userEvent.click(await screen.findByText("Apply Restock"));
		await userEvent.click(await screen.findByText("Confirm & Apply"));

		expect(mockCompleteMutate).toHaveBeenCalledTimes(1);
		const [input] = mockCompleteMutate.mock.calls[0];
		expect(input.restock_lines).toEqual([
			expect.objectContaining({
				stock_item_id: "si-serial",
				qty_to_restock: 3,
				serial_unit_ids: undefined,
				batch_picks: undefined,
			}),
		]);
	});

	test("submitting with a partial selection (fewer than qtyToRestock) omits serial_unit_ids entirely", async () => {
		// Finding 1: the backend's applySerialMovement requires unitIds.length to
		// exactly equal the movement qty, or it throws and aborts the whole
		// transaction (all lines) — a short array is NOT treated as "partial,
		// rest untracked." Only an omitted/empty field takes the safe gap path.
		renderWorkflow([serializedStockItem]);

		// The candidate list is collapsed on restock rows — open it before picking.
		await userEvent.click(await screen.findByText("Browse"));
		await userEvent.click(screen.getByLabelText("Select unit SN-A"));
		await userEvent.click(screen.getByLabelText("Select unit SN-B"));
		// 2 of 3 selected — qtyToRestock is 3, so this is a short (partial) capture.

		await userEvent.click(screen.getByText("Apply Restock"));
		await userEvent.click(await screen.findByText("Confirm & Apply"));

		expect(mockCompleteMutate).toHaveBeenCalledTimes(1);
		const [input] = mockCompleteMutate.mock.calls[0];
		expect(input.restock_lines).toEqual([
			expect.objectContaining({
				stock_item_id: "si-serial",
				qty_to_restock: 3,
				serial_unit_ids: undefined,
				batch_picks: undefined,
			}),
		]);
	});

	test("submitting with an exact-match selection (all qtyToRestock units) includes the full serial_unit_ids array", async () => {
		renderWorkflow([serializedStockItem]);

		// The candidate list is collapsed on restock rows — open it before picking.
		await userEvent.click(await screen.findByText("Browse"));
		await userEvent.click(screen.getByLabelText("Select unit SN-A"));
		await userEvent.click(screen.getByLabelText("Select unit SN-B"));
		await userEvent.click(screen.getByLabelText("Select unit SN-C"));
		// All 3 of 3 selected — qtyToRestock is 3, so this exactly matches.

		await userEvent.click(screen.getByText("Apply Restock"));
		await userEvent.click(await screen.findByText("Confirm & Apply"));

		expect(mockCompleteMutate).toHaveBeenCalledTimes(1);
		const [input] = mockCompleteMutate.mock.calls[0];
		expect(input.restock_lines).toEqual([
			expect.objectContaining({
				stock_item_id: "si-serial",
				qty_to_restock: 3,
				serial_unit_ids: ["su1", "su2", "su3"],
			}),
		]);
	});

	test("a line with a known client-side warehouse shortfall never sends serial_unit_ids, even when fully selected", async () => {
		// Finding 2: the backend caps qty_restocked at its own fresh-locked
		// warehouse availability, not the client's qtyToRestock, so an exact
		// client-side capture can still mismatch the server's capped `actual`.
		// When the client already knows (from its own last-known warehouse qty)
		// that this line will be capped, tracking fields are suppressed
		// proactively rather than risking a mismatch.
		renderWorkflow([shortSerializedStockItem]);

		// The candidate list is collapsed on restock rows — open it before picking.
		await userEvent.click(await screen.findByText("Browse"));
		await userEvent.click(screen.getByLabelText("Select unit SN-A"));
		await userEvent.click(screen.getByLabelText("Select unit SN-B"));
		await userEvent.click(screen.getByLabelText("Select unit SN-C"));
		// All 3 available units selected, matching this line's qtyToRestock (3) —
		// a "complete" capture that would otherwise pass Finding 1's exact-match
		// check, but the warehouse (quantity: 2) is already known to be short.

		await userEvent.click(screen.getByText("Apply Restock"));
		await userEvent.click(await screen.findByText("Confirm & Apply"));

		expect(mockCompleteMutate).toHaveBeenCalledTimes(1);
		const [input] = mockCompleteMutate.mock.calls[0];
		expect(input.restock_lines).toEqual([
			expect.objectContaining({
				stock_item_id: "si-serial-short",
				qty_to_restock: 3,
				serial_unit_ids: undefined,
				batch_picks: undefined,
			}),
		]);
	});

	test("a dimmed already-met tracked row (serialized or batch) never shows tracking UI", () => {
		// Both lines are "already met" (qtyToRestock === 0) despite being
		// trackable items — showTracking requires qtyToRestock > 0, so neither
		// picker should render for either row.
		renderWorkflow([metSerializedStockItem, metBatchStockItem]);

		expect(screen.queryByText("Select existing units")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Batch / lot")).not.toBeInTheDocument();
	});

	test("submitting with a batch selected includes batch_picks summed to qty_to_restock", async () => {
		renderWorkflow([batchStockItem]);

		await screen.findByLabelText("Batch / lot");
		await userEvent.selectOptions(screen.getByLabelText("Batch / lot"), "batch1");

		await userEvent.click(screen.getByText("Apply Restock"));
		await userEvent.click(await screen.findByText("Confirm & Apply"));

		expect(mockCompleteMutate).toHaveBeenCalledTimes(1);
		const [input] = mockCompleteMutate.mock.calls[0];
		expect(input.restock_lines).toEqual([
			expect.objectContaining({
				stock_item_id: "si-batch",
				qty_to_restock: 3,
				batch_picks: [{ batch_id: "batch1", qty: 3 }],
			}),
		]);
	});
});
