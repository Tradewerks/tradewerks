import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const { get } = vi.hoisted(() => ({
	get: vi.fn(async (_url: string, _cfg?: unknown) => ({
		data: {
			success: true,
			data: {
				hits: [
					{ id: "t1", type: "technician", label: "Tina Tech", sublabel: "tina@x.com", route: "/dispatch/technicians/t1" },
					{ id: "j1", type: "job", label: "J-1 — AC repair", sublabel: "Acme", route: "/dispatch/jobs/j1" },
					{ id: "c1", type: "client", label: "Acme", route: "/dispatch/clients/c1" },
				],
				truncated: false,
				types: ["client", "job", "technician"],
			},
			error: null,
		},
	})),
}));

vi.mock("../../../api/axiosClient", () => ({ api: { get } }));

import GlobalSearch from "../GlobalSearch";

const renderSearch = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<GlobalSearch />
			</MemoryRouter>
		</QueryClientProvider>,
	);

const type = (value: string) =>
	fireEvent.change(screen.getByPlaceholderText("Search..."), { target: { value } });

beforeEach(() => {
	vi.useFakeTimers();
	get.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("GlobalSearch on /search", () => {
	it("mounting GlobalSearch issues no list requests", async () => {
		renderSearch();
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(get).not.toHaveBeenCalled();
	});

	it('typing "ac" waits 250ms then calls /search once', async () => {
		renderSearch();
		type("ac");
		await act(() => vi.advanceTimersByTimeAsync(249));
		expect(get).not.toHaveBeenCalled();
		await act(() => vi.advanceTimersByTimeAsync(10));
		expect(get).toHaveBeenCalledTimes(1);
		expect(get.mock.calls[0][0]).toBe("/search");
		expect(get.mock.calls[0][1]).toMatchObject({ params: { q: "ac" } });
	});

	it("a one-character query does not call /search", async () => {
		renderSearch();
		type("a");
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(get).not.toHaveBeenCalled();
	});

	it("results keep the existing grouping order and counts", async () => {
		renderSearch();
		type("ac");
		await act(() => vi.advanceTimersByTimeAsync(300));
		await act(() => vi.advanceTimersByTimeAsync(50));
		const badges = screen.getAllByText(/^(Client|Job|Technician)$/).map((e) => e.textContent);
		// Old order: clients, then jobs, then technicians, whatever order the server returned.
		expect(badges).toEqual(["Client", "Job", "Technician"]);
		expect(screen.getByText("J-1 — AC repair")).toBeTruthy();
		expect(screen.getByText("3 results")).toBeTruthy();
		expect(screen.getByText("Page 1 / 1")).toBeTruthy();
	});

	it("shows a quiet inline error when the search fails", async () => {
		get.mockRejectedValueOnce(new Error("boom"));
		renderSearch();
		type("ac");
		await act(() => vi.advanceTimersByTimeAsync(300));
		await act(() => vi.advanceTimersByTimeAsync(50));
		expect(screen.getByText("Search is unavailable. Try again.")).toBeTruthy();
	});
});
