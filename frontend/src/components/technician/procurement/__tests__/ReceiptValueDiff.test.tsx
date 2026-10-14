/**
 * The receipt is the source of truth, but the technician is the verifier of record.
 * Extraction therefore never overwrites a value they entered, so a disagreement
 * surfaces instead of being resolved silently in extraction's favour with the
 * receipt's own reading thrown away. This is where the two are put side by side.
 */
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "../../../../test/testUtils";
import { describe, expect, test, vi } from "vitest";
import ReceiptValueDiff from "../ReceiptValueDiff";

describe("ReceiptValueDiff", () => {
	test("says nothing when the receipt was never read for this field", () => {
		const { container } = render(
			<ReceiptValueDiff label="Vendor" entered="Ferguson" receipt={null} onUse={vi.fn()} />,
		);
		expect(container.textContent).toBe("");
	});

	test("says nothing when the two already agree", () => {
		const { container } = render(
			<ReceiptValueDiff
				label="Vendor"
				entered=" Ferguson "
				receipt="Ferguson"
				onUse={vi.fn()}
			/>,
		);
		expect(container.textContent).toBe("");
	});

	test("shows the receipt's reading when they disagree", () => {
		render(
			<ReceiptValueDiff
				label="Vendor"
				entered="Fergusen"
				receipt="Ferguson HVAC Supply"
				onUse={vi.fn()}
			/>,
		);
		expect(screen.getByText(/Ferguson HVAC Supply/)).toBeTruthy();
	});

	test("leaves the technician's value alone until they take the receipt's", async () => {
		const onUse = vi.fn();
		const user = userEvent.setup();
		render(
			<ReceiptValueDiff
				label="Vendor"
				entered="Fergusen"
				receipt="Ferguson HVAC Supply"
				onUse={onUse}
			/>,
		);

		expect(onUse).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /use the receipt's vendor/i }));
		expect(onUse).toHaveBeenCalledWith("Ferguson HVAC Supply");
	});

	// Flagged on the entry path, not only in the dispatcher's panel after submit:
	// the technician is the one holding the paper.
	test("marks a field the provider was unsure of, agreement or not", () => {
		render(
			<ReceiptValueDiff
				label="Tax"
				entered="4.27"
				receipt="4.27"
				confidence={0.62}
				onUse={vi.fn()}
			/>,
		);
		expect(screen.getByText(/low confidence/i)).toBeTruthy();
	});

	/**
	 * The receipt-details section renders on every status past submit, where the
	 * inputs beside this are disabled. A live "use it" there mutates a disabled
	 * field and marks the sheet dirty on a record nobody may edit.
	 */
	test("offers no way to take the value on a purchase that can no longer be edited", () => {
		render(
			<ReceiptValueDiff
				label="Vendor"
				entered="Fergusen"
				receipt="Ferguson HVAC Supply"
				editable={false}
				onUse={vi.fn()}
			/>,
		);
		// Still says what the receipt read - that is a fact about the record.
		expect(screen.getByText(/Ferguson HVAC Supply/)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	/**
	 * Money is compared as money. "24.9" and "24.90" are the same amount, and
	 * nagging about the difference teaches technicians to ignore the marker.
	 */
	test("does not call a money value different when only its formatting is", () => {
		const { container } = render(
			<ReceiptValueDiff
				label="total"
				entered="24.9"
				receipt="24.90"
				numeric
				onUse={vi.fn()}
			/>,
		);
		expect(container.textContent).toBe("");
	});

	test("still flags money that really is different", () => {
		render(
			<ReceiptValueDiff label="total" entered="24.90" receipt="80.00" numeric onUse={vi.fn()} />,
		);
		expect(screen.getByRole("button", { name: /use the receipt's total/i })).toBeTruthy();
	});

	test("treats a blank money field as something the receipt can fill", () => {
		render(<ReceiptValueDiff label="total" entered="" receipt="80.00" numeric onUse={vi.fn()} />);
		expect(screen.getByRole("button", { name: /use the receipt's total/i })).toBeTruthy();
	});

	/**
	 * Taking the value unmounts the button that was just pressed. Without this
	 * focus falls to <body> and a keyboard or screen-reader user is dropped back
	 * at the top of the page.
	 */
	test("hands focus to the field it just filled", async () => {
		const user = userEvent.setup();
		function Harness() {
			const [value, setValue] = useState("Fergusen");
			return (
				<>
					<ReceiptValueDiff
						label="Vendor"
						entered={value}
						receipt="Ferguson HVAC Supply"
						controlId="vendor-input"
						onUse={setValue}
					/>
					<input id="vendor-input" readOnly value={value} />
				</>
			);
		}
		render(<Harness />);

		await user.click(screen.getByRole("button", { name: /use the receipt's vendor/i }));
		expect(document.activeElement).toBe(document.getElementById("vendor-input"));
	});

	test("stays quiet about a field the provider was sure of", () => {
		render(
			<ReceiptValueDiff
				label="Tax"
				entered="4.27"
				receipt="4.27"
				confidence={0.98}
				onUse={vi.fn()}
			/>,
		);
		expect(screen.queryByText(/low confidence/i)).toBeNull();
	});
});
