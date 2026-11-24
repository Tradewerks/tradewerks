import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardResponse } from "../../../types/board";

const { handlers, getBoard, getAllJobs } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown) => void>(),
	getBoard: vi.fn(),
	getAllJobs: vi.fn(),
}));

vi.mock("../../../lib/socket", () => ({
	socket: {
		on: (event: string, fn: (e: unknown) => void) => handlers.set(event, fn),
		off: (event: string) => handlers.delete(event),
		io: { on: vi.fn(), off: vi.fn() },
	},
}));
vi.mock("../../../api/jobs", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/jobs")>()),
	getBoard,
	getAllJobs,
}));
vi.mock("../../../hooks/useTechnicians", () => ({
	useActiveTechniciansQuery: () => ({ data: [], error: null }),
	useTechnicianByIdQuery: () => ({
		data: { id: "t1", name: "Tia Tech", email: "t@x.co", phone: "5551234567", status: "Available" },
		isLoading: false,
	}),
}));
vi.mock("../../../hooks/useVehicleStock", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../hooks/useVehicleStock")>()),
	useVehicleStockConflictsQuery: () => ({ data: [] }),
}));
vi.mock("../../../hooks/useRecurringPlans", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../hooks/useRecurringPlans")>()),
	useAllRecurringPlansQuery: () => ({ data: [], error: null }),
}));

import SchedulePage from "../SchedulePage";
import AssignTechnicianPage from "../AssignTechnicianPage";
import { useBoardQuery } from "../../../hooks/useJobs";
import { useSocketQuerySync } from "../../../hooks/useSocketQuerySync";

const empty: BoardResponse = { visits: [], occurrences: [] };

function Sync() {
	useSocketQuerySync();
	return null;
}

const mountSchedule = () => {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<Sync />
			<MemoryRouter>
				<SchedulePage />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return qc;
};

const fromOf = (call: unknown[]) => new Date(call[0] as Date).getTime();
const DAY = 864e5;

beforeEach(() => {
	handlers.clear();
	getBoard.mockReset().mockResolvedValue(empty);
	getAllJobs.mockReset().mockResolvedValue([]);
});

describe("SchedulePage range reads", () => {
	it("navigating one week forward requests the next range and keeps the old one as placeholder", async () => {
		mountSchedule();
		await waitFor(() => expect(getBoard).toHaveBeenCalledTimes(1));
		const first = getBoard.mock.calls[0];
		expect(new Date(first[1] as Date).getTime() - fromOf(first)).toBeGreaterThanOrEqual(7 * DAY - DAY / 12);

		await userEvent.click(screen.getByRole("button", { name: "Next week" }));
		await waitFor(() => expect(getBoard).toHaveBeenCalledTimes(2));
		// A DST shift inside the week moves the boundary by an hour at most.
		expect(Math.abs(fromOf(getBoard.mock.calls[1]) - fromOf(first) - 7 * DAY)).toBeLessThanOrEqual(DAY / 12);
		expect(getAllJobs).not.toHaveBeenCalled();

		// The hook keeps the previous range's rows on screen while the next one loads.
		const rows: BoardResponse = { visits: [{ id: "v1" } as never], occurrences: [] };
		getBoard.mockReset().mockResolvedValueOnce(rows).mockReturnValueOnce(new Promise(() => undefined));
		const qc = new QueryClient();
		const a = new Date("2026-03-02T06:00:00Z");
		const b = new Date("2026-03-09T06:00:00Z");
		const { result, rerender } = renderHook(({ from, to }) => useBoardQuery(from, to), {
			initialProps: { from: a, to: new Date(a.getTime() + 7 * DAY) },
			wrapper: ({ children }: { children: React.ReactNode }) => (
				<QueryClientProvider client={qc}>{children}</QueryClientProvider>
			),
		});
		await waitFor(() => expect(result.current.data).toEqual(rows));
		rerender({ from: b, to: new Date(b.getTime() + 7 * DAY) });
		await waitFor(() => expect(getBoard).toHaveBeenCalledTimes(2));
		expect(result.current.isPlaceholderData).toBe(true);
		expect(result.current.data).toEqual(rows);
	});

	it("a record:changed visit event refetches the visible range only", async () => {
		mountSchedule();
		await waitFor(() => expect(getBoard).toHaveBeenCalledTimes(1));
		await userEvent.click(screen.getByRole("button", { name: "Next week" }));
		await waitFor(() => expect(getBoard).toHaveBeenCalledTimes(2));
		const visible = fromOf(getBoard.mock.calls[1]);

		act(() => handlers.get("record:changed")!({ type: "visit", id: "v1", jobId: "j1" }));
		await waitFor(() => expect(getBoard).toHaveBeenCalledTimes(3));
		// The week left behind is cached but unobserved, so only the visible one refetches.
		await new Promise((r) => setTimeout(r, 50));
		expect(getBoard).toHaveBeenCalledTimes(3);
		expect(fromOf(getBoard.mock.calls[2])).toBe(visible);
	});
});

describe("AssignTechnicianPage reads", () => {
	it("AssignTechnicianPage does not call GET /jobs", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MemoryRouter initialEntries={["/dispatch/technicians/t1/assign"]}>
					<Routes>
						<Route path="/dispatch/technicians/:technicianId/assign" element={<AssignTechnicianPage />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		await waitFor(() => expect(getBoard).toHaveBeenCalled());
		expect(getAllJobs).not.toHaveBeenCalled();
		expect(getBoard.mock.calls[0][2]).toMatchObject({ includeUnscheduled: true });
	});

	const stepBackScenario = async (days: number) => {
		localStorage.setItem("assignTech.showDay", "1");
		const day = new Date(Date.now() - days * DAY);
		const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18));
		const old = {
			id: "v-old",
			job_id: "j1",
			name: "Old furnace swap",
			status: "Completed",
			scheduled_start_at: start.toISOString(),
			scheduled_end_at: new Date(start.getTime() + 2 * 36e5).toISOString(),
			arrival_constraint: "anytime",
			finish_constraint: "when_done",
			_count: { line_items: 0 },
			visit_techs: [{ tech_id: "t1", tech: { id: "t1", name: "Tia Tech" } }],
			job: { id: "j1", job_number: "J-1", name: "Old furnace swap", priority: "Medium", address: "1 Elm", client: { id: "c", name: "C" } },
		};
		// Like the server: only rows overlapping the requested range come back.
		getBoard.mockReset().mockImplementation(async (from: Date, to: Date) => ({
			visits: from < new Date(old.scheduled_end_at) && to > start ? [old] : [],
			occurrences: [],
			unscheduledJobs: [],
		}));
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MemoryRouter initialEntries={["/dispatch/technicians/t1/assign"]}>
					<Routes>
						<Route path="/dispatch/technicians/:technicianId/assign" element={<AssignTechnicianPage />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		await waitFor(() => expect(getBoard).toHaveBeenCalled());
		const prev = await screen.findByRole("button", { name: "Previous day" });
		for (let i = 0; i < days; i++) await userEvent.click(prev);
		expect((await screen.findAllByText("Old furnace swap")).length).toBeGreaterThan(0);
		localStorage.removeItem("assignTech.showDay");
	};

	it("stepping back 20 days keeps the day timeline populated", () => stepBackScenario(20));

	// Past the window edge the window must re-anchor on the picked day.
	it("stepping back 35 days re-anchors the window and keeps the timeline populated", () =>
		stepBackScenario(35));
});
