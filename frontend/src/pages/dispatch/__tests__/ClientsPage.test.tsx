import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ClientsPage from "../ClientsPage";

const client = (name: string, is_tax_exempt: boolean) => ({
	id: name,
	name,
	address: "1 Main St",
	is_active: true,
	is_tax_exempt,
});

vi.mock("../../../hooks/useClients", () => ({
	useAllClientsQuery: () => ({
		data: [client("Exempt Co", true), client("Taxed Co", false)],
		isLoading: false,
		error: null,
	}),
	useCreateClientMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../components/clients/CreateClient", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientCard", () => ({
	default: ({ client }: { client: { name: string } }) => <div>{client.name}</div>,
}));
vi.mock("../../../components/reports/usePageReport", () => ({ usePageReport: () => ({}) }));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const renderAt = (url: string) =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<Routes>
				<Route path="/dispatch/clients" element={<ClientsPage />} />
			</Routes>
		</MemoryRouter>,
	);

// Matches the report popover's Tax Status breakdown, so its slices can drill here.
describe("ClientsPage tax status filter", () => {
	it("shows only exempt clients for tax=exempt, with a removable chip", () => {
		renderAt("/dispatch/clients?tax=exempt");
		expect(screen.getByText("Exempt Co")).toBeInTheDocument();
		expect(screen.queryByText("Taxed Co")).toBeNull();
		expect(screen.getByText("Tax: Exempt")).toBeInTheDocument();
	});

	it("shows only taxable clients for tax=taxable", () => {
		renderAt("/dispatch/clients?tax=taxable");
		expect(screen.getByText("Taxed Co")).toBeInTheDocument();
		expect(screen.queryByText("Exempt Co")).toBeNull();
	});

	it("offers the filter in the page controls", async () => {
		renderAt("/dispatch/clients");
		await userEvent.click(screen.getByRole("button", { name: /^Tax status/ }));
		await userEvent.click(screen.getByRole("option", { name: "Exempt" }));
		expect(screen.queryByText("Taxed Co")).toBeNull();
	});
});
