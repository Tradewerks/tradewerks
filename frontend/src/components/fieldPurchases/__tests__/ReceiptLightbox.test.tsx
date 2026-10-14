import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReceiptLightbox from "../ReceiptLightbox";

const setup = (over: Record<string, unknown> = {}) => {
	const onClose = vi.fn();
	const onRotate = vi.fn();
	render(
		<ReceiptLightbox
			url="https://bucket/r.jpg"
			label="Receipt from Dana Ruiz"
			rotation={0}
			onRotate={onRotate}
			onClose={onClose}
			{...over}
		/>
	);
	return { onClose, onRotate };
};

const image = () => screen.getByRole("img", { name: /receipt from dana ruiz/i });

describe("ReceiptLightbox", () => {
	it("is a labelled modal dialog", () => {
		setup();
		expect(
			screen.getByRole("dialog", { name: /receipt from dana ruiz/i })
		).toHaveAttribute("aria-modal", "true");
	});

	// Fit WIDTH, not fit height: a receipt is tall and narrow, and the text is
	// only legible once it spans the screen.
	it("opens at fit-width", () => {
		setup();
		expect(image().style.width).toBe("100%");
	});

	it("closes from the close button", async () => {
		const { onClose } = setup();
		await userEvent.click(screen.getByRole("button", { name: /^close$/i }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("closes on Escape", async () => {
		const { onClose } = setup();
		await userEvent.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("asks the caller to rotate rather than rotating itself", async () => {
		const { onRotate } = setup();
		await userEvent.click(screen.getByRole("button", { name: /rotate/i }));
		expect(onRotate).toHaveBeenCalledOnce();
	});

	it("renders the caller's rotation", () => {
		setup({ rotation: 90 });
		expect(image().style.transform).toContain("rotate(90deg)");
	});

	it("zooms in and back out from the controls", async () => {
		setup();
		await userEvent.click(screen.getByRole("button", { name: /zoom in/i }));
		expect(image().style.width).not.toBe("100%");
		await userEvent.click(screen.getByRole("button", { name: /zoom out/i }));
		expect(image().style.width).toBe("100%");
	});

	it("cannot zoom out below fit-width", () => {
		setup();
		expect(screen.getByRole("button", { name: /zoom out/i })).toBeDisabled();
	});

	it("gives every control a 44px target", () => {
		setup();
		for (const name of [/^close$/i, /rotate/i, /zoom in/i, /zoom out/i]) {
			expect(screen.getByRole("button", { name })).toHaveClass("h-11");
		}
	});
});
