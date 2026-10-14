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
import { blankLine, type ExtractedReceiptLine, type LineDraft } from "../lineDrafts";
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

/** Only `ocr_status` and `ocr_line_count` are read off the purchase here. */
const purchase = { ocr_status: "skipped", ocr_line_count: null } as unknown as FieldPurchase;

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

		await user.click(screen.getAllByLabelText("Remove line")[0]!);

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

		await user.click(screen.getAllByLabelText("Remove line")[0]!);

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

		const select = screen.getByLabelText("Which job it was for") as HTMLSelectElement;
		expect(select.value).toBe("a");
		await user.selectOptions(select, "b");
		expect(
			(screen.getByLabelText("Which job it was for") as HTMLSelectElement).value
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
			"Which job it was for"
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

		expect(screen.getByText(/1 line still needs a job/i)).toBeTruthy();
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
			"2 lines read with low confidence — check them against the paper."
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
			"1 line read with low confidence — check it against the paper."
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
			screen.getByRole("button", { name: /2 lines read from the receipt/i })
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
		expect(screen.getByText(/1 line still to check against the paper/i)).toBeTruthy();
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
		expect(statusText()).toMatch(/2 lines read from the receipt/i);
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
		expect(screen.queryByText(/do not add up/i)).toBeNull();
	});

	test("names the gap when they do not, on a draft the server still has at zero", () => {
		withPaid(80, 4);
		expect(screen.getByText(/do not add up/i).textContent).toContain("$26.02");
	});

	test("names an overshoot as its own thing, not a shortfall", () => {
		withPaid(30);
		expect(screen.getByText(/do not add up/i).textContent).toContain("unaccounted for");
	});

	test("holds off until there is a total to check against", () => {
		withPaid(0);
		expect(screen.queryByText(/do not add up/i)).toBeNull();
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
		expect(screen.getByLabelText("Which job it was for")).toBeVisible();
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
