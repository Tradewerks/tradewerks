import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import StockMovementList from "../StockMovementList";
import UsageReport from "../UsageReport";
import type { ItemUsage, ItemUsageRow, MovementsPage, StockMovement } from "../../../../types/inventory";

// Both paginated cards live in an infinite query, so "Load more" appends the
// next page onto the accumulated pages rather than re-appending whatever
// `data` last held. These tests pin the observable contract — N rows, then
// exactly N+M after Load more — through the real hooks, with only the api
// module mocked.

const getInventoryMovements = vi.fn();
const getItemUsage = vi.fn();
vi.mock("../../../../api/inventory", () => ({
	getInventoryMovements: (...a: unknown[]) => getInventoryMovements(...a),
	getItemUsage: (...a: unknown[]) => getItemUsage(...a),
}));

function mv(id: string, overrides: Partial<StockMovement> = {}): StockMovement {
	return {
		id,
		qty: 1,
		unit: "each",
		from_location_type: "warehouse",
		from_vehicle: null,
		to_location_type: "consumed",
		to_vehicle: null,
		reason: "parts_used",
		note: null,
		actor_type: "system",
		actor_id: null,
		visit_id: null,
		created_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function usage(jobId: string): ItemUsageRow {
	return {
		jobId,
		jobNumber: `J${jobId}`,
		jobName: `Job ${jobId}`,
		clientId: "c1",
		clientName: "Client",
		qtyConsumed: 1,
		unitBasis: { mixed: false, units: ["each"], unit: "each" },
		lastConsumedAt: "2026-01-01T00:00:00.000Z",
	};
}

const SINGLE = { mixed: false, units: ["each"], unit: "each" };

function wrap(ui: React.ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const providers = (el: React.ReactElement) => (
		<QueryClientProvider client={qc}>
			<MemoryRouter>{el}</MemoryRouter>
		</QueryClientProvider>
	);
	const view = render(providers(ui));
	// Same QueryClient across rerenders, so a prop change exercises the cache
	// (keepPreviousData) rather than starting from an empty one.
	return { ...view, rerender: (el: React.ReactElement) => view.rerender(providers(el)) };
}

/** A page whose resolution the test controls. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	errSpy.mockRestore();
});

const duplicateKeyWarned = () =>
	errSpy.mock.calls.some((c: unknown[]) => c.some((arg) => String(arg).includes("same key")));

describe("StockMovementList — Load more", () => {
	it("appends exactly the next page (2 rows → 3), never the first page again", async () => {
		const page2 = deferred<MovementsPage>();
		getInventoryMovements.mockImplementation((_id: string, cursor?: string) =>
			cursor
				? page2.promise
				: Promise.resolve({ movements: [mv("a"), mv("b")], nextCursor: "b" }),
		);

		wrap(<StockMovementList itemId="item-1" />);
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));

		await userEvent.click(screen.getByRole("button", { name: /load more/i }));
		await waitFor(() => expect(getInventoryMovements).toHaveBeenCalledTimes(2));
		// Page 2 was requested with page 1's cursor and the same (absent) range.
		expect(getInventoryMovements).toHaveBeenLastCalledWith("item-1", "b", undefined, undefined);
		// In flight: the first page stays put, nothing is appended yet.
		expect(screen.getAllByRole("listitem")).toHaveLength(2);

		await act(async () => {
			page2.resolve({ movements: [mv("c")], nextCursor: null });
		});

		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
		expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
		expect(duplicateKeyWarned()).toBe(false);
	});

	it("a range change starts a fresh result set: old rows stay until the new first page lands, and the old cursor is never sent with the new range", async () => {
		const narrow = deferred<MovementsPage>();
		getInventoryMovements.mockImplementation((_id: string, cursor?: string, _limit?: number, createdAfter?: string) => {
			if (createdAfter === "2026-02-01T00:00:00.000Z") return narrow.promise;
			return cursor
				? Promise.resolve({ movements: [mv("c")], nextCursor: null })
				: Promise.resolve({ movements: [mv("a"), mv("b")], nextCursor: "b" });
		});

		const view = wrap(<StockMovementList itemId="item-1" />);
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
		await userEvent.click(screen.getByRole("button", { name: /load more/i }));
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));

		view.rerender(<StockMovementList itemId="item-1" createdAfter="2026-02-01T00:00:00.000Z" />);
		await waitFor(() =>
			expect(getInventoryMovements).toHaveBeenCalledWith(
				"item-1",
				undefined,
				undefined,
				"2026-02-01T00:00:00.000Z",
			),
		);
		// Only the FIRST page of the new range is requested — page 2's cursor
		// belonged to the old result set and must not be reused.
		const narrowCalls = getInventoryMovements.mock.calls.filter(
			(c) => c[3] === "2026-02-01T00:00:00.000Z",
		);
		expect(narrowCalls).toHaveLength(1);
		expect(narrowCalls[0][1]).toBeUndefined();
		// While the new range's first page is in flight the old rows stay on
		// screen (keepPreviousData) instead of flashing to an empty state.
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		expect(screen.queryByText(/No movements in this range/)).not.toBeInTheDocument();

		await act(async () => {
			narrow.resolve({ movements: [mv("z")], nextCursor: null });
		});
		await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
		expect(duplicateKeyWarned()).toBe(false);
	});
});

describe("UsageReport — Load more", () => {
	it("appends exactly the next page (2 rows → 3), requested at the loaded-row offset", async () => {
		const page2 = deferred<ItemUsage>();
		getItemUsage.mockImplementation((_id: string, opts?: { offset?: number }) =>
			opts?.offset
				? page2.promise
				: Promise.resolve({ usage: [usage("1"), usage("2")], unitBasis: SINGLE, hasMore: true }),
		);

		wrap(<UsageReport itemId="item-1" />);
		await waitFor(() => expect(screen.getAllByText(/Job \d/)).toHaveLength(2));

		await userEvent.click(screen.getByRole("button", { name: /load more/i }));
		await waitFor(() => expect(getItemUsage).toHaveBeenCalledTimes(2));
		expect(getItemUsage).toHaveBeenLastCalledWith("item-1", { limit: 20, offset: 2 });
		expect(screen.getAllByText(/Job \d/)).toHaveLength(2);

		await act(async () => {
			page2.resolve({ usage: [usage("3")], unitBasis: SINGLE, hasMore: false });
		});

		await waitFor(() => expect(screen.getAllByText(/Job \d/)).toHaveLength(3));
		expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
		expect(duplicateKeyWarned()).toBe(false);
	});
});
