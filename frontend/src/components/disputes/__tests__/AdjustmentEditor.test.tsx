import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AdjustmentEditor from "../AdjustmentEditor";
import { blankAdjustmentLine, draftFromLineItem, type DisputeLineItem } from "../adjustmentDraft";

const lines: DisputeLineItem[] = [
	{
		id: "li1",
		name: "Compressor replacement",
		total: 450,
		unit_price: 450,
		source_job_id: "job-1",
		tax_group_id: "tg-1",
		tax_group: { name: "NY State" },
		taxable: true,
	},
	{ id: "li2", name: "Travel", total: 50, unit_price: 50 },
];

describe("AdjustmentEditor", () => {
	/** The anchor defect: the editor used to credit lines it never showed. */
	it("lists the document's lines with their totals", () => {
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[blankAdjustmentLine()]}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("Compressor replacement")).toBeInTheDocument();
		expect(screen.getByText("$450.00")).toBeInTheDocument();
		expect(screen.getByText("Travel")).toBeInTheDocument();
	});

	it("credits a picked line at that line's price, replacing an untouched starter row", () => {
		const onChange = vi.fn();
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[blankAdjustmentLine()]}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getAllByRole("button", { name: /credit this line/i })[0]!);

		expect(onChange).toHaveBeenCalledTimes(1);
		const next = onChange.mock.calls[0]![0];
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({
			kind: "credit",
			originLineId: "li1",
			unitPrice: "450",
			taxGroupId: "tg-1",
			sourceJobId: "job-1",
		});
	});

	it("appends rather than replaces once a row has been worked on", () => {
		const onChange = vi.fn();
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[draftFromLineItem(lines[1]!)]}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: /credit this line/i }));

		expect(onChange.mock.calls[0]![0]).toHaveLength(2);
	});

	it("marks a line already in the draft as added and stops it being added twice", () => {
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[draftFromLineItem(lines[0]!)]}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByRole("button", { name: /added/i })).toBeDisabled();
	});

	/** P0-2: a seeded row and a hand-typed row used to look identical. */
	it("says what a seeded row credits and what it inherits", () => {
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[draftFromLineItem(lines[0]!)]}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText(/credits Compressor replacement/i)).toBeInTheDocument();
		expect(screen.getByText(/NY State/)).toBeInTheDocument();
	});

	it("marks a manual row as using the default tax group", () => {
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[blankAdjustmentLine()]}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText(/manual line/i)).toBeInTheDocument();
	});

	/** P0-3: direction is a toggle, not a sign the dispatcher has to know. */
	it("switches a row between credit and charge", () => {
		const onChange = vi.fn();
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[draftFromLineItem(lines[0]!)]}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: "Charge" }));

		expect(onChange.mock.calls[0]![0][0].kind).toBe("charge");
	});

	it("shows the row total with the direction's sign", () => {
		// Two rows so the row total is distinguishable from the net below it:
		// one credit of 450 renders the same string in both places.
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[
					draftFromLineItem(lines[0]!),
					draftFromLineItem(lines[1]!),
				]}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("-$450.00")).toBeInTheDocument();
		expect(screen.getByText("-$500.00")).toBeInTheDocument();
	});

	it("shows a charge row total as positive", () => {
		// A single charge row of $450 renders "$450.00" three times: the
		// picker's line total, the row total, and the net footer (net equals
		// the one row's total here). aria-live="polite" is unique to the row
		// total span, so scoping on it — rather than widening to
		// getAllByText — keeps this an assertion on the row, not on whichever
		// of the three elements happens to match first.
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[{ ...draftFromLineItem(lines[0]!), kind: "charge" }]}
				onChange={vi.fn()}
			/>
		);

		expect(
			screen.getByText("$450.00", { selector: "span[aria-live='polite']" })
		).toBeInTheDocument();
	});

	it("names the one problem with a row", () => {
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[{ ...draftFromLineItem(lines[0]!), name: "" }]}
				onChange={vi.fn()}
			/>
		);

		expect(screen.getByText("Add a description")).toBeInTheDocument();
	});

	it("adds a blank manual row", () => {
		const onChange = vi.fn();
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[draftFromLineItem(lines[0]!)]}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getByRole("button", { name: /add line/i }));

		const next = onChange.mock.calls[0]![0];
		expect(next).toHaveLength(2);
		expect(next[1]).toMatchObject({ kind: "credit", originLineId: null, name: "" });
	});

	/** P2-4: four unlabelled boxes in a row. */
	it("labels its columns", () => {
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[blankAdjustmentLine()]}
				onChange={vi.fn()}
			/>
		);

		for (const heading of ["Description", "Qty", "Unit price", "Total"]) {
			expect(screen.getByText(heading)).toBeInTheDocument();
		}
	});

	it("states the consequence in the dispatcher's words", () => {
		const { rerender } = render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[draftFromLineItem(lines[0]!)]}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getByText(/credited \$450\.00/i)).toBeInTheDocument();

		rerender(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[{ ...draftFromLineItem(lines[0]!), kind: "charge" }]}
				onChange={vi.fn()}
			/>
		);
		expect(screen.getByText(/charged an extra \$450\.00/i)).toBeInTheDocument();
	});

	it("removes a row", () => {
		const onChange = vi.fn();
		render(
			<AdjustmentEditor
				lineItems={lines}
				drafts={[
					draftFromLineItem(lines[0]!),
					draftFromLineItem(lines[1]!),
				]}
				onChange={onChange}
			/>
		);

		fireEvent.click(screen.getAllByRole("button", { name: /remove line/i })[0]!);

		expect(onChange.mock.calls[0]![0]).toHaveLength(1);
	});
});
