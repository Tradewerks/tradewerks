import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ count: 0 }));
vi.mock("../hooks", () => ({ useOpenRequestCount: () => ({ data: { count: mocks.count } }) }));

import PlatformShell from "../PlatformShell";
import { usePlatformAuth } from "../store";
import { useUnsavedGuard } from "../useUnsavedGuard";

function Page({ dirty }: { dirty: boolean }) {
	useUnsavedGuard(dirty);
	return <p>org page</p>;
}

const renderShell = (dirty = false) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/platform/orgs/o-1"]}>
				<Routes>
					<Route element={<PlatformShell />}>
						<Route path="/platform/orgs" element={<p>orgs list</p>} />
						<Route path="/platform/orgs/:id" element={<Page dirty={dirty} />} />
					</Route>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	mocks.count = 0;
	usePlatformAuth.setState({
		token: "t",
		staff: { id: "s-1", email: "s@x.com", name: "Sam" },
		notice: null,
	});
});

describe("PlatformShell nav", () => {
	it("Organizations stays active on an org detail route", () => {
		renderShell();
		expect(screen.getByRole("link", { name: /Organizations/ })).toHaveClass("bg-primary-bg");
	});

	it("request badge: hidden at 0, number at 3, 99+ at 120", () => {
		const { unmount } = renderShell();
		expect(screen.getByRole("link", { name: /Requests/ })).toHaveTextContent(/^Requests$/);
		unmount();
		mocks.count = 3;
		const second = renderShell();
		expect(screen.getByRole("link", { name: /Requests/ })).toHaveTextContent("3");
		second.unmount();
		mocks.count = 120;
		renderShell();
		expect(screen.getByRole("link", { name: /Requests/ })).toHaveTextContent("99+");
	});

	it("Back with no unsaved draft navigates to the orgs list fallback", () => {
		renderShell();
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByText("orgs list")).toBeInTheDocument();
	});

	it("Back with history depth goes back one entry", () => {
		window.history.replaceState({ idx: 1 }, "");
		render(
			<QueryClientProvider client={new QueryClient()}>
				<MemoryRouter initialEntries={["/platform/orgs", "/platform/orgs/o-1"]} initialIndex={1}>
					<Routes>
						<Route element={<PlatformShell />}>
							<Route path="/platform/orgs" element={<p>orgs list</p>} />
							<Route path="/platform/tiers" element={<p>tiers list</p>} />
							<Route path="/platform/orgs/:id" element={<p>org page</p>} />
						</Route>
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>
		);
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByText("orgs list")).toBeInTheDocument();
		window.history.replaceState(null, "");
	});

	it("Back on the orgs list with no history is a no-op", () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<MemoryRouter initialEntries={["/platform/orgs"]}>
					<Routes>
						<Route element={<PlatformShell />}>
							<Route path="/platform/orgs" element={<p>orgs list</p>} />
						</Route>
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>
		);
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByText("orgs list")).toBeInTheDocument();
	});

	it("Back with an unsaved draft asks first", () => {
		renderShell(true);
		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
		expect(screen.getByText("org page")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Discard and go back" }));
		expect(screen.getByText("orgs list")).toBeInTheDocument();
	});

	it("header shows Back office marker", () => {
		renderShell();
		expect(screen.getByText("Back office")).toBeInTheDocument();
	});
});
