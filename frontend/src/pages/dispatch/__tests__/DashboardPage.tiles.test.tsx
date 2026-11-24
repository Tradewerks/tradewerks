import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../api/axiosClient", () => ({
	api: { get: apiGet, post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("react-grid-layout", () => ({
	useContainerWidth: () => ({ containerRef: { current: null }, width: 1200 }),
	ResponsiveGridLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../hooks/useDispatchers", () => ({
	useDispatcherByIdQuery: () => ({ data: { id: "d1", dashboard_layout: null } }),
	useUpdateDispatcherMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useTechnicians", () => ({
	useActiveTechniciansQuery: () => ({ data: [], error: null }),
}));
vi.mock("../../../hooks/useJobs", () => ({
	useBoardQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("../../../components/ui/schedule/WeekStrip", () => ({ default: () => null }));
vi.mock("../../../components/recurringPlans/CreateRecurringPlan", () => ({ default: () => null }));
vi.mock("../../../components/widgets/AddWidgetModal", () => ({ default: () => null }));
vi.mock("../../../components/dashboard/ActivityFeed", () => ({ default: () => null }));

import DashboardPage from "../DashboardPage";
import { useAuthStore } from "../../../auth/authStore";

const TILES = {
	requests_new: 4,
	requests_reviewing: 2,
	quotes_pending_approval: 9,
	quotes_approved: 3,
	jobs_unscheduled: 5,
	recurring_active: 6,
	recurring_paused: 1,
	visits_today: 12,
	visits_unassigned_today: 2,
	visits_late_now: 1,
	visits_in_progress: 3,
	visits_completed_today: 7,
	techs: [],
	as_of: "2026-06-10T15:00:00.000Z",
};

function Where() {
	const loc = useLocation();
	return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

const mount = () => {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={["/dispatch"]}>
				<Routes>
					<Route path="/dispatch" element={<DashboardPage />} />
					<Route path="*" element={<Where />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
};

beforeEach(() => {
	apiGet.mockReset();
	apiGet.mockImplementation(async (url: string) => {
		if (url === "/reports/dashboard-today") return { data: { success: true, data: TILES } };
		return { data: { success: true, data: [] } };
	});
	useAuthStore.setState({
		user: { userId: "u1", orgTimezone: "America/Chicago", role: "dispatcher", permissions: ["*"] },
	} as never);
});

describe("DashboardPage tiles", () => {
	it("Pending Approval links to status=Sent,Viewed", async () => {
		mount();
		await userEvent.click(await screen.findByText("Pending Approval"));
		expect((await screen.findByTestId("where")).textContent).toBe(
			"/dispatch/quotes?status=Sent,Viewed",
		);
	});

	it("DashboardPage does not call /jobs, /requests, /quotes or /recurring-plans", async () => {
		mount();
		expect(await screen.findByText("9")).toBeTruthy();
		await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/reports/dashboard-today"));
		const urls = apiGet.mock.calls.map((c) => String(c[0]));
		const lists = urls.filter((u) => /^\/(jobs|requests|quotes|recurring-plans)(\?|$)/.test(u));
		expect(lists).toEqual([]);
	});

	it("a null count renders a dash", async () => {
		apiGet.mockImplementation(async (url: string) =>
			url === "/reports/dashboard-today"
				? { data: { success: true, data: { ...TILES, quotes_pending_approval: null } } }
				: { data: { success: true, data: [] } },
		);
		mount();
		const label = await screen.findByText("Pending Approval");
		await waitFor(() => expect(screen.getByText("4")).toBeTruthy());
		expect(label.previousElementSibling?.textContent).toBe("—");
	});
});
