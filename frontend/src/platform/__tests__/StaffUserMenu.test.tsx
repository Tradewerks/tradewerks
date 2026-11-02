import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StaffUserMenu from "../components/StaffUserMenu";
import { usePlatformAuth } from "../store";
import { useThemeStore } from "../../stores/themeStore";

const renderMenu = (onSignOut = vi.fn()) => {
	render(
		<MemoryRouter>
			<StaffUserMenu onSignOut={onSignOut} />
		</MemoryRouter>
	);
	return onSignOut;
};

const open = () => fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

beforeEach(() => {
	usePlatformAuth.setState({
		token: "t",
		staff: { id: "s-1", email: "sam@tw.com", name: "Sam" },
		notice: null,
	});
	useThemeStore.setState({ theme: "system" });
});

describe("StaffUserMenu", () => {
	it("shows the staff initial and opens on click", () => {
		renderMenu();
		const trigger = screen.getByRole("button", { name: "Account menu" });
		expect(trigger).toHaveTextContent("S");
		open();
		expect(screen.getByText("sam@tw.com")).toBeInTheDocument();
		expect(screen.getByText("TradeWerks staff")).toBeInTheDocument();
	});

	it("Sign out calls onSignOut and closes", () => {
		const onSignOut = renderMenu();
		open();
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		expect(onSignOut).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("sam@tw.com")).toBeNull();
	});

	it("Escape and outside mousedown close the menu", () => {
		renderMenu();
		open();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByText("sam@tw.com")).toBeNull();
		open();
		expect(screen.getByText("sam@tw.com")).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByText("sam@tw.com")).toBeNull();
	});

	it("Theme choice writes the theme store", () => {
		renderMenu();
		open();
		fireEvent.click(screen.getByRole("button", { name: "Theme" }));
		fireEvent.click(screen.getByRole("button", { name: "Light" }));
		expect(useThemeStore.getState().theme).toBe("light");
	});
});
