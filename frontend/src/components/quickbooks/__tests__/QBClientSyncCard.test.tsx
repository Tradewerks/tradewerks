import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import QBClientSyncCard from "../QBClientSyncCard";
import { useAuthStore } from "../../../auth/authStore";
import type { ListParams } from "../../../types/paging";

const { getClientsPage, syncOne, invalidateQBClientSync } = vi.hoisted(() => ({
	getClientsPage: vi.fn(),
	syncOne: vi.fn(),
	invalidateQBClientSync: vi.fn(),
}));

vi.mock("../../../api/clients", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/clients")>()),
	getClientsPage,
}));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBCustomerQuery: () => ({ data: [{ Id: "q1", DisplayName: "QB Acme" }] }),
	useQBClientSyncMutation: () => ({ mutateAsync: syncOne }),
	invalidateQBClientSync,
}));

const row = (id: string, synced = false) => ({
	id,
	name: `Client ${id}`,
	address: "1 Main",
	client_external_mapping: synced ? [{ external_id: "q1" }] : [],
});

const respond = (params: ListParams, extras: { qb?: string }) => {
	const total = params.limit === 1 ? (extras.qb === "not_synced" ? 3 : extras.qb ? 2 : 5) : 3;
	const ids = extras.qb === "not_synced" ? ["a", "b", "c"].slice((params.page - 1) * params.limit, params.page * params.limit) : ["a"];
	return Promise.resolve({
		rows: params.limit === 1 ? [] : ids.map((i) => row(i, i === "z")),
		total,
		page: params.page,
		limit: params.limit,
	});
};

function renderCard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<QBClientSyncCard />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getClientsPage.mockReset().mockImplementation(respond);
	invalidateQBClientSync.mockReset();
	syncOne.mockReset().mockResolvedValue({});
	useAuthStore.getState().login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["edit_clients"]);
});

describe("QBClientSyncCard", () => {
	it("pages the server list and takes its counts from one-row count queries", async () => {
		renderCard();
		await screen.findByText("Client a");
		await screen.findByText("All 5");
		expect(screen.getByText("Synced 2")).toBeTruthy();
		expect(screen.getByText("Not synced 3")).toBeTruthy();
		expect(getClientsPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1, limit: 50 }),
			expect.objectContaining({ withQb: true }),
		);
	});

	it("sends the search to the server and maps the filter chips to qb", async () => {
		renderCard();
		await screen.findByText("Client a");
		fireEvent.click(screen.getByText(/^Not synced \d/));
		await waitFor(() =>
			expect(getClientsPage).toHaveBeenCalledWith(
				expect.objectContaining({ limit: 50 }),
				expect.objectContaining({ qb: "not_synced", withQb: true }),
			),
		);
		fireEvent.change(screen.getByPlaceholderText("Search clients…"), { target: { value: "acme" } });
		await waitFor(() =>
			expect(getClientsPage).toHaveBeenCalledWith(
				expect.objectContaining({ q: "acme" }),
				expect.objectContaining({ qb: "not_synced" }),
			),
		);
	});

	it("Sync all not-synced collects ids by paging only when clicked", async () => {
		renderCard();
		await screen.findByText("Not synced 3");
		const idCalls = () =>
			getClientsPage.mock.calls.filter(([p]) => p.limit === 200).length;
		expect(idCalls()).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: /Sync all not-synced/ }));
		await waitFor(() => expect(syncOne).toHaveBeenCalledTimes(3));
		expect(idCalls()).toBe(1);
		expect(syncOne.mock.calls.map((c) => c[0].client_id).sort()).toEqual(["a", "b", "c"]);
	});

	it("a bulk sync invalidates once and keeps at most 5 syncs in flight", async () => {
		const many = Array.from({ length: 12 }, (_, i) => `id${i}`);
		getClientsPage.mockImplementation((params: ListParams, extras: { qb?: string }) =>
			params.limit === 200
				? Promise.resolve({ rows: many.map((i) => row(i)), total: 12, page: 1, limit: 200 })
				: respond(params, extras),
		);
		let inFlight = 0;
		let peak = 0;
		syncOne.mockImplementation(async () => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return {};
		});
		renderCard();
		await screen.findByText("Not synced 3");
		fireEvent.click(screen.getByRole("button", { name: /Sync all not-synced/ }));
		await waitFor(() => expect(syncOne).toHaveBeenCalledTimes(12));
		await waitFor(() => expect(invalidateQBClientSync).toHaveBeenCalledTimes(1));
		expect(peak).toBeLessThanOrEqual(5);
	});
});
