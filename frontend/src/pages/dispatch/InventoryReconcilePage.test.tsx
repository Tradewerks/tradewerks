/**
 * Mutation hooks are mocked with real React state, as in LineItemCard.test, so a
 * rejected call re-renders the component's own error UI instead of asserting
 * against a value baked in at mock time.
 */
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { ReconcileQueue, ReconcileTarget } from "../../api/inventory";
import InventoryReconcilePage from "./InventoryReconcilePage";

const mockApply = vi.fn();
const mockBulk = vi.fn();
const mockCreateProvisional = vi.fn();
const mockDismiss = vi.fn();
const mockRestore = vi.fn();
const mockAdopt = vi.fn();
const mockMerge = vi.fn();
const mockReject = vi.fn();

/** Last options the page passed to the queue query — every filter is server-side. */
let lastQueryOpts: unknown;
/** Last key the drill-in asked for, which is how a row proves it can be settled. */
let lastLinesKey: unknown;
let queueData: ReconcileQueue | undefined;
let queueError = false;

const TARGETS: ReconcileTarget[] = [
	{
		id: "cat-1",
		name: "Compressor 2T",
		sku: "CMP-2T",
		unit: "each",
		cost: 180,
		provisional: false,
	},
	{ id: "cat-2", name: "Contactor", sku: null, unit: "each", cost: null, provisional: false },
];

/**
 * Mutation contract with live state, so pending/error UI actually re-renders.
 * Named as a hook because it is one: it runs inside the mocked hooks below and
 * holds their state.
 */
function useStubMutation(fn: (input: never) => Promise<unknown>) {
	const [error, setError] = useState<Error | null>(null);
	const [isPending, setIsPending] = useState(false);
	const call = async (input: never) => {
		setIsPending(true);
		setError(null);
		try {
			const result = await fn(input);
			setIsPending(false);
			return result;
		} catch (e) {
			setIsPending(false);
			const err = e instanceof Error ? e : new Error(String(e));
			setError(err);
			throw err;
		}
	};
	return { isPending, error, mutateAsync: call, mutate: (input: never) => void call(input) };
}

vi.mock("../../hooks/useInventory", () => ({
	useReconcileQueueQuery: (opts: unknown) => {
		lastQueryOpts = opts;
		return {
			data: queueError ? undefined : queueData,
			isLoading: false,
			isError: queueError,
		};
	},
	useReconcileLinesQuery: (key: unknown) => {
		lastLinesKey = key;
		return { data: { lines: [], total: 0 }, isLoading: false, isError: false };
	},
	useReconcileTargetsQuery: () => ({ data: TARGETS, isFetching: false }),
	// The picker declares both hooks and enables one by scope — hooks cannot be
	// conditional. This page is always the reconcile scope, so this stays empty.
	useCatalogSearchQuery: () => ({ data: [], isFetching: false }),
	useApplyLinkageMatchMutation: () => useStubMutation(mockApply),
	useApplyLinkageMatchBulkMutation: () => useStubMutation(mockBulk),
	useCreateProvisionalItemMutation: () => useStubMutation(mockCreateProvisional),
	useDismissUnmappedMutation: () => useStubMutation(mockDismiss),
	useRestoreUnmappedMutation: () => useStubMutation(mockRestore),
	useApproveItemMutation: () => useStubMutation(mockAdopt),
	useMergeItemMutation: () => useStubMutation(mockMerge),
	useRejectItemMutation: () => useStubMutation(mockReject),
}));

// UnitSelect reads org settings only to order the groups, and catalog order is
// its own documented fallback, so an undefined org is a valid state here.
vi.mock("../../hooks/useOrg", () => ({ useOrgSettings: () => ({ data: undefined }) }));

const emptyQueue: ReconcileQueue = {
	counts: [],
	coverage: { linked: 0, unmapped: 0, total: 0, pct: 100 },
	unmapped: [],
	unmapped_total: 0,
	unmapped_value: 0,
	provisional: [],
	provisional_total: 0,
	provisional_value: 0,
	dismissed: [],
};

const makeQueue = (overrides: Partial<ReconcileQueue> = {}): ReconcileQueue => ({
	...emptyQueue,
	...overrides,
});

const provisionalRow = (
	overrides: Partial<ReconcileQueue["provisional"][number]> = {}
): ReconcileQueue["provisional"][number] => ({
	item_id: "item-1",
	name: "Field Compressor",
	origin: "tech_submission",
	cost: null,
	unit_price: null,
	unit: "each",
	low_stock_threshold: null,
	created_at: "2026-08-19T00:00:00.000Z",
	submitted_by: { id: "tech-1", name: "Sam" },
	vehicle_stocks: [],
	lines: 2,
	value: 2400,
	...overrides,
});

const unmappedRow = (
	overrides: Partial<ReconcileQueue["unmapped"][number]> = {}
): ReconcileQueue["unmapped"][number] => ({
	name: "Mystery Coil",
	entities: ["quote"],
	lines: 3,
	value: 480,
	match: null,
	...overrides,
});

function renderPage(search = "") {
	return render(
		<MemoryRouter initialEntries={[`/dispatch/inventory/reconcile${search}`]}>
			<InventoryReconcilePage />
		</MemoryRouter>
	);
}

/** The confirm inside a dialog, not the trigger that opened it — same words. */
function dialogButton(title: string | RegExp, label: string) {
	return within(screen.getByRole("dialog", { name: title })).getByRole("button", {
		name: label,
	});
}

/** Opening a row is what the surface is for; every verb lives behind it. */
async function openRow(label: RegExp | string) {
	await userEvent.click(screen.getByRole("button", { name: label }));
}

async function pickFromCombobox(ariaLabel: string, optionName: string | RegExp) {
	await userEvent.click(screen.getByRole("combobox", { name: ariaLabel }));
	await userEvent.click(screen.getByRole("option", { name: optionName }));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockApply.mockResolvedValue({ quote: 2, job: 1 });
	mockBulk.mockResolvedValue({ results: [{ name: "a", lines: 3 }], linked: 3 });
	mockCreateProvisional.mockResolvedValue({ id: "new-item", name: "Mystery Coil" });
	mockDismiss.mockResolvedValue(undefined);
	mockRestore.mockResolvedValue(undefined);
	mockAdopt.mockResolvedValue(undefined);
	mockMerge.mockResolvedValue(undefined);
	mockReject.mockResolvedValue(undefined);
	queueData = makeQueue();
	queueError = false;
	lastQueryOpts = undefined;
	lastLinesKey = undefined;
});

describe("InventoryReconcilePage — provisional verbs", () => {
	test("adopt is blocked until a cost exists, then sends it with the unit", async () => {
		queueData = makeQueue({ provisional: [provisionalRow({ cost: null })] });
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		const confirm = screen.getByRole("button", { name: "Adopt into catalog" });
		// A cost basis is the one thing that cannot be skipped: without it the item
		// reads as free to weighted average cost.
		expect(confirm).toBeDisabled();
		expect(confirm).toHaveAttribute("title", "A cost is required to adopt an item");

		await userEvent.type(screen.getByLabelText("Cost per unit"), "42.5");
		await userEvent.click(screen.getByRole("button", { name: "Adopt into catalog" }));

		// Unit travels with the adopt: it is the last chance to fix a tech-submitted
		// default before the row leaves this surface for good.
		expect(mockAdopt).toHaveBeenCalledWith({
			itemId: "item-1",
			cost: 42.5,
			unit: "each",
		});
	});

	test("adopt sends the threshold and opening quantity when they are filled in", async () => {
		queueData = makeQueue({ provisional: [provisionalRow({ cost: 12 })] });
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		await userEvent.type(screen.getByLabelText("Low-stock at"), "4");
		await userEvent.clear(screen.getByLabelText("Warehouse qty now"));
		await userEvent.type(screen.getByLabelText("Warehouse qty now"), "6");
		await userEvent.click(screen.getByRole("button", { name: "Adopt into catalog" }));

		expect(mockAdopt).toHaveBeenCalledWith({
			itemId: "item-1",
			cost: 12,
			unit: "each",
			low_stock_threshold: 4,
			initial_warehouse_qty: 6,
		});
	});

	test("adopt sends a typed location trimmed", async () => {
		queueData = makeQueue({ provisional: [provisionalRow({ cost: 12 })] });
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		await userEvent.type(screen.getByLabelText("Location (optional)"), "  A42 - 325  ");
		await userEvent.click(screen.getByRole("button", { name: "Adopt into catalog" }));

		expect(mockAdopt).toHaveBeenCalledWith({
			itemId: "item-1",
			cost: 12,
			unit: "each",
			location: "A42 - 325",
		});
	});

	// A zero opening quantity is the common case and must not write a movement.
	test("adopt omits the opening quantity when it is left at zero", async () => {
		queueData = makeQueue({ provisional: [provisionalRow({ cost: 12 })] });
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		await userEvent.click(screen.getByRole("button", { name: "Adopt into catalog" }));

		expect(mockAdopt).toHaveBeenCalledWith({
			itemId: "item-1",
			cost: 12,
			unit: "each",
		});
	});

	test("merge asks before folding the row away, then sends the chosen target", async () => {
		queueData = makeQueue({ provisional: [provisionalRow()] });
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		await pickFromCombobox("Merge Field Compressor into", /Compressor 2T/);
		await userEvent.click(screen.getByRole("button", { name: "Merge" }));

		// Choosing a target must not write anything on its own.
		expect(mockMerge).not.toHaveBeenCalled();
		await userEvent.click(dialogButton("Merge this part away?", "Merge"));
		expect(mockMerge).toHaveBeenCalledWith({ itemId: "item-1", targetId: "cat-1" });
	});

	// Reject needs a confirmation before it fires: the click destroys the row,
	// with nothing to catch a misclick in between.
	test("reject asks first, then needs no payload beyond the item", async () => {
		queueData = makeQueue({ provisional: [provisionalRow()] });
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		await userEvent.click(screen.getByRole("button", { name: "Reject this part" }));
		expect(mockReject).not.toHaveBeenCalled();

		await userEvent.click(dialogButton("Reject this part?", "Reject"));
		expect(mockReject).toHaveBeenCalledWith("item-1");
	});

	test("surfaces the server's refusal instead of failing silently", async () => {
		queueData = makeQueue({ provisional: [provisionalRow({ cost: 5 })] });
		mockAdopt.mockRejectedValueOnce(
			new Error(
				"Validation failed: cost is required to adopt an item into the catalog"
			)
		);
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		await userEvent.click(screen.getByRole("button", { name: "Adopt into catalog" }));

		expect(
			await screen.findByText(
				"Validation failed: cost is required to adopt an item into the catalog"
			)
		).toBeInTheDocument();
	});

	test("shows where the row came from, rather than guessing at a submitter", () => {
		queueData = makeQueue({
			provisional: [
				provisionalRow({
					item_id: "a",
					name: "Tech Part",
					origin: "tech_submission",
				}),
				provisionalRow({
					item_id: "b",
					name: "Desk Part",
					origin: "dispatch_quick_add",
					submitted_by: null,
				}),
			],
		});
		renderPage("?tab=detail");

		expect(screen.getByText("Tech submission")).toBeInTheDocument();
		// Used to read "Submitted by unknown" for every dispatch quick-add.
		expect(screen.getByText("Dispatch quick-add")).toBeInTheDocument();
	});

	test("names the gaps that keep the row off the catalog", async () => {
		queueData = makeQueue({
			provisional: [provisionalRow({ cost: null, low_stock_threshold: null })],
		});
		renderPage("?tab=detail");
		await openRow(/Field Compressor/);

		expect(
			screen.getByText(/every margin on this part reads 100%/)
		).toBeInTheDocument();
		expect(screen.getByText(/never reaches the forecast/)).toBeInTheDocument();
	});

	test("every filter is a query param, so the browser never filters rows itself", () => {
		queueData = makeQueue({ provisional: [provisionalRow()] });
		renderPage("?tab=detail&origin=tech_submission&sort=lines_desc&q=comp");

		expect(lastQueryOpts).toMatchObject({
			includeDismissed: false,
			origin: "tech_submission",
			search: "comp",
			sort: "lines_desc",
		});
	});
});

describe("InventoryReconcilePage — unmapped verbs", () => {
	test("map points every line with that name at the chosen item", async () => {
		queueData = makeQueue({ unmapped: [unmappedRow()], unmapped_total: 1 });
		renderPage();
		await openRow(/Mystery Coil/);

		await pickFromCombobox("Catalog item for Mystery Coil", /Contactor/);
		await userEvent.click(screen.getByRole("button", { name: /^Map 3$/ }));

		expect(mockApply).toHaveBeenCalledWith({
			name: "Mystery Coil",
			inventory_item_id: "cat-2",
		});
	});

	test("the suggestion is shown as an item, not pre-loaded into the picker", async () => {
		queueData = makeQueue({
			unmapped: [
				unmappedRow({
					match: {
						inventory_item_id: "cat-1",
						name: "Compressor 2T",
						sku: "CMP-2T",
						tier: "case_insensitive",
					},
				}),
			],
			unmapped_total: 1,
		});
		renderPage();
		await openRow(/Mystery Coil/);

		// Accepting a machine guess must look different from making a choice: the
		// match reason ("Name match") stays visible so accepting isn't mistaken
		// for a decision the dispatcher made themselves.
		expect(screen.getByText("CMP-2T")).toBeInTheDocument();
		expect(screen.getAllByText("Name match").length).toBeGreaterThan(0);

		await userEvent.click(screen.getByRole("button", { name: /Accept & map 3/ }));

		expect(mockApply).toHaveBeenCalledWith({
			name: "Mystery Coil",
			inventory_item_id: "cat-1",
		});
	});

	// Otherwise the row is a dead end: leave, create the item, come back, find it.
	test("create & map makes the item and maps in one action", async () => {
		queueData = makeQueue({ unmapped: [unmappedRow()], unmapped_total: 1 });
		renderPage();
		await openRow(/Mystery Coil/);

		await userEvent.click(screen.getByRole("button", { name: /Create as a new part/ }));

		expect(mockCreateProvisional).toHaveBeenCalledWith({ name: "Mystery Coil" });
		expect(mockApply).toHaveBeenCalledWith({
			name: "Mystery Coil",
			inventory_item_id: "new-item",
		});
	});

	test("marking a name intentional is a verb of its own, and records the reason", async () => {
		queueData = makeQueue({ unmapped: [unmappedRow()], unmapped_total: 1 });
		renderPage();
		await openRow(/Mystery Coil/);

		await userEvent.click(screen.getByRole("button", { name: /Mark intentional/ }));
		// The column existed and was always empty: nothing ever collected a reason.
		await userEvent.type(
			screen.getByLabelText("Reason this part is never stocked"),
			"Sub's own material"
		);
		await userEvent.click(screen.getByRole("button", { name: "Mark intentional" }));

		expect(mockDismiss).toHaveBeenCalledWith({
			name: "Mystery Coil",
			reason: "Sub's own material",
		});
	});

	test("shows each name's value, which is what the ranking is on", () => {
		queueData = makeQueue({
			unmapped: [
				unmappedRow({ name: "Compressor", value: 2400, lines: 1 }),
				unmappedRow({ name: "Grommet", value: 36, lines: 9 }),
			],
			unmapped_total: 2,
			unmapped_value: 2436,
		});
		renderPage();

		expect(screen.getByText("$2,400")).toBeInTheDocument();
		expect(screen.getByText("$36")).toBeInTheDocument();
	});

	// A capped list that reads as the whole backlog is worse than no list.
	test("discloses that the list is truncated", () => {
		queueData = makeQueue({
			unmapped: [unmappedRow()],
			unmapped_total: 87,
			unmapped_value: 5000,
		});
		renderPage();

		expect(screen.getByText("Showing 1 of 87")).toBeInTheDocument();
	});

	test("says how deep the provisional backlog is, and asks the server for more", async () => {
		queueData = makeQueue({
			provisional: [provisionalRow()],
			provisional_total: 87,
			provisional_value: 9000,
		});
		renderPage("?tab=detail");

		expect(screen.getByText("Showing 1 of 87")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Load more" }));

		// The server honours limit on this half now, so a deeper page is a
		// deeper answer rather than the same 50 rows again.
		expect(lastQueryOpts).toMatchObject({ limit: 100 });
	});

	test("stays quiet about truncation when nothing is truncated", () => {
		queueData = makeQueue({ unmapped: [unmappedRow()], unmapped_total: 1 });
		renderPage();

		expect(screen.queryByText(/Showing 1 of/)).not.toBeInTheDocument();
		expect(screen.getByText("1 total")).toBeInTheDocument();
	});

	test("opening a row asks for the documents billing it", async () => {
		queueData = makeQueue({ unmapped: [unmappedRow()], unmapped_total: 1 });
		renderPage();
		await openRow(/Mystery Coil/);

		expect(lastLinesKey).toEqual({
			name: "Mystery Coil",
			foldedName: undefined,
			itemId: undefined,
		});
	});
});

describe("InventoryReconcilePage — bulk accept", () => {
	const exact = (name: string, value: number) =>
		unmappedRow({
			name,
			value,
			match: { inventory_item_id: `id-${name}`, name, sku: null, tier: "exact" },
		});

	test("offers only the exact matches, and asks before rewriting them", async () => {
		queueData = makeQueue({
			unmapped: [
				exact("Compressor 2T", 2400),
				exact("Contactor", 100),
				// A folded-name hit is a guess somebody should read, not bulk-accept.
				unmappedRow({
					name: "coil",
					match: {
						inventory_item_id: "cat-9",
						name: "Coil",
						sku: null,
						tier: "case_insensitive",
					},
				}),
			],
			unmapped_total: 3,
		});
		renderPage();

		await userEvent.click(screen.getByRole("button", { name: "Accept all 2" }));
		expect(mockBulk).not.toHaveBeenCalled();

		await userEvent.click(dialogButton(/Accept 2 exact matches/, "Accept all 2"));

		expect(mockBulk).toHaveBeenCalledWith({
			pairs: [
				{ name: "Compressor 2T", inventory_item_id: "id-Compressor 2T" },
				{ name: "Contactor", inventory_item_id: "id-Contactor" },
			],
		});
	});

	test("stays hidden when nothing matches exactly", () => {
		queueData = makeQueue({ unmapped: [unmappedRow()], unmapped_total: 1 });
		renderPage();

		expect(
			screen.queryByRole("button", { name: /Accept all/ })
		).not.toBeInTheDocument();
	});
});

describe("InventoryReconcilePage — dismissed names", () => {
	test("asks the server for them only on the tab that shows them", async () => {
		renderPage();
		expect(lastQueryOpts).toMatchObject({ includeDismissed: false });

		await userEvent.click(screen.getByRole("button", { name: /Marked intentional/ }));

		expect(lastQueryOpts).toMatchObject({ includeDismissed: true });
	});

	test("names who decided and when, and offers a way back", async () => {
		queueData = makeQueue({
			dismissed: [
				{
					folded_name: "trip charge",
					decided_at: "2026-08-20T12:00:00.000Z",
					decided_by: { id: "d1", name: "Dana" },
					reason: "Never stocked",
				},
			],
		});
		renderPage("?tab=intentional");
		await openRow(/trip charge/);

		// Both the row and the pane attribute the decision.
		expect(screen.getAllByText(/Dana/)).toHaveLength(2);
		expect(screen.getByText("Never stocked")).toBeInTheDocument();
		// Folded, so one decision covers every casing the lines were written in.
		expect(lastLinesKey).toEqual({
			name: undefined,
			foldedName: "trip charge",
			itemId: undefined,
		});

		await userEvent.click(screen.getByRole("button", { name: "Reopen" }));

		expect(mockRestore).toHaveBeenCalledWith({ name: "trip charge" });
	});
});

describe("InventoryReconcilePage — the strip", () => {
	test("leads with coverage and the money behind the backlog", () => {
		queueData = makeQueue({
			coverage: { linked: 80, unmapped: 20, total: 100, pct: 80 },
			unmapped: [unmappedRow()],
			unmapped_total: 1,
			unmapped_value: 480,
			// The row on screen carries 100 while the backlog behind it carries
			// 2400, so a strip that sums what it renders reads 580 and fails.
			provisional: [provisionalRow({ value: 100 })],
			provisional_total: 1,
			provisional_value: 2400,
		});
		renderPage();

		expect(screen.getByText("80%")).toBeInTheDocument();
		expect(screen.getByText("of 100 material lines")).toBeInTheDocument();
		// Both row kinds contribute: 480 unmapped + 2400 sitting on half-items.
		expect(screen.getByText("$2,880")).toBeInTheDocument();
	});

	// "100% of 0 lines mapped" reported an org with no material billing as a pass.
	test("declines to call an empty org fully covered", () => {
		queueData = makeQueue();
		renderPage();

		expect(screen.getByText("No material lines yet")).toBeInTheDocument();
		expect(screen.queryByText("100%")).not.toBeInTheDocument();
	});

	test("reads an empty queue as done rather than as broken", () => {
		queueData = makeQueue();
		renderPage();

		expect(
			screen.getByText("Every material line points at a catalog item")
		).toBeInTheDocument();
	});

	// The old surface rendered 0% coverage and "every line points at an item" when
	// the request failed, which is a lie rather than a loading state.
	test("says the queue failed instead of reporting it as clean", () => {
		queueError = true;
		renderPage();

		expect(screen.getByText("Could not load the queue")).toBeInTheDocument();
		expect(
			screen.queryByText("Every material line points at a catalog item")
		).not.toBeInTheDocument();
	});
});

describe("InventoryReconcilePage — filtered vs empty", () => {
	test("a search that hides everything does not read as a clean catalog", () => {
		queueData = makeQueue();
		renderPage("?q=compressor");

		expect(screen.getByText("Nothing matches these filters")).toBeInTheDocument();
		expect(
			screen.queryByText("Every material line points at a catalog item")
		).not.toBeInTheDocument();
	});
});
