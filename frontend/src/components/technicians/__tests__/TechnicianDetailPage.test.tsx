import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError } from "axios";
import TechnicianDetailsPage from "../../../pages/dispatch/TechnicianDetailPage";

const query = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const perms = vi.hoisted(() => ({ current: {} as Record<string, boolean> }));

const TECH = {
	id: "t1",
	name: "Maria Rodriguez",
	title: "HVAC Technician",
	status: "EnRoute",
	email: "maria@example.com",
	phone: "6082550102",
	hire_date: "2020-06-30T12:00:00",
	last_login: null,
	mfaEnabled: false,
	visit_techs: [],
	current_vehicle: null,
	organization_role: { id: "r1", name: "Senior", permissions: [] },
};

vi.mock("../../../hooks/useTechnicians", () => ({
	useTechnicianByIdQuery: () => query.current,
	useDeleteTechnicianMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useMfa", () => ({
	useResetMfaMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/usePermission", () => ({
	usePermission: (p: string) => perms.current[p] ?? true,
	useAnyPermission: (ps: string[]) => ps.some((p) => perms.current[p] ?? true),
}));
vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchases: () => ({ data: [], isLoading: false, isError: false }),
	useFieldPurchaseQueue: () => ({
		data: { items: [], total: 0 },
		isLoading: false,
		isError: false,
	}),
}));
// Overview tab's timesheets tile — unmocked, this hits the real API and trips
// the network-call guard in test/setup.ts on every test, not just Overview's.
vi.mock("../../../hooks/useReports", () => ({
	useTimesheetsReportQuery: () => ({ data: [], isLoading: false }),
}));
// The location card reads the socket-fed list; an empty list falls back to the fetched tech.
vi.mock("../../../hooks/useTechnicianMarkers", () => ({
	useLiveTechnicians: () => ({ technicians: [], isLoading: false }),
}));
vi.mock("../../ui/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../roles/AccessCard", () => ({ default: () => <div data-testid="access-card" /> }));
vi.mock("../../activity/ChangeHistory", () => ({ default: () => <div data-testid="history" /> }));
vi.mock("../EditTechnician", () => ({ default: () => null }));

const axiosError = (status: number) => Object.assign(new AxiosError("x"), { response: { status } });

function renderPage(path = "/dispatch/technicians/t1") {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route
						path="/dispatch/technicians/:technicianId"
						element={<TechnicianDetailsPage />}
					/>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	query.current = { data: TECH, isLoading: false, error: null, refetch: vi.fn() };
	perms.current = {};
});

describe("TechnicianDetailsPage", () => {
	it("prints the status word exactly once, as a label", () => {
		renderPage();
		expect(screen.getAllByText("En Route")).toHaveLength(1);
		expect(screen.queryByText("EnRoute")).toBeNull();
	});

	it("labels the only menu", () => {
		renderPage();
		expect(screen.getByRole("button", { name: "Technician actions" })).toBeTruthy();
	});

	it("falls back to Overview on an unknown tab", () => {
		renderPage("/dispatch/technicians/t1?tab=bogus");
		expect(
			screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")
		).toBe("true");
	});

	it("opens Access from the URL", () => {
		renderPage("/dispatch/technicians/t1?tab=access");
		expect(screen.getByTestId("access-card")).toBeTruthy();
	});

	it("shows not-found for a 404", () => {
		query.current = {
			data: undefined,
			isLoading: false,
			error: axiosError(404),
			refetch: vi.fn(),
		};
		renderPage();
		expect(screen.getByText("Technician not found")).toBeTruthy();
	});

	it("offers retry for other errors", () => {
		query.current = {
			data: undefined,
			isLoading: false,
			error: axiosError(500),
			refetch: vi.fn(),
		};
		renderPage();
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
	});

	it("disables Assign Visits with a visible reason without manage_technicians", () => {
		perms.current = { manage_technicians: false };
		renderPage();
		expect(
			screen.getAllByText("You don't have permission to perform this action")
				.length
		).toBeGreaterThan(0);
		expect(screen.queryByRole("link", { name: /Assign Visits/ })).toBeNull();
		const button = screen.getByRole("button", { name: /Assign Visits/ });
		expect(button.getAttribute("aria-disabled")).toBe("true");
		const reason = document.getElementById(button.getAttribute("aria-describedby")!);
		expect(reason?.textContent).toBe(
			"You don't have permission to perform this action"
		);
	});

	it("announces the armed delete by name", () => {
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "Technician actions" }));
		fireEvent.click(screen.getByRole("menuitem", { name: /Delete Technician/ }));
		expect(
			screen.getByRole("menuitem", { name: /Press again to delete/ })
		).toBeTruthy();
		expect(screen.getByText("Press again to delete Maria Rodriguez")).toBeTruthy();
	});

	it("hides the Scorecard link without view_reports", () => {
		perms.current = { view_reports: false };
		renderPage();
		expect(screen.queryByRole("link", { name: /Scorecard/ })).toBeNull();
	});

	it("opens Activity with history beside the purchases rail", () => {
		renderPage("/dispatch/technicians/t1?tab=activity");
		expect(screen.getByTestId("history")).toBeTruthy();
		expect(screen.getByText("No submitted field purchases yet.")).toBeTruthy();
	});

	it("shows a permission empty state for purchases without view_field_purchases", () => {
		perms.current = { view_field_purchases: false };
		renderPage("/dispatch/technicians/t1?tab=activity");
		expect(screen.getByText("Needs the View Field Purchases permission.")).toBeTruthy();
	});
});
