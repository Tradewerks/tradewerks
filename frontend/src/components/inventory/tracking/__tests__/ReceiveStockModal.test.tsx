import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReceiveStockModal from "../ReceiveStockModal";
import type { BatchCaptureFieldsProps } from "../BatchCaptureFields";
import type { SerialCaptureListProps } from "../SerialCaptureList";

// The quantity input has no min/step clamp: the ledger stores 2 dp, so a
// batch-tracked measured item (ft, lb, gal …) must be able to receive a
// fractional quantity. Serialized items stay whole — a serial is one
// indivisible unit.

const mockReceive = vi.fn();
vi.mock("../../../../hooks/useTracking", () => ({
	useReceiveInventoryMutation: () => ({ mutateAsync: mockReceive, isPending: false }),
}));

// The modal now always renders SupplierPicker, which reads through react-query —
// mocked (not just wrapped) so these quantity-precision tests don't also make a
// real network call.
vi.mock("../../../../api/suppliers", () => ({
	getSuppliers: vi.fn().mockResolvedValue([]),
}));

function wrap(ui: React.ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const providers = (el: React.ReactElement) => (
		<QueryClientProvider client={qc}>{el}</QueryClientProvider>
	);
	const view = render(providers(ui));
	return { ...view, rerender: (el: React.ReactElement) => view.rerender(providers(el)) };
}

const mockToast = { success: vi.fn(), error: vi.fn() };
vi.mock("../../../ui/useToast", () => ({
	useToast: () => mockToast,
}));

vi.mock("../../../../stores/labelQueueStore", () => ({
	useLabelQueueStore: (selector: (s: { add: () => void }) => unknown) =>
		selector({ add: vi.fn() }),
}));

// The capture sub-forms have their own suites; stand-ins let a test commit a
// value without debounce timers or a resolve-code network mock.
vi.mock("../BatchCaptureFields", () => ({
	default: ({ onChange }: BatchCaptureFieldsProps) => (
		<button
			type="button"
			onClick={() =>
				onChange({ mode: "new", batch_number: "LOT-1", expires_at: null })
			}
		>
			Fill Batch
		</button>
	),
}));
vi.mock("../SerialCaptureList", () => ({
	default: ({ targetCount, onChange }: SerialCaptureListProps) => (
		<div data-testid="serial-capture" data-target={targetCount}>
			<button
				type="button"
				onClick={() => onChange(Array.from({ length: targetCount }, (_, i) => `SN-${i + 1}`))}
			>
				Fill Serials
			</button>
		</div>
	),
}));

const batchItem = { id: "item-b", name: "Line Set", is_serialized: false, is_batch_tracked: true };
const serialItem = { id: "item-s", name: "Compressor", is_serialized: true, is_batch_tracked: false };

beforeEach(() => {
	vi.clearAllMocks();
	mockReceive.mockResolvedValue({ item: {}, created_serials: [], batch: null });
});

async function setQty(value: string) {
	const input = screen.getByLabelText("Quantity");
	await userEvent.clear(input);
	if (value !== "") await userEvent.type(input, value);
}

describe("ReceiveStockModal — fractional quantity", () => {
	it("offers a 0.01 step for a batch-tracked item and a whole-unit step for a serialized one", () => {
		const { rerender } = wrap(<ReceiveStockModal isOpen onClose={vi.fn()} item={batchItem} />);
		expect(screen.getByLabelText("Quantity")).toHaveAttribute("step", "0.01");
		expect(screen.getByLabelText("Quantity")).toHaveAttribute("min", "0.01");

		rerender(<ReceiveStockModal isOpen onClose={vi.fn()} item={serialItem} />);
		expect(screen.getByLabelText("Quantity")).toHaveAttribute("step", "1");
		expect(screen.getByLabelText("Quantity")).toHaveAttribute("min", "1");
	});

	it("accepts 12.5 for a batch-tracked item and sends it as a number", async () => {
		const onClose = vi.fn();
		wrap(<ReceiveStockModal isOpen onClose={onClose} item={batchItem} />);

		await setQty("12.5");
		await userEvent.click(screen.getByRole("button", { name: "Fill Batch" }));
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));

		await waitFor(() => expect(mockReceive).toHaveBeenCalledTimes(1));
		expect(mockReceive).toHaveBeenCalledWith({
			qty: 12.5,
			batch: { batch_number: "LOT-1", expires_at: null, supplier: undefined },
		});
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it("accepts a quantity below 1 (0.5) instead of snapping it up to 1", async () => {
		wrap(<ReceiveStockModal isOpen onClose={vi.fn()} item={batchItem} />);

		await setQty("0.5");
		expect(screen.getByLabelText("Quantity")).toHaveValue(0.5);
		await userEvent.click(screen.getByRole("button", { name: "Fill Batch" }));
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));

		await waitFor(() => expect(mockReceive).toHaveBeenCalledTimes(1));
		expect(mockReceive.mock.calls[0][0].qty).toBe(0.5);
	});

	it("rejects a blank or non-positive quantity with 'greater than 0'", async () => {
		wrap(<ReceiveStockModal isOpen onClose={vi.fn()} item={batchItem} />);

		await setQty("");
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));
		expect(screen.getByText("Quantity must be greater than 0.")).toBeInTheDocument();

		await setQty("0");
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));
		expect(screen.getByText("Quantity must be greater than 0.")).toBeInTheDocument();
		expect(mockReceive).not.toHaveBeenCalled();
	});

	it("rejects more than two decimal places (the numeric(10,2) bound)", async () => {
		wrap(<ReceiveStockModal isOpen onClose={vi.fn()} item={batchItem} />);

		await setQty("2.505");
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));
		expect(screen.getByText("Quantity must be to two decimal places.")).toBeInTheDocument();
		expect(mockReceive).not.toHaveBeenCalled();
	});

	it("rejects 2.5 for a serialized item — a serial is one whole unit", async () => {
		wrap(<ReceiveStockModal isOpen onClose={vi.fn()} item={serialItem} />);

		await setQty("2.5");
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));
		expect(
			screen.getByText("Quantity must be a whole number of units for a serialized item."),
		).toBeInTheDocument();
		expect(mockReceive).not.toHaveBeenCalled();
	});

	it("still receives whole serialized units with their serial numbers", async () => {
		wrap(<ReceiveStockModal isOpen onClose={vi.fn()} item={serialItem} />);

		await setQty("2");
		expect(screen.getByTestId("serial-capture")).toHaveAttribute("data-target", "2");
		await userEvent.click(screen.getByRole("button", { name: "Fill Serials" }));
		await userEvent.click(screen.getByRole("button", { name: "Receive Stock" }));

		await waitFor(() => expect(mockReceive).toHaveBeenCalledTimes(1));
		expect(mockReceive).toHaveBeenCalledWith({ qty: 2, serial_numbers: ["SN-1", "SN-2"] });
	});
});
