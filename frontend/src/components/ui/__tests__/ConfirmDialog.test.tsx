import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConfirmDialog from "../ConfirmDialog";

const renderDialog = (onConfirm: () => void | Promise<unknown>, pending = false) =>
	render(
		<ConfirmDialog
			open
			title="Apply"
			body="Body"
			confirmLabel="Apply change"
			pending={pending}
			onConfirm={onConfirm}
			onCancel={() => {}}
		/>
	);

describe("ConfirmDialog", () => {
	it("confirms again after onConfirm refused without starting work", async () => {
		const onConfirm = vi.fn();
		renderDialog(onConfirm);
		const button = screen.getByRole("button", { name: "Apply change" });
		fireEvent.click(button);
		await act(async () => {});
		fireEvent.click(button);
		expect(onConfirm).toHaveBeenCalledTimes(2);
	});

	it("ignores a second click while an async onConfirm is still running", async () => {
		let finish!: () => void;
		const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)));
		renderDialog(onConfirm);
		const button = screen.getByRole("button", { name: "Apply change" });
		fireEvent.click(button);
		await act(async () => {});
		fireEvent.click(button);
		expect(onConfirm).toHaveBeenCalledTimes(1);
		await act(async () => finish());
		fireEvent.click(button);
		expect(onConfirm).toHaveBeenCalledTimes(2);
	});
});
