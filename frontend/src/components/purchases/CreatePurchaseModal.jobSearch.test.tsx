import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getJobsPage = vi.fn();
vi.mock("../../api/jobs", () => ({
	getJobsPage: (...a: unknown[]) => getJobsPage(...a),
	getJobById: vi.fn(),
	getJobVisits: vi.fn().mockResolvedValue([]),
	getJobVisitsByJobId: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../hooks/useVehicles", () => ({ useVehiclesQuery: () => ({ data: [] }) }));
vi.mock("../../hooks/useTaxGroups", () => ({
	useTaxGroups: () => ({ data: [] }),
	useDefaultTaxGroup: () => ({ data: undefined }),
}));
vi.mock("../../hooks/useSuppliers", () => ({ useSuppliers: () => ({ data: [] }) }));
vi.mock("../../hooks/useInventory", () => ({ useCatalogSearchQuery: () => ({ data: [] }) }));
vi.mock("../../hooks/usePermission", () => ({ usePermission: () => false }));
vi.mock("../suppliers/SupplierFormModal", () => ({ default: () => null }));
vi.mock("../inventory/CreateInventoryItem", () => ({ default: () => null }));

import CreatePurchaseModal from "./CreatePurchaseModal";

describe("CreatePurchaseModal job search", () => {
	beforeEach(() => {
		getJobsPage.mockReset();
		getJobsPage.mockResolvedValue({ rows: [] });
	});

	it("searches jobs only once a line is job-costed", async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<CreatePurchaseModal isModalOpen setIsModalOpen={vi.fn()} createPurchaseOrder={vi.fn()} />
			</QueryClientProvider>
		);
		const select = (await screen.findByDisplayValue("Not set")) as HTMLSelectElement;
		await new Promise((r) => setTimeout(r, 20));
		expect(getJobsPage).not.toHaveBeenCalled();

		await userEvent.selectOptions(select, "non_stock");
		await screen.findByPlaceholderText("Search jobs…");
		await vi.waitFor(() => expect(getJobsPage).toHaveBeenCalledTimes(1));

		getJobsPage.mockClear();
		await userEvent.selectOptions(select, "receive");
		await new Promise((r) => setTimeout(r, 20));
		expect(getJobsPage).not.toHaveBeenCalled();
	});
});
