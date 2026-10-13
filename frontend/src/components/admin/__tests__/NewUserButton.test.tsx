import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import NewUserButton from "../NewUserButton";

function setup(canCreateTechnician: boolean, canCreateDispatcher: boolean) {
	const onCreateTechnician = vi.fn();
	const onCreateDispatcher = vi.fn();
	const utils = render(
		<NewUserButton
			canCreateTechnician={canCreateTechnician}
			canCreateDispatcher={canCreateDispatcher}
			onCreateTechnician={onCreateTechnician}
			onCreateDispatcher={onCreateDispatcher}
		/>
	);
	return { ...utils, onCreateTechnician, onCreateDispatcher };
}

describe("NewUserButton", () => {
	it("renders nothing without either permission", () => {
		const { container } = setup(false, false);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders a direct technician button with only that permission", () => {
		const { onCreateTechnician } = setup(true, false);
		fireEvent.click(screen.getByRole("button", { name: "New technician" }));
		expect(onCreateTechnician).toHaveBeenCalled();
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("renders a direct dispatcher button with only that permission", () => {
		const { onCreateDispatcher } = setup(false, true);
		fireEvent.click(screen.getByRole("button", { name: "New dispatcher" }));
		expect(onCreateDispatcher).toHaveBeenCalled();
	});

	it("with both permissions opens a menu and creates the chosen type", () => {
		const { onCreateDispatcher } = setup(true, true);
		const trigger = screen.getByRole("button", { name: "New user" });
		expect(trigger).toHaveAttribute("aria-haspopup", "menu");
		fireEvent.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("menuitem", { name: "Technician" })).toHaveFocus();
		fireEvent.click(screen.getByRole("menuitem", { name: "Dispatcher" }));
		expect(onCreateDispatcher).toHaveBeenCalled();
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("arrow keys move between items and Escape closes back to the trigger", () => {
		setup(true, true);
		const trigger = screen.getByRole("button", { name: "New user" });
		fireEvent.click(trigger);
		fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
		expect(screen.getByRole("menuitem", { name: "Dispatcher" })).toHaveFocus();
		fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
		expect(screen.getByRole("menuitem", { name: "Technician" })).toHaveFocus();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("menu")).toBeNull();
		expect(trigger).toHaveFocus();
	});

	it("closes on outside click", () => {
		setup(true, true);
		fireEvent.click(screen.getByRole("button", { name: "New user" }));
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole("menu")).toBeNull();
	});
});
