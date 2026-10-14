import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi, beforeEach } from "vitest";
import PartsUsedSection from "./PartsUsedSection";
import type { VehicleStockItem } from "../../types/vehicles";
import type { VisitLineItem } from "../../types/jobs";

const mockAddPartsMutateAsync = vi.fn();
const mockUpdatePartsQtyMutateAsync = vi.fn();
const mockUpdateVisitMutateAsync = vi.fn();
const mockStockItems = vi.fn<() => VehicleStockItem[]>();
vi.mock("../../hooks/useVehicleStock", () => ({
	useVehicleStockQuery: () => ({ data: mockStockItems() }),
	useAddPartsUsedMutation: () => ({ mutateAsync: mockAddPartsMutateAsync, isPending: false }),
	useUpdatePartsUsedQtyMutation: () => ({
		mutateAsync: mockUpdatePartsQtyMutateAsync,
		isPending: false,
	}),
}));

vi.mock("../../hooks/useJobs", () => ({
	useUpdateJobVisitMutation: () => ({ mutateAsync: mockUpdateVisitMutateAsync, isPending: false }),
}));

vi.mock("../../hooks/useTechnicians", () => ({
	useTechnicianByIdQuery: () => ({ data: { id: "tech-1", current_vehicle_id: "veh-1" } }),
}));

vi.mock("../../auth/authStore", () => ({
	useAuthStore: (selector?: (s: { user: unknown }) => unknown) => {
		const state = {
			user: { userId: "tech-1", role: "technician", permissions: ["use_inventory"] },
		};
		return selector ? selector(state) : state;
	},
}));

const mockSerialsQuery = vi.fn();
const mockBatchesQuery = vi.fn();
const mockResolveMutateAsync = vi.fn();
vi.mock("../../hooks/useTracking", () => ({
	useSerialsQuery: (...args: unknown[]) => mockSerialsQuery(...args),
	useBatchesQuery: (...args: unknown[]) => mockBatchesQuery(...args),
	useResolveCodeMutation: () => ({ mutateAsync: mockResolveMutateAsync, isPending: false }),
}));

// Camera scanning depends on getUserMedia/BarcodeDetector, unavailable in jsdom.
vi.mock("../inventory/BarcodeScanner", () => ({
	BarcodeScanner: () => null,
}));

function renderSection(lineItems: VisitLineItem[] = []) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<PartsUsedSection visitId="visit-1" lineItems={lineItems} />
		</QueryClientProvider>,
	);
}

async function openStockPickerAndSelect(itemLabel: string) {
	await userEvent.click(screen.getByText("Add / Edit Parts"));
	await userEvent.click(screen.getByText("Vehicle Stock"));
	await userEvent.click(screen.getByText(itemLabel).closest("div")!.parentElement!.querySelector("button")!);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUpdatePartsQtyMutateAsync.mockResolvedValue(null);
	mockUpdateVisitMutateAsync.mockResolvedValue({});
	mockStockItems.mockReturnValue([]);
	mockSerialsQuery.mockReturnValue({ data: { serials: [], nextCursor: null }, isLoading: false });
	mockBatchesQuery.mockReturnValue({ data: { batches: [] }, isLoading: false });
	mockResolveMutateAsync.mockRejectedValue(new Error("No match found"));
	mockAddPartsMutateAsync.mockResolvedValue({});
});

const serializedStockItem: VehicleStockItem = {
	id: "si-serial",
	vehicle_id: "veh-1",
	inventory_item_id: "inv-serial",
	inventory_item: {
		id: "inv-serial",
		name: "Compressor",
		category: null,
		unit: "unit",
		is_serialized: true,
		is_batch_tracked: false,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 5,
	qty_min: 1,
	qty_standard: null,
	updated_at: "",
	created_at: "",
};

const batchStockItem: VehicleStockItem = {
	id: "si-batch",
	vehicle_id: "veh-1",
	inventory_item_id: "inv-batch",
	inventory_item: {
		id: "inv-batch",
		name: "Refrigerant Jug",
		category: null,
		unit: "jug",
		is_serialized: false,
		is_batch_tracked: true,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 8,
	qty_min: 1,
	qty_standard: null,
	updated_at: "",
	created_at: "",
};

const plainStockItem: VehicleStockItem = {
	id: "si-plain",
	vehicle_id: "veh-1",
	inventory_item_id: "inv-plain",
	inventory_item: {
		id: "inv-plain",
		name: "Zip Ties",
		category: null,
		unit: "ea",
		is_serialized: false,
		is_batch_tracked: false,
	} as unknown as VehicleStockItem["inventory_item"],
	qty_on_hand: 10,
	qty_min: 1,
	qty_standard: null,
	updated_at: "",
	created_at: "",
};

describe("PartsUsedSection — serialized stock item", () => {
	test("requires exact unit count before enabling Add Part, then submits serial_unit_ids", async () => {
		mockStockItems.mockReturnValue([serializedStockItem]);
		mockSerialsQuery.mockReturnValue({
			data: {
				serials: [
					{ id: "su1", serial_number: "SN-A", status: "on_vehicle" },
					{ id: "su2", serial_number: "SN-B", status: "on_vehicle" },
				],
				nextCursor: null,
			},
			isLoading: false,
		});

		renderSection();
		await openStockPickerAndSelect("Compressor");

		expect(screen.getByText("Select existing units")).toBeInTheDocument();
		expect(mockSerialsQuery).toHaveBeenCalledWith("inv-serial", { status: "on_vehicle", vehicleId: "veh-1" });
		expect(screen.getByText("0 / 1 selected")).toBeInTheDocument();
		expect(screen.getByText("Add Part").closest("button")).toBeDisabled();

		await userEvent.click(screen.getByLabelText("Select unit SN-A"));
		expect(screen.getByText("1 / 1 selected")).toBeInTheDocument();
		expect(screen.getByText("Add Part").closest("button")).not.toBeDisabled();

		await userEvent.click(screen.getByText("Add Part"));

		await waitFor(() => expect(mockAddPartsMutateAsync).toHaveBeenCalled());
		const submitted = mockAddPartsMutateAsync.mock.calls[0][0];
		expect(submitted).toEqual({
			visitId: "visit-1",
			vehicleId: "veh-1",
			data: {
				stock_item_id: "si-serial",
				qty_used: 1,
				technician_id: "tech-1",
				serial_unit_ids: ["su1"],
			},
		});
	});

	test("bumping the target count requires more units without clearing the existing selection", async () => {
		mockStockItems.mockReturnValue([serializedStockItem]);
		mockSerialsQuery.mockReturnValue({
			data: {
				serials: [
					{ id: "su1", serial_number: "SN-A", status: "on_vehicle" },
					{ id: "su2", serial_number: "SN-B", status: "on_vehicle" },
				],
				nextCursor: null,
			},
			isLoading: false,
		});

		renderSection();
		await openStockPickerAndSelect("Compressor");

		await userEvent.click(screen.getByLabelText("Select unit SN-A"));
		expect(screen.getByText("1 / 1 selected")).toBeInTheDocument();

		await userEvent.click(screen.getByLabelText("Increase units to use"));
		// Previously selected unit stays checked — count target grows, selection doesn't reset.
		expect(screen.getByText("1 / 2 selected")).toBeInTheDocument();
		expect(screen.getByText("Add Part").closest("button")).toBeDisabled();

		await userEvent.click(screen.getByLabelText("Select unit SN-B"));
		expect(screen.getByText("2 / 2 selected")).toBeInTheDocument();
		expect(screen.getByText("Add Part").closest("button")).not.toBeDisabled();

		await userEvent.click(screen.getByText("Add Part"));
		await waitFor(() => expect(mockAddPartsMutateAsync).toHaveBeenCalled());
		const submitted = mockAddPartsMutateAsync.mock.calls[0][0];
		expect(submitted.data).toEqual(
			expect.objectContaining({ qty_used: 2, serial_unit_ids: ["su1", "su2"] }),
		);
	});
});

describe("PartsUsedSection — batch-tracked stock item", () => {
	test("FIFO default (no lot picked) submits without batch_id", async () => {
		mockStockItems.mockReturnValue([batchStockItem]);
		mockBatchesQuery.mockReturnValue({
			data: {
				batches: [
					{
						id: "batch-1",
						code: "C1",
						batch_number: "LOT-2026-01",
						expires_at: null,
						supplier: null,
						recalled_at: null,
						qty_received: 10,
						qty_in_warehouse: 0,
						vehicles: [{ vehicle_id: "veh-1", vehicle_name: "Truck 1", qty_on_hand: 8 }],
					},
				],
			},
			isLoading: false,
		});

		renderSection();
		await openStockPickerAndSelect("Refrigerant Jug");

		const batchSelect = await screen.findByLabelText("Batch / lot");
		expect(batchSelect).toHaveValue("");

		const qtyInput = screen.getByDisplayValue("1");
		fireEvent.change(qtyInput, { target: { value: "3" } });

		await userEvent.click(screen.getByText("Add Part"));

		await waitFor(() => expect(mockAddPartsMutateAsync).toHaveBeenCalled());
		const submitted = mockAddPartsMutateAsync.mock.calls[0][0];
		expect(submitted.data).not.toHaveProperty("batch_id");
		expect(submitted.data).toEqual({
			stock_item_id: "si-batch",
			qty_used: 3,
			technician_id: "tech-1",
		});
	});

	test("selecting an explicit lot submits its batch_id", async () => {
		mockStockItems.mockReturnValue([batchStockItem]);
		mockBatchesQuery.mockReturnValue({
			data: {
				batches: [
					{
						id: "batch-1",
						code: "C1",
						batch_number: "LOT-2026-01",
						expires_at: null,
						supplier: null,
						recalled_at: null,
						qty_received: 10,
						qty_in_warehouse: 0,
						vehicles: [{ vehicle_id: "veh-1", vehicle_name: "Truck 1", qty_on_hand: 8 }],
					},
				],
			},
			isLoading: false,
		});

		renderSection();
		await openStockPickerAndSelect("Refrigerant Jug");

		const batchSelect = await screen.findByLabelText("Batch / lot");
		await userEvent.selectOptions(batchSelect, "batch-1");

		await userEvent.click(screen.getByText("Add Part"));

		await waitFor(() => expect(mockAddPartsMutateAsync).toHaveBeenCalled());
		const submitted = mockAddPartsMutateAsync.mock.calls[0][0];
		expect(submitted.data).toEqual({
			stock_item_id: "si-batch",
			qty_used: 1,
			technician_id: "tech-1",
			batch_id: "batch-1",
		});
	});
});

describe("PartsUsedSection — plain (non-tracked) stock item", () => {
	test("keeps the original numeric-qty-only flow, with neither serial_unit_ids nor batch_id", async () => {
		mockStockItems.mockReturnValue([plainStockItem]);

		renderSection();
		await openStockPickerAndSelect("Zip Ties");

		expect(screen.queryByText("Select existing units")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Batch / lot")).not.toBeInTheDocument();

		const qtyInput = screen.getByDisplayValue("1");
		fireEvent.change(qtyInput, { target: { value: "4" } });

		await userEvent.click(screen.getByText("Add Part"));

		await waitFor(() => expect(mockAddPartsMutateAsync).toHaveBeenCalled());
		const submitted = mockAddPartsMutateAsync.mock.calls[0][0];
		expect(submitted).toEqual({
			visitId: "visit-1",
			vehicleId: "veh-1",
			data: {
				stock_item_id: "si-plain",
				qty_used: 4,
				technician_id: "tech-1",
			},
		});
	});

	test("still blocks submission when the requested qty exceeds qty on hand", async () => {
		mockStockItems.mockReturnValue([plainStockItem]);

		renderSection();
		await openStockPickerAndSelect("Zip Ties");

		const qtyInput = screen.getByDisplayValue("1");
		fireEvent.change(qtyInput, { target: { value: "99" } });

		await userEvent.click(screen.getByText("Add Part"));

		expect(await screen.findByText("Not enough stock on hand.")).toBeInTheDocument();
		expect(mockAddPartsMutateAsync).not.toHaveBeenCalled();
	});
});

// The ledger stores two decimals and the server's z.number().positive() would
// silently round 2.505 — catch it client-side, and send a clean 2.5 as a number.
describe("PartsUsedSection — fractional qty_used", () => {
	test("sends 2.5 as a number for a non-serialized stock item", async () => {
		mockStockItems.mockReturnValue([plainStockItem]);

		renderSection();
		await openStockPickerAndSelect("Zip Ties");

		const qtyInput = screen.getByDisplayValue("1");
		expect(qtyInput).toHaveAttribute("step", "0.01");
		fireEvent.change(qtyInput, { target: { value: "2.5" } });
		await userEvent.click(screen.getByText("Add Part"));

		await waitFor(() => expect(mockAddPartsMutateAsync).toHaveBeenCalled());
		expect(mockAddPartsMutateAsync.mock.calls[0][0].data.qty_used).toBe(2.5);
	});

	test("rejects 2.505 with an inline error and sends nothing", async () => {
		mockStockItems.mockReturnValue([plainStockItem]);

		renderSection();
		await openStockPickerAndSelect("Zip Ties");

		fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "2.505" } });
		await userEvent.click(screen.getByText("Add Part"));

		expect(await screen.findByText("Quantity must be to two decimal places.")).toBeInTheDocument();
		expect(mockAddPartsMutateAsync).not.toHaveBeenCalled();
	});
});

// handleQtyChange routes a change by what the line IS: a stock-linked line that
// was actually used carries a serial/batch ledger and goes through the dedicated
// parts-used-qty endpoint (so a decrease releases the exact units back to the
// van); anything else is a plain line-item rewrite on the visit.
describe("PartsUsedSection — Edit Parts quantity routing", () => {
	const usedStockLine: VisitLineItem = {
		id: "li-stock",
		name: "Zip Ties",
		quantity: 3,
		unit_price: 1.5,
		total: 4.5,
		inventory_item_id: "inv-plain",
		fulfillment_status: "used",
		source: "vehicle_stock" as VisitLineItem["source"],
		taxable: false,
		tax_group_id: null,
		tax_amount: null,
	};
	const supplierLine: VisitLineItem = {
		id: "li-supplier",
		name: "Copper fitting",
		quantity: 2,
		unit_price: 3.333,
		total: 6.67,
		inventory_item_id: null,
		fulfillment_status: null,
		source: "manual" as VisitLineItem["source"],
		taxable: false,
		tax_group_id: null,
		tax_amount: null,
	};

	async function openEditTab(lineItems: VisitLineItem[]) {
		renderSection(lineItems);
		await userEvent.click(screen.getByText("Add / Edit Parts"));
		// "Edit Parts" is the default tab.
	}

	test("a used stock-linked line goes through the parts-used-qty endpoint, not the visit update", async () => {
		await openEditTab([usedStockLine]);

		await userEvent.click(screen.getByLabelText("Increase quantity"));

		await waitFor(() => expect(mockUpdatePartsQtyMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockUpdatePartsQtyMutateAsync).toHaveBeenCalledWith({
			visitId: "visit-1",
			lineItemId: "li-stock",
			vehicleId: "veh-1",
			data: { technician_id: "tech-1", quantity: 4 },
		});
		expect(mockUpdateVisitMutateAsync).not.toHaveBeenCalled();
	});

	test("a non-stock line rewrites the visit's line items with the total recomputed to 2 dp", async () => {
		await openEditTab([supplierLine]);

		await userEvent.click(screen.getByLabelText("Increase quantity"));

		await waitFor(() => expect(mockUpdateVisitMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockUpdatePartsQtyMutateAsync).not.toHaveBeenCalled();
		const { id, data } = mockUpdateVisitMutateAsync.mock.calls[0][0];
		expect(id).toBe("visit-1");
		expect(data.line_items).toEqual([
			expect.objectContaining({
				id: "li-supplier",
				quantity: 3,
				unit_price: 3.333,
				// 3 × 3.333 = 9.999 → 10.00
				total: 10,
			}),
		]);
	});

	test("decreasing a non-stock line to zero removes it from the visit", async () => {
		await openEditTab([{ ...supplierLine, quantity: 1, total: 3.33 }]);

		// qty 1 shows a remove control that arms on first click and fires on the second.
		const remove = screen.getByLabelText("Remove part");
		await userEvent.click(remove);
		await userEvent.click(remove);

		await waitFor(() => expect(mockUpdateVisitMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockUpdateVisitMutateAsync.mock.calls[0][0].data.line_items).toEqual([]);
		expect(mockUpdatePartsQtyMutateAsync).not.toHaveBeenCalled();
	});

	test("decreasing a used stock-linked line to zero sends quantity 0 to the parts-used-qty endpoint", async () => {
		await openEditTab([{ ...usedStockLine, quantity: 1, total: 1.5 }]);

		const remove = screen.getByLabelText("Remove part");
		await userEvent.click(remove);
		await userEvent.click(remove);

		await waitFor(() => expect(mockUpdatePartsQtyMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockUpdatePartsQtyMutateAsync.mock.calls[0][0].data).toEqual({
			technician_id: "tech-1",
			quantity: 0,
		});
		expect(mockUpdateVisitMutateAsync).not.toHaveBeenCalled();
	});
});
