import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listJobVisits = vi.fn();
const getJobVisitById = vi.fn();
vi.mock("../../../api/jobs", () => ({
	listJobVisits: (...a: unknown[]) => listJobVisits(...a),
	getJobVisitById: (...a: unknown[]) => getJobVisitById(...a),
	getJobVisitsByJobId: vi.fn().mockResolvedValue([]),
	getJobById: vi.fn().mockResolvedValue({ id: "job-1", tax_snapshot: null }),
}));
vi.mock("../../../api/drafts", () => ({ getDraft: vi.fn() }));
vi.mock("../../../hooks/forms/useDrafts", () => ({
	useDraftsByTypeQuery: () => ({ data: [] }),
	useCreateDraftMutation: () => ({ mutateAsync: vi.fn() }),
	useUpdateDraftMutation: () => ({ mutateAsync: vi.fn() }),
	useDeleteDraftMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useClients", () => ({
	useClientFilterSearch: () => ({ clients: [], onClientQueryChange: vi.fn() }),
}));
vi.mock("../../../hooks/useTechnicians", () => ({ useActiveTechniciansQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useVehicles", () => ({ useVehiclesQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useInventory", () => ({ useAllInventoryQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => false }));
vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [] }) }));
vi.mock("../../../hooks/useEntitlements", () => ({ useModuleOn: () => false }));
vi.mock("../../ui/useToast", () => ({
	useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock("../../ui/DatePicker", () => ({ default: () => null }));
vi.mock("../../ui/forms/TimeConstraints", () => ({ default: () => null }));
vi.mock("../../ui/forms/LineItemsSection", () => ({ default: () => null }));

import CreateJobVisit from "../CreateJobVisit";

describe("CreateJobVisit copy from any job", () => {
	beforeEach(() => {
		listJobVisits.mockReset();
		getJobVisitById.mockReset();
		listJobVisits.mockResolvedValue({
			rows: [
				{
					id: "v-9",
					name: "Slim name",
					status: "Scheduled",
					description: null,
					job: { job_number: "J-9", client: { id: "c1", name: "Acme" } },
				},
			],
		});
		getJobVisitById.mockResolvedValue({
			id: "v-9",
			name: "Full name",
			description: "Full description",
			line_items: [],
		});
	});

	const openAnyJobSearch = async () => {
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<CreateJobVisit isModalOpen setIsModalOpen={vi.fn()} jobId="job-1" createVisit={vi.fn()} />
			</QueryClientProvider>
		);
		await user.click(await screen.findByRole("button", { name: /existing/i }));
		await user.click(await screen.findByRole("button", { name: "This Job" }));
		return user;
	};

	it("sends a server search with q and limit 20 after the debounce", async () => {
		const user = await openAnyJobSearch();
		await waitFor(() => expect(listJobVisits).toHaveBeenCalled());
		listJobVisits.mockClear();

		await user.type(screen.getByPlaceholderText(/Search by visit name/), "furnace");
		expect(listJobVisits).not.toHaveBeenCalled();

		await waitFor(() =>
			expect(listJobVisits).toHaveBeenCalledWith(expect.objectContaining({ q: "furnace", limit: 20 }))
		);
	});

	it("fetches the full visit by id before copying it", async () => {
		const user = await openAnyJobSearch();
		await user.click(await screen.findByText("Slim name"));

		await waitFor(() => expect(getJobVisitById).toHaveBeenCalledWith("v-9"));
		expect(await screen.findByDisplayValue("Full name")).toBeInTheDocument();
	});
});
