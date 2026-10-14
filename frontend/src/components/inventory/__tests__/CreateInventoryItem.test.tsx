import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../../test/testUtils";
import CreateInventoryItem from "../CreateInventoryItem";
import type { InventoryItem } from "../../../types/inventory";
import type { ReceiveInventoryResponse } from "../../../types/tracking";
import type { SerialCaptureListProps } from "../tracking/SerialCaptureList";
import type { BatchCaptureFieldsProps } from "../tracking/BatchCaptureFields";

// ── Mocks ────────────────────────────────────────────────────────────────
// This suite exercises CreateInventoryItem's own orchestration (tracking
// toggle, wizard restructuring, deferred create/receive at Submit, label
// queueing). SerialCaptureList / BatchCaptureFields are already covered by
// their own test suites — here they're replaced with trivial stand-ins that
// let a test commit a capture value without dealing with debounce timers,
// scanner mounts, or a real /resolve-code network mock.

const mockCreateMutateAsync = vi.fn();
const mockUpdateMutateAsync = vi.fn();
const mockUploadMutateAsync = vi.fn();
const mockSetTagsMutateAsync = vi.fn();

vi.mock("../../../hooks/useInventory", () => ({
	useCreateInventoryItemMutation: () => ({ mutateAsync: mockCreateMutateAsync, isPending: false }),
	useUpdateInventoryItemMutation: () => ({ mutateAsync: mockUpdateMutateAsync, isPending: false }),
	useUploadInventoryImageMutation: () => ({ mutateAsync: mockUploadMutateAsync, isPending: false }),
	useInventoryTagsQuery: () => ({ data: [] }),
	useSetItemTagsMutation: () => ({ mutateAsync: mockSetTagsMutateAsync, isPending: false }),
}));

const mockEnsureCodeMutateAsync = vi.fn();
const mockTrackingMutateAsync = vi.fn();
// Returns the useTrackingEligibilityQuery result; default (beforeEach) is
// undefined, so the form falls back to its warehouse-quantity proxy.
const mockEligibilityQuery = vi.fn();

vi.mock("../../../hooks/useTracking", () => ({
	useEnsureItemCodeMutation: () => ({ mutateAsync: mockEnsureCodeMutateAsync, isPending: false }),
	useUpdateItemTrackingMutation: () => ({ mutateAsync: mockTrackingMutateAsync, isPending: false }),
	useTrackingEligibilityQuery: () => mockEligibilityQuery(),
}));

function eligibility(overrides: Record<string, unknown> = {}) {
	return {
		data: {
			provisional: false,
			is_serialized: false,
			is_batch_tracked: false,
			qty_warehouse: 0,
			qty_on_vehicles: 0,
			vehicle_count: 0,
			live_serials: 0,
			live_lots: 0,
			history_serials: 0,
			history_lots: 0,
			can_enable: true,
			can_disable: true,
			blockers: [] as string[],
			...overrides,
		},
		isLoading: false,
	};
}

// Receive is now a direct api call fired at Submit (not a hook bound to a
// pre-existing itemId), so it's mocked at the api layer.
const mockReceiveInventory = vi.fn();

vi.mock("../../../api/tracking", () => ({
	receiveInventory: (itemId: string, input: unknown) => mockReceiveInventory(itemId, input),
}));

// The component invalidates the warehouse tree after a receive — no-op it so
// the test doesn't depend on real query invalidation.
vi.mock("../../../lib/queryKeys", () => ({
	invalidate: { warehouse: vi.fn() },
}));

// UnitSelect reads the org's measurement system to ORDER the picker (nothing
// is hidden), so an unmocked hook here meant a real GET /org per render.
vi.mock("../../../hooks/useOrg", () => ({
	useOrgSettings: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: false } }),
	useQBItemsQuery: () => ({ data: [], isLoading: false }),
	useQBMappedItemsQuery: () => ({ data: [] }),
	useImportQBItemMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const mockAddToLabelQueue = vi.fn();

vi.mock("../../../stores/labelQueueStore", () => ({
	useLabelQueueStore: (selector: (s: { add: typeof mockAddToLabelQueue }) => unknown) =>
		selector({ add: mockAddToLabelQueue }),
}));

vi.mock("../tracking/SerialCaptureList", () => ({
	default: ({ itemId, targetCount, value, onChange }: SerialCaptureListProps) => (
		<div data-testid="serial-capture" data-item-id={itemId} data-target={targetCount}>
			<span data-testid="serial-count">{value.length}</span>
			<button
				type="button"
				onClick={() =>
					onChange(Array.from({ length: targetCount }, (_, i) => `SN-${i + 1}`))
				}
			>
				Fill Serials
			</button>
		</div>
	),
}));

// Stubbed for the same reason as the capture components: it fetches the vendor
// list, and the wizard's create/receive payloads are what these tests assert.
vi.mock("../SupplierPicker", () => ({
	default: ({ onChange }: { onChange: (v: { supplier_name?: string }) => void }) => (
		<button type="button" onClick={() => onChange({ supplier_name: "Ferguson" })}>
			Pick Supplier
		</button>
	),
}));

vi.mock("../tracking/BatchCaptureFields", () => ({
	default: ({ itemId, onChange }: BatchCaptureFieldsProps) => (
		<div data-testid="batch-capture" data-item-id={itemId}>
			<button
				type="button"
				onClick={() =>
					onChange({ mode: "new", batch_number: "LOT-1", expires_at: null })
				}
			>
				Fill Batch
			</button>
		</div>
	),
}));

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
	return {
		id: "item-1",
		name: "Widget",
		description: "",
		location: "A1",
		quantity: 0,
		unit_price: null,
		cost: null,
		sku: null,
		barcode: null,
		is_active: true,
		low_stock_threshold: null,
		image_urls: [],
		alert_emails_enabled: false,
		alert_email: null,
		category: null,
		unit: "each",
		is_serialized: false,
		is_batch_tracked: false,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		stock_status: null,
		...overrides,
	};
}

async function fillBasicsAndAdvance(name: string) {
	await userEvent.type(screen.getByPlaceholderText("Item Name"), name);
	await userEvent.type(screen.getByPlaceholderText("e.g. A42 - 325"), "A1-100");
	await userEvent.click(screen.getByRole("button", { name: "Next" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockEligibilityQuery.mockReturnValue({ data: undefined, isLoading: false });
});

// Blank required fields must be caught before Submit, not surfaced as a server error.
describe("step gating", () => {
	it("keeps an invalid step 1 on step 1 and says what's missing", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);

		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(screen.getByText("Name is required.")).toBeInTheDocument();
		// Location is optional — an item can exist before it has a shelf.
		expect(screen.queryByText("Location is required.")).not.toBeInTheDocument();
		// Still on Basics — step 2's Quantity never mounted.
		expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText("Item Name")).toHaveAttribute("aria-invalid", "true");
	});

	it("advances once the step 1 errors are fixed, with no location", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);

		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.type(screen.getByPlaceholderText("Item Name"), "Widget");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(await screen.findByLabelText("Quantity")).toBeInTheDocument();
	});

	// The gate is not step-1-only: step 2's own conditional requirement blocks
	// the same way, on the step that owns the field.
	it("blocks step 2 when email alerts are on with no address", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Widget");

		// Switch order on this step: serial, batch, low-stock, then email alerts
		// once low-stock is on.
		await userEvent.click(screen.getAllByRole("switch")[2]);
		await userEvent.click(screen.getAllByRole("switch")[3]);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(
			screen.getByText("Alert email is required while email alerts are on."),
		).toBeInTheDocument();
		// Still on Stock & Pricing.
		expect(screen.getByLabelText("Quantity")).toBeInTheDocument();

		await userEvent.type(screen.getByPlaceholderText("alerts@company.com"), "not-an-email");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();

		await userEvent.clear(screen.getByPlaceholderText("alerts@company.com"));
		await userEvent.type(screen.getByPlaceholderText("alerts@company.com"), "ops@co.com");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText(/Drop images here/)).toBeInTheDocument();
	});

	// Server caps (name/location 255, sku/category 100, barcode 200, description
	// 5000) must be caught here, not as a raw Zod message at Save.
	it("catches an over-long name on the step that owns it, before any write", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);

		const nameInput = screen.getByPlaceholderText("Item Name");
		await userEvent.type(screen.getByPlaceholderText("e.g. A42 - 325"), "A1-100");
		// paste, not type: 256 keystrokes is a slow test for no extra coverage.
		await userEvent.click(nameInput);
		await userEvent.paste("x".repeat(256));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(
			screen.getByText("Name must be 255 characters or fewer — currently 256."),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();

		// 255 is accepted — the cap is inclusive, matching z.string().max(255).
		await userEvent.clear(nameInput);
		await userEvent.click(nameInput);
		await userEvent.paste("x".repeat(255));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(await screen.findByLabelText("Quantity")).toBeInTheDocument();
	});

	// A cleared Name must not ride all the way to Save Changes and fail server-side.
	it("holds an edit on the step whose required field was cleared", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={makeItem()} />);

		await userEvent.clear(screen.getByPlaceholderText("Item Name"));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(screen.getByText("Name is required.")).toBeInTheDocument();
		expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
		expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
	});
});

describe("tracked item create — serialized, quantity > 0", () => {
	it("captures serials in the wizard and writes create + receive only on Finish", async () => {
		const onClose = vi.fn();
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-1", name: "Widget", barcode: null }));
		mockEnsureCodeMutateAsync.mockResolvedValue(makeItem({ barcode: "ITM-CODE" }));
		const receiveResult: ReceiveInventoryResponse = {
			item: makeItem({ id: "item-1", quantity: 2, is_serialized: true }),
			created_serials: [
				{ id: "s1", code: "SU-1", serial_number: "SN-1", status: "in_warehouse" },
				{ id: "s2", code: "SU-2", serial_number: "SN-2", status: "in_warehouse" },
			],
		};
		mockReceiveInventory.mockResolvedValue(receiveResult);

		render(<CreateInventoryItem isOpen onClose={onClose} />);

		await fillBasicsAndAdvance("Widget");

		// Step 2 — set quantity, toggle serial tracking on.
		await userEvent.clear(screen.getByLabelText("Quantity"));
		await userEvent.type(screen.getByLabelText("Quantity"), "2");
		await userEvent.click(screen.getByLabelText("Track by serial number"));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		// Step 3 — capture step. Nothing is created yet, and the capture
		// components no longer receive a real itemId (it doesn't exist until
		// Submit).
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();
		const captureEl = await screen.findByTestId("serial-capture");
		expect(captureEl).toHaveAttribute("data-item-id", "");
		expect(captureEl).toHaveAttribute("data-target", "2");

		await userEvent.click(screen.getByRole("button", { name: "Fill Serials" }));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		// Step 4 — images/review. Still no write until the user clicks Finish.
		await screen.findByText(/will be recorded/i);
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();
		expect(mockReceiveInventory).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Finish" }));

		// Finish creates the item (qty 0 + flags) then receives the captured
		// serials as initial stock.
		await waitFor(() => expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockCreateMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Widget",
				quantity: 0,
				is_serialized: true,
				is_batch_tracked: false,
			}),
		);
		expect(mockAddToLabelQueue).toHaveBeenCalledWith(
			expect.objectContaining({ id: "item-1", kind: "item", code: "ITM-CODE" }),
		);

		await waitFor(() => expect(mockReceiveInventory).toHaveBeenCalledTimes(1));
		expect(mockReceiveInventory).toHaveBeenCalledWith("item-1", {
			qty: 2,
			serial_numbers: ["SN-1", "SN-2"],
		});

		expect(mockAddToLabelQueue).toHaveBeenCalledWith(
			expect.objectContaining({ id: "s1", code: "SU-1", kind: "serial", secondaryLabel: "SN-1" }),
		);
		expect(mockAddToLabelQueue).toHaveBeenCalledWith(
			expect.objectContaining({ id: "s2", code: "SU-2", kind: "serial", secondaryLabel: "SN-2" }),
		);

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		// Images attach via the create payload — no follow-up update call.
		expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
	});
});

describe("tracked item create — serialized AND batch-tracked, quantity > 0", () => {
	it("captures both and sends serial_numbers + batch together on Finish", async () => {
		const onClose = vi.fn();
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-1", name: "Dual", barcode: null }));
		mockEnsureCodeMutateAsync.mockResolvedValue(makeItem({ barcode: "ITM-CODE" }));
		const receiveResult: ReceiveInventoryResponse = {
			item: makeItem({ id: "item-1", quantity: 2, is_serialized: true, is_batch_tracked: true }),
			created_serials: [
				{ id: "s1", code: "SU-1", serial_number: "SN-1", status: "in_warehouse" },
				{ id: "s2", code: "SU-2", serial_number: "SN-2", status: "in_warehouse" },
			],
			batch: { id: "b1", code: "LOT-1", batch_number: "LOT-1" },
		};
		mockReceiveInventory.mockResolvedValue(receiveResult);

		render(<CreateInventoryItem isOpen onClose={onClose} />);

		await fillBasicsAndAdvance("Dual");

		await userEvent.clear(screen.getByLabelText("Quantity"));
		await userEvent.type(screen.getByLabelText("Quantity"), "2");
		await userEvent.click(screen.getByLabelText("Track by serial number"));
		await userEvent.click(screen.getByLabelText("Track by batch or lot"));

		// Both toggles stay on — turning batch on no longer clears serial.
		expect(screen.getByLabelText("Track by serial number")).toHaveAttribute("aria-checked", "true");
		expect(screen.getByLabelText("Track by batch or lot")).toHaveAttribute("aria-checked", "true");

		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		// Capture step renders both stand-ins with no real itemId; still no write.
		const serialEl = await screen.findByTestId("serial-capture");
		expect(serialEl).toHaveAttribute("data-item-id", "");
		expect(screen.getByTestId("batch-capture")).toHaveAttribute("data-item-id", "");
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Fill Serials" }));
		await userEvent.click(screen.getByRole("button", { name: "Fill Batch" }));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		await screen.findByText(/will be recorded/i);
		await userEvent.click(screen.getByRole("button", { name: "Finish" }));

		await waitFor(() => expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockCreateMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ quantity: 0, is_serialized: true, is_batch_tracked: true }),
		);

		await waitFor(() => expect(mockReceiveInventory).toHaveBeenCalledTimes(1));
		expect(mockReceiveInventory).toHaveBeenCalledWith("item-1", {
			qty: 2,
			serial_numbers: ["SN-1", "SN-2"],
			batch: { batch_number: "LOT-1", expires_at: null, supplier: undefined },
		});
	});
});

describe("tracked item create — quantity 0", () => {
	it("creates the item with tracking flags in a single call and never calls receive", async () => {
		const onClose = vi.fn();
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-2", name: "Zero Qty", barcode: "BC-1" }));

		render(<CreateInventoryItem isOpen onClose={onClose} />);

		await fillBasicsAndAdvance("Zero Qty");

		// Quantity stays at 0 (default) — just toggle tracking on.
		await userEvent.click(screen.getByLabelText("Track by batch or lot"));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		// Step 3 is the last step here (showCaptureStep is false since qty is 0)
		// — the button reads "Create Item" and calls the plain single-call flow.
		await userEvent.click(screen.getByRole("button", { name: "Create Item" }));

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

		expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
		expect(mockCreateMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Zero Qty", quantity: 0, is_batch_tracked: true }),
		);
		expect(mockReceiveInventory).not.toHaveBeenCalled();
	});
});

// quantity/low_stock_threshold are Decimal(10,2); fractional is fine for
// untracked items, but a serialized item stays whole-number since a serial
// is one indivisible unit and the capture step ties enteredSerials.length === quantity.
describe("fractional quantity + threshold (D1)", () => {
	it("accepts a fractional quantity and sends it unchanged", async () => {
		const onClose = vi.fn();
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-frac", name: "Line Set" }));

		render(<CreateInventoryItem isOpen onClose={onClose} />);
		await fillBasicsAndAdvance("Line Set");

		await userEvent.clear(screen.getByLabelText("Quantity"));
		await userEvent.type(screen.getByLabelText("Quantity"), "12.5");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		await userEvent.click(screen.getByRole("button", { name: "Create Item" }));

		await waitFor(() => expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockCreateMutateAsync.mock.calls[0][0].quantity).toBe(12.5);
	});

	it("rejects a quantity with 3 decimal places", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Line Set");

		await userEvent.clear(screen.getByLabelText("Quantity"));
		await userEvent.type(screen.getByLabelText("Quantity"), "12.505");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(
			screen.getByText("Quantity must be 0 or more, to two decimal places."),
		).toBeInTheDocument();
		// Still on Stock & Pricing — Next did not advance.
		expect(screen.getByLabelText("Quantity")).toBeInTheDocument();
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();
	});

	it("keeps a serialized item's quantity whole-number-only even though fractional is otherwise allowed", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Compressor");

		await userEvent.clear(screen.getByLabelText("Quantity"));
		await userEvent.type(screen.getByLabelText("Quantity"), "2.5");
		await userEvent.click(screen.getByLabelText("Track by serial number"));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(
			screen.getByText("Quantity must be a whole number of 0 or more."),
		).toBeInTheDocument();
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();
	});

	it("accepts a fractional low-stock threshold", async () => {
		const onClose = vi.fn();
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-thresh" }));

		render(<CreateInventoryItem isOpen onClose={onClose} />);
		await fillBasicsAndAdvance("Braze Rod");

		// Switch order: serial, batch, low-stock (see the email-gating test above).
		await userEvent.click(screen.getAllByRole("switch")[2]);
		await userEvent.type(screen.getByPlaceholderText("e.g. 10"), "2.5");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		await userEvent.click(screen.getByRole("button", { name: "Create Item" }));

		await waitFor(() => expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockCreateMutateAsync.mock.calls[0][0].low_stock_threshold).toBe(2.5);
	});

	it("rejects a low-stock threshold with 3 decimal places", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Braze Rod");

		await userEvent.click(screen.getAllByRole("switch")[2]);
		await userEvent.type(screen.getByPlaceholderText("e.g. 10"), "2.505");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(
			screen.getByText("Low-stock threshold must be 0 or more, to two decimal places."),
		).toBeInTheDocument();
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();
	});

	it("rejects a negative low-stock threshold", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Braze Rod");

		await userEvent.click(screen.getAllByRole("switch")[2]);
		await userEvent.type(screen.getByPlaceholderText("e.g. 10"), "-1");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(
			screen.getByText("Low-stock threshold must be 0 or more, to two decimal places."),
		).toBeInTheDocument();
		expect(mockCreateMutateAsync).not.toHaveBeenCalled();
	});
});

describe("non-tracked item create (regression)", () => {
	it("keeps the exact single-call create flow with no tracking flags", async () => {
		const onClose = vi.fn();
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-3", name: "Plain", barcode: "BC-2" }));

		render(<CreateInventoryItem isOpen onClose={onClose} />);

		await fillBasicsAndAdvance("Plain");

		await userEvent.clear(screen.getByLabelText("Quantity"));
		await userEvent.type(screen.getByLabelText("Quantity"), "5");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		await userEvent.click(screen.getByRole("button", { name: "Create Item" }));

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

		expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
		const payload = mockCreateMutateAsync.mock.calls[0][0];
		expect(payload.quantity).toBe(5);
		expect(payload.is_serialized).toBeUndefined();
		expect(payload.is_batch_tracked).toBeUndefined();
		expect(mockReceiveInventory).not.toHaveBeenCalled();

		expect(mockAddToLabelQueue).toHaveBeenCalledWith(
			expect.objectContaining({ id: "item-3", kind: "item", code: "BC-2" }),
		);
	});
});

// Unit is a grouped select over the lib/units catalog, so the form can only
// emit a canonical code.
describe("unit of measure", () => {
	it("defaults to each and sends that code on create", async () => {
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-u1" }));

		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Plain");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Create Item" }));

		await waitFor(() => expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockCreateMutateAsync.mock.calls[0][0].unit).toBe("each");
	});

	it("sends the chosen catalog code, not the label", async () => {
		mockCreateMutateAsync.mockResolvedValue(makeItem({ id: "item-u2" }));

		render(<CreateInventoryItem isOpen onClose={vi.fn()} />);
		await fillBasicsAndAdvance("Line Set");

		await userEvent.selectOptions(screen.getByLabelText("Unit of measure"), "ft");
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Create Item" }));

		await waitFor(() => expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockCreateMutateAsync.mock.calls[0][0].unit).toBe("ft");
	});

	// The Unit field lives on the wizard's second step, so an edit has to advance
	// past Basics (already prefilled) before the select is in the tree.
	async function openUnitStep(item: InventoryItem) {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={item} />);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		return screen.getByLabelText("Unit of measure");
	}

	// Without normalization on load the select would have no matching option and
	// would silently show the first entry instead of the item's real unit.
	it("pre-selects a legacy aliased unit by its canonical code", async () => {
		expect(await openUnitStep(makeItem({ unit: "LBS" }))).toHaveValue("lb");
	});

	// A stored value nothing maps onto is NOT re-read as each (review P2-1): a
	// native select whose value matches no option would display its first
	// option, so the raw unit is shown as-is and the picker only appears on ask.
	it("shows a unit outside the catalog verbatim with a legacy callout instead of the select", async () => {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={makeItem({ unit: "skein" })} />);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));

		expect(screen.queryByLabelText("Unit of measure")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Unit of measure (legacy)")).toHaveTextContent("skein");
		expect(screen.getByText(/Legacy unit “skein” — choose a catalog unit/)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Choose a catalog unit" }));
		expect(screen.getByLabelText("Unit of measure")).toHaveValue("each");
		expect(screen.getByText(/Past movements stay recorded in skein/)).toBeInTheDocument();

		// Escape hatch back to the stored value.
		await userEvent.click(screen.getByRole("button", { name: "Keep “skein”" }));
		expect(screen.queryByLabelText("Unit of measure")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Unit of measure (legacy)")).toHaveTextContent("skein");
	});

	it("groups the options so a long list stays scannable", async () => {
		const select = await openUnitStep(makeItem());
		const groups = select.querySelectorAll("optgroup");
		expect(groups.length).toBeGreaterThan(1);
		expect([...groups].map((g) => g.getAttribute("label"))).toContain("Count");
	});

	// The parenthetical names the word that appears beside a quantity, which the
	// label alone doesn't convey — but for containers it just repeats the label.
	it("shows the rendered word in parentheses only when it adds something", async () => {
		const select = await openUnitStep(makeItem());
		const text = (code: string) =>
			select.querySelector<HTMLOptionElement>(`option[value="${code}"]`)?.textContent;

		expect(text("each")).toBe("Each (units)");
		expect(text("ft")).toBe("Feet (ft)");
		expect(text("sqft")).toBe("Square Feet (sq ft)");

		// Containers: "Boxes (boxes)" would be pure repetition.
		expect(text("box")).toBe("Boxes");
		expect(text("case")).toBe("Cases");
		expect(text("cylinder")).toBe("Cylinders");
	});
});

// The detail page passes the LIVE query result as existingItem, so any refetch
// (tracking flip onSuccess, socket inventory:updated, signed image URLs
// rotating) hands the form a new object for the same item. Seeding must key on
// open + item id, not object identity, or it wipes in-progress edits (review U8).
describe("edit — form seeding", () => {
	it("keeps in-progress edits when the item is refetched as a new object with the same id", async () => {
		const { rerender } = render(
			<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={makeItem()} />,
		);
		const nameInput = screen.getByPlaceholderText("Item Name");
		expect(nameInput).toHaveValue("Widget");

		await userEvent.clear(nameInput);
		await userEvent.type(nameInput, "Widget Renamed");

		// Same content, new identity (updated_at bumped by a refetch).
		rerender(
			<CreateInventoryItem
				isOpen
				onClose={vi.fn()}
				existingItem={makeItem({ updated_at: "2026-01-01T00:00:01.000Z" })}
			/>,
		);
		expect(screen.getByPlaceholderText("Item Name")).toHaveValue("Widget Renamed");
	});

	it("re-seeds when the drawer is pointed at a different item", async () => {
		const { rerender } = render(
			<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={makeItem()} />,
		);
		await userEvent.type(screen.getByPlaceholderText("Item Name"), " X");
		expect(screen.getByPlaceholderText("Item Name")).toHaveValue("Widget X");

		rerender(
			<CreateInventoryItem
				isOpen
				onClose={vi.fn()}
				existingItem={makeItem({ id: "item-2", name: "Gadget" })}
			/>,
		);
		expect(screen.getByPlaceholderText("Item Name")).toHaveValue("Gadget");
	});
});

// `unit` travels in the PATCH only when the user changed it, and a change on an
// item with stock on hand carries the decision-5 acknowledgement (review P2-1).
describe("edit — unit change payload", () => {
	async function saveEdit(item: InventoryItem) {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={item} />);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
	}
	async function finish() {
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1));
		return mockUpdateMutateAsync.mock.calls[0][0].data as Record<string, unknown>;
	}

	beforeEach(() => {
		mockUpdateMutateAsync.mockResolvedValue(makeItem());
		mockSetTagsMutateAsync.mockResolvedValue(undefined);
	});

	it("does not send unit when the user left it alone", async () => {
		await saveEdit(makeItem({ unit: "each" }));
		const data = await finish();
		expect(data).not.toHaveProperty("unit");
		expect(data).not.toHaveProperty("acknowledge_unit_change");
	});

	it("does not rewrite a catalog alias on an unrelated edit", async () => {
		await saveEdit(makeItem({ unit: "LBS" }));
		// Pre-selected by its canonical code, but the stored "LBS" is left alone.
		expect(screen.getByLabelText("Unit of measure")).toHaveValue("lb");
		expect(await finish()).not.toHaveProperty("unit");
	});

	it("does not rewrite a legacy unit on an unrelated edit", async () => {
		await saveEdit(makeItem({ unit: "skein" }));
		expect(screen.getByLabelText("Unit of measure (legacy)")).toHaveTextContent("skein");
		expect(await finish()).not.toHaveProperty("unit");
	});

	it("sends the new unit, without the acknowledgement, when there is no stock on hand", async () => {
		mockEligibilityQuery.mockReturnValue(eligibility({ qty_warehouse: 0, qty_on_vehicles: 0 }));
		await saveEdit(makeItem({ unit: "each", quantity: 0 }));
		await userEvent.selectOptions(screen.getByLabelText("Unit of measure"), "box");
		expect(screen.queryByRole("checkbox", { name: /I understand/ })).not.toBeInTheDocument();

		const data = await finish();
		expect(data.unit).toBe("box");
		expect(data).not.toHaveProperty("acknowledge_unit_change");
	});

	it("asks for, and sends, the acknowledgement when the unit changes on stock on hand", async () => {
		mockEligibilityQuery.mockReturnValue(
			eligibility({ qty_warehouse: 12, qty_on_vehicles: 3, can_enable: false, can_disable: false }),
		);
		await saveEdit(makeItem({ unit: "each", quantity: 12 }));
		await userEvent.selectOptions(screen.getByLabelText("Unit of measure"), "box");

		// Warehouse + vehicles, in the NEW unit's word.
		const ack = screen.getByRole("checkbox", {
			name: "I understand the on-hand quantity (15) will now be read in boxes.",
		});
		expect(ack).not.toBeChecked();

		// Unchecked: the flag is simply absent — the server decides.
		let data = await finish();
		expect(data.unit).toBe("box");
		expect(data).not.toHaveProperty("acknowledge_unit_change");

		mockUpdateMutateAsync.mockClear();
		await userEvent.click(screen.getByRole("button", { name: "Back" }));
		await userEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
		data = await finish();
		expect(data.unit).toBe("box");
		expect(data.acknowledge_unit_change).toBe(true);
	});

	it("renders the server's refusal and offers the checkbox when it saw stock this form didn't", async () => {
		// Eligibility never landed and the warehouse column says 0 — the server
		// still knows about vehicle stock.
		mockEligibilityQuery.mockReturnValue({ data: undefined, isLoading: false });
		mockUpdateMutateAsync.mockRejectedValueOnce(
			new Error(
				"Changing the unit re-denominates 3 units on hand; pass acknowledge_unit_change to confirm",
			),
		);
		await saveEdit(makeItem({ unit: "each", quantity: 0 }));
		await userEvent.selectOptions(screen.getByLabelText("Unit of measure"), "box");
		expect(screen.queryByRole("checkbox", { name: /I understand/ })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		expect(
			await screen.findByText(/re-denominates 3 units on hand; pass acknowledge_unit_change/),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByRole("checkbox", { name: /I understand/ })).toBeInTheDocument();
	});
});

// Covers the form reflecting PATCH /inventory/:id/tracking's gate accurately
// before the user saves, rather than unlocking toggles the server will reject.
describe("edit — tracking gate and callout", () => {
	async function openStockStep(item: InventoryItem) {
		render(<CreateInventoryItem isOpen onClose={vi.fn()} existingItem={item} />);
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
	}

	it("explains why tracking is locked when the item still has stock", async () => {
		mockEligibilityQuery.mockReturnValue(
			eligibility({
				qty_warehouse: 12,
				can_enable: false,
				can_disable: false,
				blockers: ["12 unit(s) on hand (12 in the warehouse, 0 on 0 vehicle(s)) — reduce to zero first"],
			}),
		);

		await openStockStep(makeItem({ quantity: 12 }));

		expect(await screen.findByText(/Tracking can’t be changed yet/)).toBeInTheDocument();
		expect(screen.getByText(/reduce to zero first/)).toBeInTheDocument();
		expect(screen.getByLabelText("Track by serial number")).toBeDisabled();
	});

	it("locks the toggles and names the vehicles when only vehicle stock remains", async () => {
		mockEligibilityQuery.mockReturnValue(
			eligibility({
				qty_warehouse: 0,
				qty_on_vehicles: 3,
				vehicle_count: 2,
				can_enable: false,
				can_disable: false,
				blockers: ["3 unit(s) on hand (0 in the warehouse, 3 on 2 vehicle(s)) — reduce to zero first"],
			}),
		);

		// Warehouse quantity alone is 0; vehicles still hold stock, so the toggles
		// must stay locked.
		await openStockStep(makeItem({ quantity: 0 }));

		expect(await screen.findByText(/Tracking can’t be changed yet/)).toBeInTheDocument();
		expect(screen.getByText(/3 on 2 vehicle\(s\)/)).toBeInTheDocument();
		expect(screen.getByLabelText("Track by serial number")).toBeDisabled();
		expect(screen.getByLabelText("Track by batch or lot")).toBeDisabled();
	});

	it("promises that existing units survive a disable", async () => {
		mockEligibilityQuery.mockReturnValue(
			eligibility({
				is_serialized: true,
				history_serials: 47,
				live_serials: 0,
				can_disable: true,
			}),
		);

		await openStockStep(makeItem({ quantity: 0, is_serialized: true }));

		expect(
			await screen.findByText(/stay on the Tracking tab as read-only history/),
		).toBeInTheDocument();
		expect(screen.getByText(/47 units/)).toBeInTheDocument();
	});

	it("sends the tracking flip before the field update so a rejection writes nothing", async () => {
		mockEligibilityQuery.mockReturnValue(eligibility({ can_enable: true }));
		mockUpdateMutateAsync.mockResolvedValue(makeItem({ is_serialized: true }));
		mockSetTagsMutateAsync.mockResolvedValue(undefined);
		mockTrackingMutateAsync.mockResolvedValue(makeItem({ is_serialized: true }));

		await openStockStep(makeItem({ quantity: 0 }));

		await userEvent.click(screen.getByLabelText("Track by serial number"));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => expect(mockTrackingMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockTrackingMutateAsync).toHaveBeenCalledWith({
			is_serialized: true,
			is_batch_tracked: false,
		});
		await waitFor(() => expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockTrackingMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
			mockUpdateMutateAsync.mock.invocationCallOrder[0],
		);
	});

	it("leaves the other edits unwritten when the tracking flip is rejected", async () => {
		mockEligibilityQuery.mockReturnValue(eligibility({ can_enable: true }));
		mockTrackingMutateAsync.mockRejectedValue(new Error("reduce to zero first"));

		await openStockStep(makeItem({ quantity: 0 }));

		await userEvent.click(screen.getByLabelText("Track by serial number"));
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => expect(mockTrackingMutateAsync).toHaveBeenCalledTimes(1));
		expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
		expect(mockSetTagsMutateAsync).not.toHaveBeenCalled();
	});
});
