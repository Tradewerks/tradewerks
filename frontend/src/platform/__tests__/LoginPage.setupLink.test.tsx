import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain fn, not vi.fn: the spy re-raises a rejected result it tracks, failing the test.
const h = vi.hoisted(() => ({
	calls: 0,
	answer: (): Promise<{ available: boolean }> => Promise.resolve({ available: false }),
}));
vi.mock("../api", async (orig) => ({
	...(await orig<typeof import("../api")>()),
	platform: {
		setupAvailable: () => {
			h.calls++;
			return h.answer();
		},
	},
}));

import LoginPage from "../pages/LoginPage";

const renderLogin = async () => {
	render(
		<MemoryRouter initialEntries={["/platform/login"]}>
			<LoginPage />
		</MemoryRouter>
	);
	await vi.waitFor(() => expect(h.calls).toBe(1));
	await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
	h.calls = 0;
});

describe("LoginPage setup link", () => {
	it("links to setup while no staff account exists", async () => {
		h.answer = () => Promise.resolve({ available: true });
		await renderLogin();
		expect(
			screen.getByRole("link", { name: "Set up the back office" })
		).toHaveAttribute("href", "/platform/setup");
	});

	it("shows no link once setup is done", async () => {
		h.answer = () => Promise.resolve({ available: false });
		await renderLogin();
		expect(screen.queryByRole("link", { name: /Set up/ })).toBeNull();
	});

	it("shows no link when the check fails", async () => {
		h.answer = () => Promise.reject(new Error("down"));
		await renderLogin();
		expect(screen.queryByRole("link", { name: /Set up/ })).toBeNull();
	});
});
