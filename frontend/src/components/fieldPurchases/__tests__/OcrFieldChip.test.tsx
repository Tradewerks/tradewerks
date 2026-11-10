import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OcrFieldChip } from "../OcrFieldChip";
import { ocrFlagReason } from "../ocrFlagCopy";

const unsure = { kind: "unsure", confidence: 0.612, rule: null } as const;

describe("OcrFieldChip", () => {
	it("renders kind label and reveals reason on click", async () => {
		render(<OcrFieldChip field="total" flag={unsure} />);
		const chip = screen.getByRole("button", { name: /unsure/i });
		expect(chip).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
		await userEvent.click(chip);
		expect(chip).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(/61% sure/);
	});

	it("exposes the reason through aria-describedby even when closed", () => {
		render(<OcrFieldChip field="total" flag={unsure} />);
		const chip = screen.getByRole("button");
		const id = chip.getAttribute("aria-describedby");
		expect(id).toBeTruthy();
		expect(document.getElementById(id!)).toHaveTextContent(/61% sure/);
	});

	it("Enter and Space open, Escape closes", async () => {
		const user = userEvent.setup();
		render(<OcrFieldChip field="total" flag={unsure} />);
		const chip = screen.getByRole("button");
		chip.focus();
		await user.keyboard("{Enter}");
		expect(chip).toHaveAttribute("aria-expanded", "true");
		await user.keyboard("{Escape}");
		expect(chip).toHaveAttribute("aria-expanded", "false");
		await user.keyboard(" ");
		expect(chip).toHaveAttribute("aria-expanded", "true");
		await user.keyboard("{Escape}");
		expect(chip).toHaveAttribute("aria-expanded", "false");
	});

	it("tap outside closes", async () => {
		render(
			<div>
				<span>elsewhere</span>
				<OcrFieldChip field="total" flag={unsure} />
			</div>
		);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
		fireEvent.pointerDown(screen.getByText("elsewhere"));
		expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
	});

	it("hover opens and unhover closes when not pinned", async () => {
		const user = userEvent.setup();
		render(<OcrFieldChip field="total" flag={unsure} />);
		const chip = screen.getByRole("button");
		await user.hover(chip);
		expect(chip).toHaveAttribute("aria-expanded", "true");
		await user.unhover(chip);
		expect(chip).toHaveAttribute("aria-expanded", "false");
	});

	it("a click-pinned popover survives unhover", async () => {
		const user = userEvent.setup();
		render(<OcrFieldChip field="total" flag={unsure} />);
		const chip = screen.getByRole("button");
		await user.click(chip);
		await user.unhover(chip);
		expect(chip).toHaveAttribute("aria-expanded", "true");
	});

	it("resolved review explains itself instead of prompting a check", async () => {
		render(<OcrFieldChip field="total" flag={unsure} review="edited" />);
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(
			/changed by the technician/i
		);
	});

	it("resolved review shows Checked by tech, muted", () => {
		render(<OcrFieldChip field="total" flag={unsure} review="confirmed" />);
		const chip = screen.getByRole("button", { name: /checked by tech/i });
		expect(chip.className).toMatch(/text-text-muted|text-text-faint/);
		expect(chip.className).not.toMatch(/warning/);
	});

	it("edited review shows Edited by tech", () => {
		render(<OcrFieldChip field="total" flag={unsure} review="edited" />);
		expect(screen.getByRole("button", { name: /edited by tech/i })).toBeInTheDocument();
	});

	it("on the technician's own screen a resolved chip drops the 'by tech'", async () => {
		const { rerender } = render(
			<OcrFieldChip field="total" flag={unsure} review="confirmed" audience="technician" />
		);
		expect(screen.getByRole("button", { name: /^checked$/i })).toBeInTheDocument();
		rerender(<OcrFieldChip field="total" flag={unsure} review="edited" audience="technician" />);
		expect(screen.getByRole("button", { name: /^edited$/i })).toBeInTheDocument();
		expect(screen.queryByText(/by tech/i)).toBeNull();
		await userEvent.click(screen.getByRole("button"));
		expect(screen.getByRole("tooltip", { hidden: true })).not.toHaveTextContent(/technician/i);
	});

	it("not found shows its label and reason", async () => {
		render(
			<OcrFieldChip
				field="vendor_name"
				flag={{ kind: "not_found", confidence: null, rule: null }}
			/>
		);
		await userEvent.click(screen.getByRole("button", { name: /not found/i }));
		expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(
			/not on the receipt/i
		);
	});
});

describe("ocrFlagReason", () => {
	it("unsure read shows rounded percent", () => {
		expect(
			ocrFlagReason("total", { kind: "unsure", confidence: 0.746, rule: null })
		).toMatch(/75% sure/);
	});
	it("unsure rule names the chain", () => {
		expect(
			ocrFlagReason("vendor_name", {
				kind: "unsure",
				confidence: null,
				rule: "Home Depot",
			})
		).toMatch(/Home Depot receipt layout/);
	});
	it("a rule-picked field names the rule, not its synthetic confidence", () => {
		const reason = ocrFlagReason("receipt_number", {
			kind: "unsure",
			confidence: 0.8,
			rule: "Home Depot",
		});
		expect(reason).toMatch(/Home Depot receipt layout/);
		expect(reason).not.toMatch(/%/);
	});
	it("a handwritten value says it was handwritten, not a receipt layout", () => {
		const reason = ocrFlagReason("total", {
			kind: "unsure",
			confidence: 0.88,
			rule: "handwritten",
		});
		expect(reason).toMatch(/handwritten on the receipt/i);
		expect(reason).not.toMatch(/layout/);
	});
	it("calculated total says subtotal + tax", () => {
		expect(
			ocrFlagReason("total", { kind: "calculated", confidence: null, rule: null })
		).toMatch(/subtotal \+ tax/);
	});
	it("calculated subtotal says total minus tax", () => {
		expect(
			ocrFlagReason("subtotal", {
				kind: "calculated",
				confidence: null,
				rule: null,
			})
		).toMatch(/total minus tax/);
	});
	it("calculated elsewhere is generic", () => {
		expect(
			ocrFlagReason("tax_amount", {
				kind: "calculated",
				confidence: null,
				rule: null,
			})
		).toMatch(/not read/);
	});
});
