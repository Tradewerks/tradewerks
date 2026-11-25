import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getAllJobs = vi.fn();
vi.mock("../../../api/jobs", () => ({
	getAllJobs: (...a: unknown[]) => getAllJobs(...a),
	getJobVisits: vi.fn().mockResolvedValue([]),
	getJobVisitById: vi.fn(),
	getJobVisitsByJobId: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../clients/ClientPicker", () => ({
	default: ({ onChange }: { onChange: (id: string) => void }) => (
		<button onClick={() => onChange("client-7")}>pick client</button>
	),
}));
vi.mock("../../../hooks/useClients", () => ({ useSelectedClient: () => undefined }));
vi.mock("../../../hooks/useInvoices", () => ({
	useCreateInvoiceMutation: () => ({ mutateAsync: vi.fn() }),
	useInvoicesByClientIdQuery: () => ({ data: [] }),
	useOverlapCheckMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => false }));
vi.mock("../../../hooks/useInventory", () => ({ useAllInventoryQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useTaxGroups", () => ({
	useTaxGroups: () => ({ data: [] }),
	useDefaultTaxGroup: () => ({ data: undefined }),
}));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: false } }),
	useImportableQBInvoicesQuery: () => ({ data: [], isFetching: false }),
	useQBInvoicePrefillQuery: () => ({ data: undefined, isFetching: false }),
}));

import CreateInvoice from "../CreateInvoice";

const renderIt = (isModalOpen: boolean) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<CreateInvoice isModalOpen={isModalOpen} setIsModalOpen={vi.fn()} />
		</QueryClientProvider>
	);

describe("CreateInvoice jobs request", () => {
	beforeEach(() => {
		getAllJobs.mockReset();
		getAllJobs.mockResolvedValue([]);
	});

	it("does not request jobs while the modal is closed", async () => {
		renderIt(false);
		await new Promise((r) => setTimeout(r, 20));
		expect(getAllJobs).not.toHaveBeenCalled();
	});

	it("does not request jobs while open with no client picked", async () => {
		renderIt(true);
		await screen.findByText("pick client");
		await new Promise((r) => setTimeout(r, 20));
		expect(getAllJobs).not.toHaveBeenCalled();
	});

	it("requests only the picked client's jobs after a pick", async () => {
		renderIt(true);
		await userEvent.click(await screen.findByText("pick client"));
		await waitFor(() => expect(getAllJobs).toHaveBeenCalledTimes(1));
		expect(getAllJobs).toHaveBeenCalledWith("client-7");
	});
});
