/**
 * Editing must survive the list changing underneath it, and machine-read
 * uncertainty must announce once rather than N times over.
 */
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { within } from "@testing-library/react";
import { render, screen } from "../../../../test/testUtils";
import { describe, expect, test, vi } from "vitest";
import PurchaseLineEditor, { type LineJobOption } from "../PurchaseLineEditor";
import {
	applySheetDisposition,
	blankLine,
	type ExtractedReceiptLine,
	type LineDraft,
	type SheetDisposition,
} from "../lineDrafts";
import type { FieldPurchase } from "../../../../types/fieldPurchases";

vi.mock("../../../../hooks/useVehicles", () => ({
	useVehiclesQuery: () => ({ data: [], isLoading: false, isError: false }),
}));

// Every line renders a CatalogItemPicker, which searches the catalog on the
// server. Stubbed rather than left to fail: the picker has its own coverage and
// a per-line network error here is noise, not signal.
vi.mock("../../../../hooks/useInventory", () => ({
	useCatalogSearchQuery: () => ({ data: [], isFetching: false, error: null }),
	useReconcileTargetsQuery: () => ({ data: [], isFetching: false, error: null }),
}));

/** Only the OCR status, line count and the line cutoff are read off the purchase here. */
const purchase = {
	ocr_status: "skipped",
	ocr_line_count: null,
	ocr_field_flags: { fields: {}, line_cutoff: 0.75 },
} as unknown as FieldPurchase;

const draft = (description: string, over: Partial<LineDraft> = {}): LineDraft => ({
	...blankLine(),
	description,
	...over,
});

/**
 * The component is controlled — the parent owns the drafts — so a delete only
 * re-renders the list if the state lives outside it. Testing against a fixed
 * array would assert nothing about identity.
 */
function Harness({ initial, jobs }: { initial: LineDraft[]; jobs?: LineJobOption[] }) {
	const [lines, setLines] = useState(initial);
	return (
		<PurchaseLineEditor
			purchase={purchase}
			editable
			jobs={jobs}
			lines={lines}
			onChange={setLines}
		/>
	);
}

const TWO_JOBS: LineJobOption[] = [
	{ key: "a", label: "Anderson rooftop" },
	{ key: "b", label: "Smith Bldg 2" },
];

const descriptionInputs = () =>
	screen.getAllByPlaceholderText("Part as it reads on the receipt") as HTMLInputElement[];

const statusText = () => screen.getByRole("status").textContent?.trim() ?? "";

describe("editing across a delete", () => {
	/**
	 * Node identity is the thing under test, not the values: these inputs are
	 * controlled, so values follow props even with index keys. What index keys
	 * destroyed is the element itself, and with it selection and IME state. The
	 * discriminating case is a row BELOW the deletion - above it survives either way.
	 */
	test("the row below a deleted line keeps the same element it was typed into", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={[
					draft("Contactor 40A"),
					draft("Capacitor 45/5"),
					draft("Fan belt"),
				]}
			/>
		);

		const beltBefore = descriptionInputs()[2]!;
		const capacitorBefore = descriptionInputs()[1]!;

		await user.click(screen.getAllByLabelText("Remove item")[0]!);

		const remaining = descriptionInputs();
		expect(remaining.map((i) => i.value)).toEqual(["Capacitor 45/5", "Fan belt"]);
		// Both survivors are the very same elements, shifted up one slot.
		expect(remaining[0]).toBe(capacitorBefore);
		expect(remaining[1]).toBe(beltBefore);
	});

	test("selection inside a surviving row is not clobbered by a deletion above it", async () => {
		const user = userEvent.setup();
		render(<Harness initial={[draft("Contactor 40A"), draft("Capacitor 45/5")]} />);

		const capacitor = descriptionInputs()[1]!;
		await user.click(capacitor);
		capacitor.setSelectionRange(2, 5);

		await user.click(screen.getAllByLabelText("Remove item")[0]!);

		const survivor = descriptionInputs()[0]!;
		expect(survivor).toBe(capacitor);
		expect([survivor.selectionStart, survivor.selectionEnd]).toEqual([2, 5]);
	});
});

describe("saying which job a line was for", () => {
	/**
	 * The whole point of the single-job case: the answer is not in doubt, and
	 * asking anyway costs every ordinary counter trip a step it does not need.
	 */
	test("no job control at all when the receipt covers one job", () => {
		render(
			<Harness
				initial={[draft("Contactor 40A", { allocationKey: "a" })]}
				jobs={[TWO_JOBS[0]!]}
			/>
		);

		expect(screen.queryByLabelText(/which job it was for/i)).toBeNull();
		expect(screen.queryByLabelText(/split .* across two jobs/i)).toBeNull();
	});

	test("every line names its job once a second one is on the receipt", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={[draft("Contactor 40A", { allocationKey: "a" })]}
				jobs={TWO_JOBS}
			/>
		);

		const select = screen.getByLabelText("Job") as HTMLSelectElement;
		expect(select.value).toBe("a");
		await user.selectOptions(select, "b");
		expect(
			(screen.getByLabelText("Job") as HTMLSelectElement).value
		).toBe("b");
	});

	/**
	 * Node identity again, for the same reason as the delete tests: the halves are
	 * two rows, and the one the technician was typing into has to still be the
	 * element they were typing into.
	 */
	test("splitting a line halves it in place and keeps the original element", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={[
					draft("Contactor 40A", {
						allocationKey: "a",
						quantity: "3",
					}),
					draft("Fan belt", { allocationKey: "a" }),
				]}
				jobs={TWO_JOBS}
			/>
		);

		const contactorBefore = descriptionInputs()[0]!;
		await user.click(screen.getByLabelText("Split Contactor 40A across two jobs"));

		const rows = descriptionInputs();
		// The new half lands beside the line it came out of, not at the bottom.
		expect(rows.map((i) => i.value)).toEqual([
			"Contactor 40A",
			"Contactor 40A",
			"Fan belt",
		]);
		expect(rows[0]).toBe(contactorBefore);

		// Halved, not copied: the two sum back to what was on the receipt.
		const quantities = screen.getAllByRole("textbox", {
			name: "Qty",
		}) as HTMLInputElement[];
		expect([quantities[0]!.value, quantities[1]!.value]).toEqual(["1.5", "1.5"]);

		// And the half that moved is tagged to the other job, which is the point.
		const jobs = screen.getAllByLabelText(
			"Job"
		) as HTMLSelectElement[];
		expect([jobs[0]!.value, jobs[1]!.value]).toEqual(["a", "b"]);
	});

	test("says how many lines still owe an answer", () => {
		render(
			<Harness
				initial={[
					draft("Contactor 40A", { allocationKey: "a" }),
					draft("Fan belt", { allocationKey: "" }),
				]}
				jobs={TWO_JOBS}
			/>
		);

		expect(screen.getByText(/1 item needs a job/i)).toBeTruthy();
	});
});

describe("low-confidence announcement", () => {
	test("one summary region reports the count, not one region per line", () => {
		render(
			<Harness
				initial={[
					draft("Contactor 40A", {
						ocrConfidence: 0.4,
						acknowledged: false,
					}),
					draft("Capacitor 45/5", {
						ocrConfidence: 0.5,
						acknowledged: false,
					}),
					draft("Fan belt", {
						ocrConfidence: 0.9,
						acknowledged: false,
					}),
				]}
			/>
		);

		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(statusText()).toBe(
			"2 items read with low confidence — check them against the receipt."
		);
	});

	test("reads for a single line, and empties once it is checked", async () => {
		const user = userEvent.setup();
		render(
			<Harness
				initial={[
					draft("Contactor 40A", {
						ocrConfidence: 0.4,
						acknowledged: false,
					}),
				]}
			/>
		);

		expect(statusText()).toBe(
			"1 item read with low confidence — check it against the receipt."
		);

		await user.click(screen.getByRole("checkbox", { name: /matches the receipt/i }));

		expect(statusText()).toBe("");
	});

	test("stays mounted and silent when nothing was read with low confidence", () => {
		render(<Harness initial={[draft("Contactor 40A")]} />);

		// Mounted, not conditional: a live region added at the same moment as its
		// content does not announce the first change.
		expect(screen.getByRole("status")).toBeTruthy();
		expect(statusText()).toBe("");
	});
});

/**
 * An extraction that landed while the technician was typing. The server keeps
 * their lines and stands the reading down, so the only place it can still reach
 * them is here — silently dropping it loses the whole receipt behind one typed row.
 */
describe("an extraction the purchase never applied", () => {
	const extractedLine = (over: Partial<ExtractedReceiptLine> = {}): ExtractedReceiptLine => ({
		description: "Capacitor 45/5",
		quantity: 2,
		unit_price: 24.99,
		line_total: 49.98,
		confidence: 0.93,
		applied: false,
		...over,
	});

	function Sheet({ extracted }: { extracted: ExtractedReceiptLine[] }) {
		const [lines, setLines] = useState([draft("Fan belt")]);
		return (
			<PurchaseLineEditor
				purchase={purchase}
				editable
				extractedLines={extracted}
				lines={lines}
				onChange={setLines}
			/>
		);
	}

	test("says how many lines the receipt read that the sheet is not showing", () => {
		render(
			<Sheet
				extracted={[
					extractedLine(),
					extractedLine({ description: "Fuse 5A" }),
				]}
			/>
		);
		expect(
			screen.getByRole("button", { name: /2 items read from the receipt/i })
		).toBeTruthy();
	});

	test("stays quiet about lines the purchase already carries", () => {
		render(<Sheet extracted={[extractedLine({ applied: true })]} />);
		expect(screen.queryByRole("button", { name: /read from the receipt/i })).toBeNull();
	});

	test("adds them beside what was typed rather than over it", async () => {
		const user = userEvent.setup();
		render(<Sheet extracted={[extractedLine()]} />);

		await user.click(screen.getByRole("button", { name: /read from the receipt/i }));

		expect(descriptionInputs().map((i) => i.value)).toEqual([
			"Fan belt",
			"Capacitor 45/5",
		]);
	});

	test("every added line arrives unconfirmed, so submit stays blocked", async () => {
		const user = userEvent.setup();
		render(<Sheet extracted={[extractedLine()]} />);

		await user.click(screen.getByRole("button", { name: /read from the receipt/i }));

		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
		expect(boxes.map((b) => b.checked)).toEqual([true, false]);
		expect(screen.getByText(/1 item left to check against the receipt/i)).toBeTruthy();
	});

	/**
	 * The offer can appear seconds after the photo, while the technician is
	 * looking somewhere else on the page. Inserted silently, a screen-reader user
	 * only finds it by chance.
	 */
	test("announces the offer rather than appearing silently", () => {
		render(
			<Sheet
				extracted={[
					extractedLine(),
					extractedLine({ description: "Fuse 5A" }),
				]}
			/>
		);
		expect(statusText()).toMatch(/2 items read from the receipt/i);
	});

	/**
	 * Pressing the offer is what removes it. Without somewhere to send focus it
	 * falls to <body> and a keyboard user is dropped at the top of the page,
	 * away from the lines they just asked for.
	 */
	test("puts focus on the first line it just added", async () => {
		const user = userEvent.setup();
		render(<Sheet extracted={[extractedLine()]} />);

		await user.click(screen.getByRole("button", { name: /read from the receipt/i }));

		expect(document.activeElement).toBe(descriptionInputs()[1]);
	});

	test("stops offering once they are on the sheet", async () => {
		const user = userEvent.setup();
		render(<Sheet extracted={[extractedLine()]} />);

		await user.click(screen.getByRole("button", { name: /read from the receipt/i }));

		expect(screen.queryByRole("button", { name: /read from the receipt/i })).toBeNull();
	});
});

/**
 * Lines plus tax must reconcile to what was paid, within a cent — said while it
 * can still be fixed. Checked against
 * the figures ON THE SHEET, not the server's copy of them: the technician types
 * the total at the counter and it is not persisted until submit, so reading
 * `purchase.total` meant the check never fired on the draft it exists for.
 */
describe("receipt total against the lines", () => {
	// A fresh draft: the server still holds zero, the technician has typed a total.
	const draftPurchase = {
		ocr_status: "skipped",
		ocr_line_count: null,
		total: "0.00",
		tax_amount: "0.00",
	} as unknown as FieldPurchase;

	const withPaid = (totalPaid: number, taxAmount = 0) =>
		render(
			<PurchaseLineEditor
				purchase={draftPurchase}
				editable
				totalPaid={totalPaid}
				taxAmount={taxAmount}
				lines={[draft("Capacitor", { quantity: "2", unit_price: "24.99" })]}
				onChange={vi.fn()}
			/>
		);

	test("says nothing while the lines plus tax add up to what was paid", () => {
		withPaid(49.98);
		expect(screen.queryByText(/don't add up/i)).toBeNull();
	});

	test("names the gap when they do not, on a draft the server still has at zero", () => {
		withPaid(80, 4);
		expect(screen.getByText(/don't add up/i).textContent).toContain("$26.02");
	});

	test("names an overshoot as its own thing, not a shortfall", () => {
		withPaid(30);
		expect(screen.getByText(/don't add up/i).textContent).toContain(" over.");
	});

	test("holds off until there is a total to check against", () => {
		withPaid(0);
		expect(screen.queryByText(/don't add up/i)).toBeNull();
	});
});

describe("the receipt-transcription path", () => {
	// Four fields, in the order the paper reads. Everything else is one tap away.
	test("keeps description, qty, price and the job flat", () => {
		render(<Harness initial={[draft("Capacitor")]} jobs={TWO_JOBS} />);

		expect(
			screen.getByPlaceholderText("Part as it reads on the receipt")
		).toBeVisible();
		expect(screen.getByLabelText("Qty")).toBeVisible();
		expect(screen.getByLabelText("Unit price")).toBeVisible();
		expect(screen.getByLabelText("Job")).toBeVisible();
	});

	test("folds stock and billing away", () => {
		render(<Harness initial={[draft("Capacitor")]} />);

		expect(screen.getByRole("button", { name: /stock & billing/i })).toHaveAttribute(
			"aria-expanded",
			"false"
		);
		expect(screen.queryByLabelText(/what happened to it/i)).toBeNull();
		expect(screen.queryByLabelText(/catalog item for this line/i)).toBeNull();
	});

	test("gives every line its own disclosure", () => {
		render(<Harness initial={[draft("Capacitor"), draft("Contactor")]} />);

		expect(screen.getAllByRole("button", { name: /stock & billing/i })).toHaveLength(2);
	});

	test("still edits the disposition through it", async () => {
		render(<Harness initial={[draft("Capacitor")]} />);

		const toggle = screen.getByRole("button", { name: /stock & billing/i });
		await userEvent.click(toggle);
		await userEvent.selectOptions(
			screen.getByLabelText(/what happened to it/i),
			"receive"
		);
		expect(within(toggle).getByText("To Warehouse")).toBeInTheDocument();
	});
});

describe("stock & billing for all lines", () => {
	const TRUCK = { id: "veh-1", name: "Truck 12" };

	/** Owns the sheet's answer the way the page does: picking it moves the followers. */
	function BulkHarness({
		initial,
		def = { disposition: "non_stock", vehicleId: "" },
		editable = true,
		onLines,
	}: {
		initial: LineDraft[];
		def?: SheetDisposition;
		editable?: boolean;
		onLines?: (l: LineDraft[]) => void;
	}) {
		const [lines, setLines] = useState(initial);
		const [sheet, setSheet] = useState(def);
		const set = (l: LineDraft[]) => {
			setLines(l);
			onLines?.(l);
		};
		return (
			<PurchaseLineEditor
				purchase={purchase}
				editable={editable}
				lines={lines}
				onChange={set}
				myVehicle={TRUCK}
				sheetDisposition={sheet}
				onSheetDispositionChange={(d) => {
					setSheet(d);
					set(applySheetDisposition(lines, d));
				}}
			/>
		);
	}

	const bar = () => screen.getByRole("radiogroup", { name: /all items/i });
	const summaries = () =>
		screen
			.getAllByRole("button", { name: /stock & billing/i })
			.map((b) => b.textContent ?? "");

	test("one press moves every following line", async () => {
		const user = userEvent.setup();
		const onLines = vi.fn();
		render(<BulkHarness initial={[draft("A"), draft("B")]} onLines={onLines} />);
		await user.click(within(bar()).getByRole("radio", { name: "Added to stock" }));
		const last = onLines.mock.calls.at(-1)![0] as LineDraft[];
		expect(last.map((l) => [l.disposition, l.disposition_vehicle_id])).toEqual([
			["receive", "veh-1"],
			["receive", "veh-1"],
		]);
		expect(summaries().every((t) => /Truck 12/.test(t) && /all items/.test(t))).toBe(true);
	});

	test("a line set on its own keeps its answer through a bulk change", async () => {
		const user = userEvent.setup();
		const onLines = vi.fn();
		render(
			<BulkHarness
				initial={[
					draft("A"),
					draft("B", {
						disposition: "receive",
						disposition_vehicle_id: "",
						dispositionPinned: true,
					}),
				]}
				onLines={onLines}
			/>
		);
		expect(screen.getByText(/1 item set separately/)).toBeInTheDocument();
		await user.click(within(bar()).getByRole("radio", { name: "Added to stock" }));
		const last = onLines.mock.calls.at(-1)![0] as LineDraft[];
		expect(last[1]).toMatchObject({ disposition_vehicle_id: "", dispositionPinned: true });
		expect(last[0]).toMatchObject({ disposition_vehicle_id: "veh-1" });
	});

	test("answering on the line pins it; Make all match lets it go", async () => {
		const user = userEvent.setup();
		const onLines = vi.fn();
		render(<BulkHarness initial={[draft("A"), draft("B")]} onLines={onLines} />);
		await user.click(screen.getAllByRole("button", { name: /stock & billing/i })[1]!);
		// The select is the native one; the catalog picker is a combobox too.
		const select = screen
			.getAllByRole("combobox")
			.find((el) => el.tagName === "SELECT")!;
		await user.selectOptions(select, "receive");
		expect((onLines.mock.calls.at(-1)![0] as LineDraft[])[1]!.dispositionPinned).toBe(true);
		expect(summaries()[1]).toMatch(/this item/);
		await user.click(screen.getByRole("button", { name: "Make all match" }));
		const last = onLines.mock.calls.at(-1)![0] as LineDraft[];
		expect(last[1]).toMatchObject({ disposition: "non_stock", dispositionPinned: false });
		expect(screen.queryByText(/set separately/)).not.toBeInTheDocument();
	});

	test("a line added takes the sheet's answer", async () => {
		const user = userEvent.setup();
		const onLines = vi.fn();
		render(
			<BulkHarness
				initial={[
					draft("A", { disposition: "receive", disposition_vehicle_id: "veh-1" }),
					draft("B", { disposition: "receive", disposition_vehicle_id: "veh-1" }),
				]}
				def={{ disposition: "receive", vehicleId: "veh-1" }}
				onLines={onLines}
			/>
		);
		await user.click(screen.getByRole("button", { name: /add item/i }));
		const last = onLines.mock.calls.at(-1)![0] as LineDraft[];
		expect(last[2]).toMatchObject({ disposition: "receive", disposition_vehicle_id: "veh-1" });
	});

	test("a stock answer leaves a discount line on the job and says so", async () => {
		const user = userEvent.setup();
		const onLines = vi.fn();
		render(
			<BulkHarness
				initial={[draft("A"), draft("Promo", { unit_price: "-5" })]}
				onLines={onLines}
			/>
		);
		await user.click(within(bar()).getByRole("radio", { name: "Added to stock" }));
		const last = onLines.mock.calls.at(-1)![0] as LineDraft[];
		expect(last[1]).toMatchObject({ disposition: "non_stock", dispositionPinned: false });
		expect(screen.getByText(/1 discount stays on the job/)).toBeInTheDocument();
	});

	test("no bar for a single line", () => {
		render(<BulkHarness initial={[draft("A")]} />);
		expect(screen.queryByRole("radiogroup", { name: /all items/i })).not.toBeInTheDocument();
	});

	test("read-only: one sentence instead of the controls", () => {
		render(
			<BulkHarness
				editable={false}
				initial={[
					draft("A"),
					draft("B", { disposition: "receive", disposition_vehicle_id: "veh-1" }),
					draft("C"),
				]}
			/>
		);
		expect(screen.queryByRole("radiogroup", { name: /all items/i })).not.toBeInTheDocument();
		expect(
			screen.getByText("2 consumed on job · 1 added to Truck 12")
		).toBeInTheDocument();
	});
});
