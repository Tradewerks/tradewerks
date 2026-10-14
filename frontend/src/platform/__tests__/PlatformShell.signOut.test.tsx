import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../hooks", () => ({ useOpenRequestCount: () => ({ data: { count: 0 } }) }));

import PlatformShell from "../PlatformShell";
import { usePlatformAuth } from "../store";
import { useUnsavedGuard } from "../useUnsavedGuard";

function Page({ dirty }: { dirty: boolean }) {
	useUnsavedGuard(dirty);
	return <p>org page</p>;
}

const renderShell = (dirty: boolean) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/platform/orgs/o-1"]}>
				<Routes>
					<Route element={<PlatformShell />}>
						<Route path="/platform/orgs/:id" element={<Page dirty={dirty} />} />
					</Route>
					<Route path="/platform/login" element={<p>login page</p>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	usePlatformAuth.setState({
		token: "t",
		staff: { id: "s-1", email: "s@x.com", name: "Sam" },
		notice: null,
	});
});

describe("PlatformShell sign out", () => {
	it("signs out at once when nothing is unsaved", () => {
		renderShell(false);
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		expect(screen.getByText("login page")).toBeInTheDocument();
		expect(usePlatformAuth.getState().token).toBeNull();
	});

	it("asks first while a draft is unsaved; Cancel stays, Discard signs out", () => {
		renderShell(true);
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByText("org page")).toBeInTheDocument();
		expect(usePlatformAuth.getState().token).toBe("t");
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		fireEvent.click(screen.getByRole("button", { name: "Discard and sign out" }));
		expect(screen.getByText("login page")).toBeInTheDocument();
		expect(usePlatformAuth.getState().token).toBeNull();
	});
});
