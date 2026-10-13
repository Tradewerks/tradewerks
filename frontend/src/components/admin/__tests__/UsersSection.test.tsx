import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import UsersSection from "../UsersSection";

const perms = vi.hoisted(() => ({ current: [] as string[] }));

const TECHS = Array.from({ length: 14 }, (_, i) => ({
	id: `t${i}`,
	name: `Tech ${String(i).padStart(2, "0")}`,
	title: "HVAC Technician",
	status: "Available",
	email: `t${i}@example.com`,
	phone: "6085550100",
	last_login: null,
	deactivated_at: null,
	mfaEnabled: false,
	visit_techs: [],
	organization_role: null,
}));
const DISPATCHERS = [
	{
		id: "d1",
		name: "Sam Lee",
		role: "dispatcher",
		title: "Office Manager",
		email: "sam@example.com",
		phone: null,
		last_login: null,
		deactivated_at: null,
		mfaEnabled: true,
		organization_role: { id: "r1", name: "Billing" },
	},
	{
		id: "d2",
		name: "Ana Cruz",
		role: "admin",
		title: "Owner",
		email: "ana@example.com",
		phone: null,
		last_login: null,
		deactivated_at: null,
		mfaEnabled: false,
		organization_role: null,
	},
];

vi.mock("../../../hooks/useTechnicians", () => {
	const m = () => ({ mutateAsync: vi.fn(), isPending: false });
	return {
		useAllTechniciansQuery: () => ({ data: TECHS, isLoading: false, error: null }),
		useCreateTechnicianMutation: m,
		useDeleteTechnicianMutation: m,
		useDeactivateTechnicianMutation: m,
		useReactivateTechnicianMutation: m,
	};
});
vi.mock("../../../hooks/useDispatchers", () => {
	const m = () => ({ mutateAsync: vi.fn(), isPending: false });
	return {
		useAllDispatchersQuery: () => ({ data: DISPATCHERS, isLoading: false, error: null }),
		useCreateDispatcherMutation: m,
		useDeleteDispatcherMutation: m,
		useDeactivateDispatcherMutation: m,
		useReactivateDispatcherMutation: m,
	};
});
vi.mock("../../../hooks/useMfa", () => ({
	useResetMfaMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/usePermission", () => ({
	usePermission: (p: string) => perms.current.includes(p),
	useAnyPermission: (ps: string[]) => ps.some((p) => perms.current.includes(p)),
}));
vi.mock("../../../auth/authStore", () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { permissions: perms.current } }),
}));
vi.mock("../../ui/useToast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("../../technicians/CreateTechnician", () => ({ default: () => null }));
vi.mock("../../technicians/EditTechnician", () => ({ default: () => null }));
vi.mock("../../dispatchers/CreateDispatcher", () => ({ default: () => null }));
vi.mock("../../dispatchers/EditDispatcher", () => ({ default: () => null }));
vi.mock("../../roles/AssignRoleModal", () => ({ default: () => null }));

const ALL_PERMS = ["view_technicians", "view_dispatchers", "manage_technicians", "manage_dispatchers"];

function renderSection(url = "/dispatch/admin") {
	return render(
		<MemoryRouter initialEntries={[url]}>
			<UsersSection />
		</MemoryRouter>
	);
}

const typeFilter = () => screen.getByRole("group", { name: "Filter by user type" });
const segment = (name: RegExp) => within(typeFilter()).getByRole("button", { name });

describe("UsersSection", () => {
	beforeEach(() => {
		perms.current = [...ALL_PERMS];
	});

	it("has no Administration heading", () => {
		renderSection();
		expect(screen.queryByText("Administration")).toBeNull();
	});

	it("type filter shows counts and filters rows", () => {
		renderSection();
		expect(segment(/^All/)).toHaveTextContent("16");
		expect(segment(/^Technicians/)).toHaveTextContent("14");
		expect(segment(/^Dispatchers/)).toHaveTextContent("2");

		fireEvent.click(segment(/^Dispatchers/));
		expect(screen.getByText("Sam Lee")).toBeInTheDocument();
		expect(screen.queryByText("Tech 00")).toBeNull();
	});

	it("labels system admins with the Admin chip", () => {
		renderSection();
		fireEvent.click(segment(/^Dispatchers/));
		expect(screen.getAllByText("Admin").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Dispatcher").length).toBeGreaterThan(0);
	});

	it("resets to page 1 on type change", () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "2" }));
		expect(screen.getByText(/Showing 13–16 of 16/)).toBeInTheDocument();
		fireEvent.click(segment(/^Technicians/));
		expect(screen.getByText(/Showing 1–12 of 14/)).toBeInTheDocument();
	});

	it("All page size shows every user and drops page navigation", () => {
		renderSection();
		const sizes = screen.getByRole("group", { name: "Rows per page" });
		fireEvent.click(within(sizes).getByRole("button", { name: "All" }));
		expect(screen.getByText("Showing all 16")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
	});

	it("hides pagination when the filtered list fits on one page", () => {
		renderSection();
		fireEvent.click(segment(/^Dispatchers/));
		expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
	});

	it("Clear All resets the type filter", () => {
		renderSection("/dispatch/admin?search=a");
		fireEvent.click(segment(/^Dispatchers/));
		fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
		expect(segment(/^All/)).toHaveAttribute("aria-pressed", "true");
	});

	it("empty state names the filtered type", () => {
		renderSection("/dispatch/admin?search=zzz");
		fireEvent.click(segment(/^Dispatchers/));
		expect(screen.getByText("No dispatchers found.")).toBeInTheDocument();
	});

	it("shows the New user menu with both create permissions", () => {
		renderSection();
		expect(screen.getByRole("button", { name: "New user" })).toBeInTheDocument();
	});

	it("hides creation and row opening for a read-only viewer", () => {
		perms.current = [];
		renderSection();
		expect(
			screen.queryByRole("button", { name: /New user|New technician|New dispatcher/ })
		).toBeNull();
		expect(screen.queryByRole("button", { name: /^Open / })).toBeNull();
	});

	it("list view renders a column header", () => {
		renderSection();
		fireEvent.click(screen.getByRole("button", { name: "List view" }));
		expect(screen.getByText("Last login")).toBeInTheDocument();
	});
});
