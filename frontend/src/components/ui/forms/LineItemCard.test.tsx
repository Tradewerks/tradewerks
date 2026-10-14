import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi, beforeEach } from "vitest";
import LineItemCard from "./LineItemCard";
import type { LineItemCardProps } from "./LineItemCard";
import type { BaseLineItem } from "../../../types/common";
import type { InventoryItem } from "../../../types/inventory";

const mockCreateProvisional = vi.fn();

// Mimics the react-query mutation contract with real React state so a
// resolve/reject actually re-renders the component under test — the picker's
// pending/error UI reads live hook state, not a value baked in at mock time.
vi.mock("../../../hooks/useInventory", () => ({
	useCreateProvisionalItemMutation: () => {
		const [isPending, setIsPending] = useState(false);
		const [error, setError] = useState<Error | null>(null);
		return {
			isPending,
			error,
			mutateAsync: async (input: unknown) => {
				setIsPending(true);
				setError(null);
				try {
					const result = await mockCreateProvisional(input);
					setIsPending(false);
					return result;
				} catch (e) {
					setIsPending(false);
					const err = e instanceof Error ? e : new Error(String(e));
					setError(err);
					throw err;
				}
			},
		};
	},
}));

function makeInvItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
	return {
		id: "item-1",
		name: "Line Set",
		description: "",
		location: "A1",
		quantity: 10,
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
	} as InventoryItem;
}

function makeLineItem(overrides: Partial<BaseLineItem> = {}): BaseLineItem {
	return {
		id: "li-1",
		name: "",
		description: "",
		quantity: 1,
		unit_price: 0,
		item_type: "material",
		total: 0,
		taxable: true,
		tax_group_id: null,
		inventory_item_id: null,
		...overrides,
	};
}

function renderCard(props: Partial<LineItemCardProps> = {}) {
	const item = props.item ?? makeLineItem();
	const defaults: LineItemCardProps = {
		item,
		index: 0,
		isLoading: false,
		canRemove: true,
		onRemove: vi.fn(),
		onUpdate: vi.fn(),
	};
	return render(<LineItemCard {...defaults} {...props} />);
}

// Stands in for useLineItems' setLineItemInventoryItem/updateLineItem wiring
// (unit-tested separately) so the picker can be driven with real typing and
// selection instead of a static, uneditable prop.
function Harness({
	initialItem,
	inventoryItems = [],
	onLinkInventory,
}: {
	initialItem: BaseLineItem;
	inventoryItems?: InventoryItem[];
	onLinkInventory: NonNullable<LineItemCardProps["onLinkInventory"]>;
}) {
	const [item, setItem] = useState(initialItem);

	const handleUpdate: LineItemCardProps["onUpdate"] = (id, field, value) => {
		setItem((prev) => ({ ...prev, [field]: value }));
	};

	const handleLink: NonNullable<LineItemCardProps["onLinkInventory"]> = (id, link) => {
		onLinkInventory(id, link);
		setItem((prev) =>
			link
				? {
						...prev,
						inventory_item_id: link.inventory_item_id,
						name: link.name,
						unit_price: link.unit_price ?? prev.unit_price,
					}
				: { ...prev, inventory_item_id: null }
		);
	};

	return (
		<LineItemCard
			item={item}
			index={0}
			isLoading={false}
			canRemove={true}
			onRemove={() => {}}
			onUpdate={handleUpdate}
			onLinkInventory={handleLink}
			inventoryItems={inventoryItems}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("LineItemCard — when the picker renders", () => {
	test("material + onLinkInventory renders the catalog search input, not a plain name field", () => {
		renderCard({
			item: makeLineItem({ item_type: "material" }),
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByPlaceholderText("Search inventory *")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Item name *")).not.toBeInTheDocument();
	});

	test("equipment + onLinkInventory also renders the catalog search input", () => {
		renderCard({
			item: makeLineItem({ item_type: "equipment" }),
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByPlaceholderText("Search inventory *")).toBeInTheDocument();
	});

	test("an untyped line renders the catalog search input — a new line starts untyped", () => {
		renderCard({
			item: makeLineItem({ item_type: "" }),
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByPlaceholderText("Search inventory *")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Item name *")).not.toBeInTheDocument();
	});

	test("an untyped line is prompted, not warned — it may still turn out to be labor", () => {
		renderCard({
			item: makeLineItem({ item_type: "" }),
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByText("Search the catalog, or set a type below")).toBeInTheDocument();
		expect(screen.queryByText(/won.t deduct from stock/i)).not.toBeInTheDocument();
	});

	test("labor renders a plain name input even when onLinkInventory is supplied", () => {
		renderCard({
			item: makeLineItem({ item_type: "labor" }),
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByPlaceholderText("Item name *")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Search inventory *")).not.toBeInTheDocument();
	});

	test("material without an onLinkInventory handler renders a plain name input", () => {
		renderCard({ item: makeLineItem({ item_type: "material" }) });

		expect(screen.getByPlaceholderText("Item name *")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Search inventory *")).not.toBeInTheDocument();
	});

	test("renders even when inventoryItems is empty, so a young org can still quick-add", () => {
		renderCard({
			item: makeLineItem({ item_type: "material" }),
			onLinkInventory: vi.fn(),
			inventoryItems: [],
		});

		expect(screen.getByPlaceholderText("Search inventory *")).toBeInTheDocument();
	});
});

describe("LineItemCard — selecting a catalog row", () => {
	test("calls onLinkInventory with { inventory_item_id, name, unit_price }", async () => {
		const onLinkInventory = vi.fn();
		const catalogItem = makeInvItem({ id: "inv-9", name: "Contactor 24V", unit_price: 42.5 });

		render(
			<Harness
				initialItem={makeLineItem({ item_type: "material" })}
				inventoryItems={[catalogItem]}
				onLinkInventory={onLinkInventory}
			/>
		);

		await userEvent.click(screen.getByPlaceholderText("Search inventory *"));
		await userEvent.click(await screen.findByText("Contactor 24V"));

		expect(onLinkInventory).toHaveBeenCalledWith("li-1", {
			inventory_item_id: "inv-9",
			name: "Contactor 24V",
			unit_price: 42.5,
		});
	});
});

describe("LineItemCard — link status display", () => {
	test("unlinked material line shows the won't-deduct warning", () => {
		renderCard({
			item: makeLineItem({ item_type: "material", inventory_item_id: null }),
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByText(/won.t deduct from stock/i)).toBeInTheDocument();
	});

	test("linked line found in inventoryItems shows on-hand qty (via formatQty) and margin", () => {
		const catalogItem = makeInvItem({
			id: "inv-1",
			name: "Compressor",
			quantity: 14,
			unit: "each",
			cost: 50,
		});

		renderCard({
			item: makeLineItem({
				item_type: "material",
				inventory_item_id: "inv-1",
				name: "Compressor",
				unit_price: 100,
			}),
			inventoryItems: [catalogItem],
			onLinkInventory: vi.fn(),
		});

		// formatQty(14, "each") => "14 units" — "each" is the one code whose
		// display word differs from the raw stored code.
		expect(screen.getByText("14 units on hand")).toBeInTheDocument();
		// margin = (100 - 50) / 100 = 50%
		expect(screen.getByText("50% margin")).toBeInTheDocument();
		expect(screen.queryByText(/won.t deduct from stock/i)).not.toBeInTheDocument();
	});

	test("linked line whose item is NOT in inventoryItems (provisional) still reads as linked", () => {
		renderCard({
			item: makeLineItem({
				item_type: "material",
				inventory_item_id: "inv-provisional",
				name: "New Gasket Kit",
			}),
			inventoryItems: [], // catalog list excludes provisional items
			onLinkInventory: vi.fn(),
		});

		expect(screen.getByText("awaiting review")).toBeInTheDocument();
		expect(screen.queryByText(/not linked/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/won.t deduct from stock/i)).not.toBeInTheDocument();
	});
});

describe("LineItemCard — quick add", () => {
	test('typing an unmatched name offers "Add "<name>" to inventory"', async () => {
		render(
			<Harness
				initialItem={makeLineItem({ item_type: "material" })}
				inventoryItems={[makeInvItem({ name: "Existing Part" })]}
				onLinkInventory={vi.fn()}
			/>
		);

		await userEvent.type(screen.getByPlaceholderText("Search inventory *"), "Brand New Gasket");

		expect(
			await screen.findByText('Add "Brand New Gasket" to inventory')
		).toBeInTheDocument();
	});

	test("clicking quick add creates the item then links it with unit_price: null", async () => {
		const created = makeInvItem({ id: "inv-created", name: "Brand New Gasket" });
		mockCreateProvisional.mockResolvedValue(created);
		const onLinkInventory = vi.fn();

		render(
			<Harness
				initialItem={makeLineItem({ item_type: "material" })}
				inventoryItems={[]}
				onLinkInventory={onLinkInventory}
			/>
		);

		await userEvent.type(screen.getByPlaceholderText("Search inventory *"), "Brand New Gasket");
		await userEvent.click(await screen.findByText('Add "Brand New Gasket" to inventory'));

		await waitFor(() => expect(mockCreateProvisional).toHaveBeenCalledWith({ name: "Brand New Gasket" }));
		await waitFor(() =>
			expect(onLinkInventory).toHaveBeenCalledWith("li-1", {
				inventory_item_id: "inv-created",
				name: "Brand New Gasket",
				unit_price: null,
			})
		);
	});

	test("quick add is not offered when the typed name exactly matches a catalog name (case-insensitive)", async () => {
		render(
			<Harness
				initialItem={makeLineItem({ item_type: "material" })}
				inventoryItems={[makeInvItem({ name: "Contactor 24V" })]}
				onLinkInventory={vi.fn()}
			/>
		);

		await userEvent.type(screen.getByPlaceholderText("Search inventory *"), "contactor 24v");

		// The matching catalog row renders...
		expect(await screen.findByText("Contactor 24V")).toBeInTheDocument();
		// ...but the escape hatch does not, since it would just duplicate it.
		expect(screen.queryByText(/Add ".*" to inventory/)).not.toBeInTheDocument();
	});

	test("quick add failure renders the error in the dropdown and keeps it open, without an unhandled rejection", async () => {
		mockCreateProvisional.mockRejectedValue(new Error("Name already exists"));
		const onLinkInventory = vi.fn();

		render(
			<Harness
				initialItem={makeLineItem({ item_type: "material" })}
				inventoryItems={[]}
				onLinkInventory={onLinkInventory}
			/>
		);

		await userEvent.type(screen.getByPlaceholderText("Search inventory *"), "Duplicate Name");
		await userEvent.click(await screen.findByText('Add "Duplicate Name" to inventory'));

		expect(await screen.findByText("Name already exists")).toBeInTheDocument();
		// Still open — the quick-add affordance is still present alongside the error.
		expect(screen.getByText('Add "Duplicate Name" to inventory')).toBeInTheDocument();
		expect(onLinkInventory).not.toHaveBeenCalled();
	});
});

describe("LineItemCard — unlinking", () => {
	test("the unlink X calls onLinkInventory(id, null)", async () => {
		const onLinkInventory = vi.fn();

		renderCard({
			item: makeLineItem({
				item_type: "material",
				inventory_item_id: "inv-1",
				name: "Compressor",
			}),
			inventoryItems: [makeInvItem({ id: "inv-1", name: "Compressor" })],
			onLinkInventory,
		});

		await userEvent.click(screen.getByTitle("Unlink from inventory"));

		expect(onLinkInventory).toHaveBeenCalledWith("li-1", null);
	});
});

/**
 * The stock-effect control. Exercised through the path a dispatcher actually
 * takes — type a name, pick the catalog item, then choose what completion
 * should do with it — because a test that pre-sets `inventory_item_id` cannot
 * tell a working picker from a broken one.
 */
describe("LineItemCard — disposition", () => {
	/** Harness above, plus the disposition wiring useLineItems normally supplies. */
	function DispositionHarness({
		initialItem,
		inventoryItems = [],
		vehicles = [],
		onDispositionChange,
	}: {
		initialItem: BaseLineItem;
		inventoryItems?: InventoryItem[];
		vehicles?: { id: string; name: string }[];
		onDispositionChange?: NonNullable<LineItemCardProps["onDispositionChange"]>;
	}) {
		const [item, setItem] = useState(initialItem);

		return (
			<LineItemCard
				item={item}
				index={0}
				isLoading={false}
				canRemove
				onRemove={() => {}}
				onUpdate={(id, field, value) => setItem((prev) => ({ ...prev, [field]: value }))}
				onLinkInventory={(id, link) =>
					setItem((prev) =>
						link
							? { ...prev, inventory_item_id: link.inventory_item_id, name: link.name }
							: { ...prev, inventory_item_id: null },
					)
				}
				inventoryItems={inventoryItems}
				showDisposition
				vehicles={vehicles}
				onDispositionChange={(id, disposition, vehicleId) => {
					onDispositionChange?.(id, disposition, vehicleId);
					setItem((prev) => ({
						...prev,
						disposition,
						disposition_vehicle_id: disposition === "receive" ? (vehicleId ?? null) : null,
					}));
				}}
			/>
		);
	}

	test("appears only once the line is actually linked to a catalog item", async () => {
		render(
			<DispositionHarness
				initialItem={makeLineItem({ item_type: "material" })}
				inventoryItems={[makeInvItem({ id: "inv-1", name: "Compressor" })]}
			/>,
		);

		// Unlinked: nothing to have a stock effect on.
		expect(screen.queryByLabelText("Stock effect")).not.toBeInTheDocument();

		await userEvent.type(screen.getByPlaceholderText("Search inventory *"), "Comp");
		await userEvent.click(await screen.findByText("Compressor"));

		expect(await screen.findByLabelText("Stock effect")).toBeInTheDocument();
	});

	// NULL and "no value yet" both mean consume — the behaviour every linked line
	// had before the column existed.
	test("defaults to consume for a line that carries no disposition", () => {
		render(
			<DispositionHarness
				initialItem={makeLineItem({
					item_type: "material",
					inventory_item_id: "inv-1",
					name: "Compressor",
				})}
				inventoryItems={[makeInvItem({ id: "inv-1", name: "Compressor" })]}
			/>,
		);

		expect(screen.getByLabelText("Stock effect")).toHaveValue("consume");
	});

	test("choosing 'receive' reveals a destination defaulted to the warehouse", async () => {
		const onDispositionChange = vi.fn();
		render(
			<DispositionHarness
				initialItem={makeLineItem({
					item_type: "material",
					inventory_item_id: "inv-1",
					name: "Compressor",
				})}
				inventoryItems={[makeInvItem({ id: "inv-1", name: "Compressor" })]}
				vehicles={[{ id: "veh-1", name: "Van 3" }]}
				onDispositionChange={onDispositionChange}
			/>,
		);

		expect(screen.queryByLabelText("Receive into")).not.toBeInTheDocument();

		await userEvent.selectOptions(screen.getByLabelText("Stock effect"), "receive");

		// Dispatcher is the actor here, so the warehouse is the default; the van
		// is offered because the tech may already have it.
		const destination = await screen.findByLabelText("Receive into");
		expect(destination).toHaveValue("");
		expect(onDispositionChange).toHaveBeenCalledWith("li-1", "receive", null);

		await userEvent.selectOptions(destination, "veh-1");
		expect(onDispositionChange).toHaveBeenLastCalledWith("li-1", "receive", "veh-1");
	});

	test("switching away from receive drops the destination it can no longer mean", async () => {
		const onDispositionChange = vi.fn();
		render(
			<DispositionHarness
				initialItem={makeLineItem({
					item_type: "material",
					inventory_item_id: "inv-1",
					name: "Compressor",
					disposition: "receive",
					disposition_vehicle_id: "veh-1",
				})}
				inventoryItems={[makeInvItem({ id: "inv-1", name: "Compressor" })]}
				vehicles={[{ id: "veh-1", name: "Van 3" }]}
				onDispositionChange={onDispositionChange}
			/>,
		);

		await userEvent.selectOptions(screen.getByLabelText("Stock effect"), "consume");

		expect(onDispositionChange).toHaveBeenCalledWith("li-1", "consume", null);
		expect(screen.queryByLabelText("Receive into")).not.toBeInTheDocument();
	});

	test("says out loud that a non-stock line moves nothing", async () => {
		render(
			<DispositionHarness
				initialItem={makeLineItem({
					item_type: "material",
					inventory_item_id: "inv-1",
					name: "Compressor",
				})}
				inventoryItems={[makeInvItem({ id: "inv-1", name: "Compressor" })]}
			/>,
		);

		await userEvent.selectOptions(screen.getByLabelText("Stock effect"), "non_stock");

		expect(
			await screen.findByText("Billed, never in our stock — nothing is deducted"),
		).toBeInTheDocument();
	});

	test("stays absent on forms that don't opt in (quotes, jobs, invoices move no stock)", () => {
		renderCard({
			item: makeLineItem({
				item_type: "material",
				inventory_item_id: "inv-1",
				name: "Compressor",
			}),
			inventoryItems: [makeInvItem({ id: "inv-1", name: "Compressor" })],
			onLinkInventory: vi.fn(),
		});

		expect(screen.queryByLabelText("Stock effect")).not.toBeInTheDocument();
	});
});
