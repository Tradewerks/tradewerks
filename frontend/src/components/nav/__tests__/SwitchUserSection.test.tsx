import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SwitchUserSection from "../SwitchUserSection";
import { useAuthStore } from "../../../auth/authStore";
import { useRememberedAccountsStore } from "../../../stores/rememberedAccountsStore";

vi.mock("../../../api/authenticate", () => ({ logoutBeacon: vi.fn() }));

const remember = (userId: string, email: string, orgName: string) => ({
	userId,
	email,
	name: email.split("@")[0],
	role: "dispatcher" as const,
	orgId: `org-${userId}`,
	orgName,
	lastUsedAt: 1,
});

const replace = vi.fn();

const renderSection = () =>
	render(
		<MemoryRouter>
			<SwitchUserSection />
		</MemoryRouter>,
	);

describe("SwitchUserSection", () => {
	beforeEach(() => {
		localStorage.clear();
		replace.mockClear();
		vi.stubGlobal("location", { ...window.location, replace });
		useAuthStore.setState({
			user: {
				role: "dispatcher",
				name: "me@epichvac.com",
				userId: "me",
				orgId: "org-me",
				orgTimezone: "America/Chicago",
				permissions: [],
			},
		});
		useRememberedAccountsStore.setState({
			accounts: [
				remember("me", "me@epichvac.com", "Epic HVAC"),
				remember("a", "owner@bluepipe.test", "Bluepipe"),
				remember("b", "owner@greenleaf.test", "Greenleaf"),
			],
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const expand = async () =>
		userEvent.click(screen.getByRole("button", { name: /switch user/i }));

	it("reports its expanded state", async () => {
		renderSection();
		const toggle = screen.getByRole("button", { name: /switch user/i });
		expect(toggle).toHaveAttribute("aria-expanded", "false");

		await userEvent.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
	});

	it("lists other accounts by full email so shared local parts stay distinct", async () => {
		renderSection();
		await expand();

		expect(screen.getByText("owner@bluepipe.test")).toBeInTheDocument();
		expect(screen.getByText("owner@greenleaf.test")).toBeInTheDocument();
		expect(screen.queryByText("me@epichvac.com")).not.toBeInTheDocument();
	});

	it("keeps switch and remove as separate top-level buttons", async () => {
		renderSection();
		await expand();

		const remove = screen.getByRole("button", { name: "Remove owner@bluepipe.test" });
		expect(remove.parentElement?.closest("button")).toBeNull();
	});

	it("removes an account without switching", async () => {
		renderSection();
		await expand();

		await userEvent.click(screen.getByRole("button", { name: "Remove owner@bluepipe.test" }));

		expect(screen.queryByText("owner@bluepipe.test")).not.toBeInTheDocument();
		expect(replace).not.toHaveBeenCalled();
	});

	it("clears the outgoing session before handing off to login", async () => {
		localStorage.setItem("accessToken", "token");
		localStorage.setItem("entitlements:last", "{}");
		renderSection();
		await expand();

		await userEvent.click(screen.getByRole("button", { name: /^owner@bluepipe\.test/ }));

		expect(localStorage.getItem("accessToken")).toBeNull();
		expect(localStorage.getItem("entitlements:last")).toBeNull();
		expect(replace).toHaveBeenCalledWith(
			"/app/login?email=owner%40bluepipe.test",
		);
	});
});
