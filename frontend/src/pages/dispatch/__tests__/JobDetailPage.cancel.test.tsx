import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobDetailPage from "../JobDetailPage";
import { useAuthStore } from "../../../auth/authStore";
import type { Job, JobVisit } from "../../../types/jobs";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const cancelJob = vi.fn().mockResolvedValue({});
const cancelVisit = vi.fn();

let job: Job;
let visits: JobVisit[];

vi.mock("../../../hooks/useJobs", () => ({
	useJobByIdQuery: () => ({ data: job, isLoading: false }),
	useJobVisitsByJobIdQuery: () => ({ data: visits }),
	useCreateJobVisitMutation: () => idle,
	useDeleteJobMutation: () => idle,
	useCancelJobMutation: () => ({ ...idle, mutateAsync: cancelJob }),
	useCancelJobVisitMutation: () => ({ ...idle, mutateAsync: cancelVisit }),
}));
vi.mock("../../../hooks/useInvoices", () => ({
	useInvoicesByJobIdQuery: () => ({ data: [], isLoading: false }),
}));
const { qbTaxCalculation, modulesOn } = vi.hoisted(() => ({
	qbTaxCalculation: vi.fn((_enabled: boolean) => ({ data: { qb_calculates_tax: false } })),
	modulesOn: new Set<string>(),
}));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBTaxCalculationQuery: qbTaxCalculation,
}));
vi.mock("../../../hooks/useEntitlements", async (importActual) => ({
	...(await importActual<typeof import("../../../hooks/useEntitlements")>()),
	useEntitlements: () => ({ data: undefined, isLoading: false }),
	useModule: (key: string) => (modulesOn.has(key) ? "on" : "off"),
	useModuleOn: (key: string) => modulesOn.has(key),
}));
vi.mock("../../../hooks/useRecordMapData", () => ({ useActiveTechCount: () => 0 }));
vi.mock("../../../hooks/useTaxSettings", () => ({ useAcknowledgeTaxReview: () => idle }));
vi.mock("../../../components/jobs/JobMapTab", () => ({ default: () => null }));
vi.mock("../../../components/jobs/JobNoteManager", () => ({ default: () => null }));
vi.mock("../../../components/fieldPurchases/JobFieldPurchases", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientDetailsCard", () => ({ default: () => null }));
vi.mock("../../../components/jobs/EditJob", () => ({ default: () => null }));
vi.mock("../../../components/jobs/CreateJobVisit", () => ({ default: () => null }));
vi.mock("../../../components/invoices/CreateInvoice", () => ({ default: () => null }));
vi.mock("../../../components/invoices/LinkedInvoicesCard", () => ({ default: () => null }));
vi.mock("../../../components/activity/ChangeHistory", () => ({ default: () => null }));
vi.mock("../../../components/detail/ActivityPanel", () => ({ default: () => null }));
vi.mock("../../../components/lifecycle/LifecycleRecord", () => ({ default: () => null }));

const baseJob = {
	id: "job-1",
	job_number: "J-0011",
	name: "Furnace",
	client_id: "c1",
	address: "1 Main St",
	status: "Scheduled",
	priority: "Normal",
	created_at: "2026-09-01T00:00:00.000Z",
	line_items: [],
	notes: [],
} as unknown as Job;

const visit = (id: string, status: string) =>
	({
		id,
		job_id: "job-1",
		status,
		scheduled_start_at: "2026-09-02T15:00:00.000Z",
		scheduled_end_at: "2026-09-02T17:00:00.000Z",
		line_items: [],
	}) as unknown as JobVisit;

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/dispatch/jobs/job-1"]}>
				<Routes>
					<Route path="/dispatch/jobs/:jobId" element={<JobDetailPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	useAuthStore
		.getState()
		.login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["view_jobs", "edit_jobs"]);
	modulesOn.clear();
	cancelJob.mockClear();
	cancelVisit.mockClear();
	visits = [visit("v1", "Scheduled"), visit("v2", "InProgress"), visit("v3", "Completed")];
	job = baseJob;
});

describe("JobDetailPage cancel", () => {
	it("Cancel Job sends one POST /jobs/:id/cancel, not one request per visit", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Job actions" }));
		await user.click(screen.getByRole("menuitem", { name: /Cancel Job/ }));
		expect(
			screen.getByText("Cancels this job and its 2 open visits with the reason below.")
		).toBeInTheDocument();

		await user.type(screen.getByLabelText("Reason"), "  Customer moved  ");
		await user.click(screen.getByRole("button", { name: "Cancel Job" }));

		await waitFor(() => expect(cancelJob).toHaveBeenCalledTimes(1));
		expect(cancelJob).toHaveBeenCalledWith({ jobId: "job-1", reason: "Customer moved" });
		expect(cancelVisit).not.toHaveBeenCalled();
	});

	it("shows the server's refusal in the modal", async () => {
		cancelJob.mockRejectedValueOnce(new Error("This job is complete. Cancel its invoice instead."));
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Job actions" }));
		await user.click(screen.getByRole("menuitem", { name: /Cancel Job/ }));
		await user.type(screen.getByLabelText("Reason"), "x");
		await user.click(screen.getByRole("button", { name: "Cancel Job" }));

		expect(
			await screen.findByText("This job is complete. Cancel its invoice instead.")
		).toBeInTheDocument();
	});

	it("can cancel a job that has no visits", async () => {
		visits = [];
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Job actions" }));
		await user.click(screen.getByRole("menuitem", { name: /Cancel Job/ }));
		expect(screen.getByText("Cancels this job with the reason below.")).toBeInTheDocument();
		await user.type(screen.getByLabelText("Reason"), "Duplicate");
		await user.click(screen.getByRole("button", { name: "Cancel Job" }));

		await waitFor(() => expect(cancelJob).toHaveBeenCalledTimes(1));
	});
});
