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
			<ReceiptValueDiff
				label="Vendor"
				entered="Ferguson"
				receipt={null}
				onUse={vi.fn()}
			/>
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
			/>
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
			/>
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
			/>
		);

		expect(onUse).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: /use the receipt's vendor/i }));
		expect(onUse).toHaveBeenCalledWith("Ferguson HVAC Supply");
	});

	// Flagged on the entry path, not only in the dispatcher's panel after submit:
	// the technician is the one holding the paper.
	test("shows a chip for a flagged field and Looks right resolves it", async () => {
		const onConfirm = vi.fn();
		const user = userEvent.setup();
		render(
			<ReceiptValueDiff
				label="Tax"
				field="tax_amount"
				entered="4.27"
				receipt="4.27"
				flag={{ kind: "unsure", confidence: 0.62, rule: null }}
				onConfirm={onConfirm}
				onUse={vi.fn()}
			/>
		);
		expect(screen.getByText("Unsure")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: /looks right.*tax/i }));
		expect(onConfirm).toHaveBeenCalled();
	});

	test("a resolved field keeps its chip but loses the button", () => {
		render(
			<ReceiptValueDiff
				label="Tax"
				field="tax_amount"
				entered="4.27"
				receipt="4.27"
				flag={{ kind: "unsure", confidence: 0.62, rule: null }}
				review="confirmed"
				onConfirm={vi.fn()}
				onUse={vi.fn()}
			/>
		);
		// The technician's own screen: "by tech" would be speaking about them to them.
		expect(screen.getByText("Checked")).toBeTruthy();
		expect(screen.queryByText("Checked by tech")).toBeNull();
		expect(screen.queryByRole("button", { name: /looks right/i })).toBeNull();
		expect(screen.queryByText(/low confidence/i)).toBeNull();
	});

	test("Looks right stays on a field the technician can confirm but not change", () => {
		const onConfirm = vi.fn();
		render(
			<ReceiptValueDiff
				label="Vendor"
				field="vendor_name"
				entered="Ferguson"
				receipt="Ferguson"
				flag={{ kind: "unsure", confidence: 0.6, rule: null }}
				editable={false}
				confirmable
				onConfirm={onConfirm}
				onUse={vi.fn()}
			/>
		);
		expect(screen.getByRole("button", { name: /looks right/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /use the receipt/i })).toBeNull();
	});

	test("not_found is a chip only, never a Looks right", () => {
		render(
			<ReceiptValueDiff
				label="Tax"
				field="tax_amount"
				entered=""
				receipt={null}
				flag={{ kind: "not_found", confidence: null, rule: null }}
				onConfirm={vi.fn()}
				onUse={vi.fn()}
			/>
		);
		expect(screen.getByText("Not found")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /looks right/i })).toBeNull();
	});

	test("no Looks right on a purchase that can no longer be edited", () => {
		render(
			<ReceiptValueDiff
				label="Tax"
				field="tax_amount"
				entered="4.27"
				receipt="4.27"
				flag={{ kind: "unsure", confidence: 0.62, rule: null }}
				editable={false}
				onConfirm={vi.fn()}
				onUse={vi.fn()}
			/>
		);
		expect(screen.getByText("Unsure")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /looks right/i })).toBeNull();
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
			/>
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
			/>
		);
		expect(container.textContent).toBe("");
	});

	test("still flags money that really is different", () => {
		render(
			<ReceiptValueDiff
				label="total"
				entered="24.90"
				receipt="80.00"
				numeric
				onUse={vi.fn()}
			/>
		);
		expect(
			screen.getByRole("button", { name: /use the receipt's total/i })
		).toBeTruthy();
	});

	test("treats a blank money field as something the receipt can fill", () => {
		render(
			<ReceiptValueDiff
				label="total"
				entered=""
				receipt="80.00"
				numeric
				onUse={vi.fn()}
			/>
		);
		expect(
			screen.getByRole("button", { name: /use the receipt's total/i })
		).toBeTruthy();
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
});
