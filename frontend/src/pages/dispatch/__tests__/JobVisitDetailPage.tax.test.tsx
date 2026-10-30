import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobVisitDetailPage from "../JobVisitDetailPage";
import { useAuthStore } from "../../../auth/authStore";
import type { Job, JobVisit } from "../../../types/jobs";
import type { TaxSnapshot, TaxSource } from "../../../types/tax";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

let visit: JobVisit;
let job: Job;

vi.mock("../../../hooks/useJobs", () => ({
	useJobVisitByIdQuery: () => ({ data: visit, isLoading: false }),
	useJobByIdQuery: () => ({ data: job, isLoading: false }),
	useVisitTransitionMutation: () => idle,
	useCompleteJobVisitMutation: () => idle,
	useCancelJobVisitMutation: () => idle,
	useDelayJobVisitMutation: () => idle,
}));
vi.mock("../../../hooks/useInvoices", () => ({
	useInvoicesByVisitIdQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../../hooks/useRecordMapData", () => ({ useActiveTechCount: () => 0 }));
vi.mock("../../../components/ui/maps/RecordMap", () => ({ default: () => null }));
vi.mock("../../../components/arrivals/VisitArrivalCard", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientDetailsCard", () => ({ default: () => null }));
vi.mock("../../../components/jobs/EditJobVisit", () => ({ default: () => null }));
vi.mock("../../../components/jobs/JobNoteManager", () => ({ default: () => null }));
vi.mock("../../../components/fieldPurchases/JobFieldPurchases", () => ({ default: () => null }));
vi.mock("../../../components/invoices/CreateInvoice", () => ({ default: () => null }));
vi.mock("../../../components/invoices/LinkedInvoicesCard", () => ({ default: () => null }));
vi.mock("../../../components/detail/ActivityPanel", () => ({ default: () => null }));

const snap = (source: TaxSource | null): TaxSnapshot =>
	({
		version: 2,
		source,
		rounding: "jurisdiction_half_up",
		rate_set_id: "g1",
		locked_at: "draft",
		client_exempt: false,
		non_taxable_amount_cents: 0,
		total_tax_cents: 550,
		subtotal_cents: 10000,
		discount_cents: 0,
		total_cents: 10550,
		effective_rate: 0.055,
		groups: [
			{
				id: "g1",
				name: "La Crosse, WI (auto)",
				rates: [{ id: "s", name: "WI", rate: 0.055, jurisdiction_type: "state" }],
				taxable_amount_cents: 10000,
				tax_amount_cents: 550,
			},
		],
	}) as unknown as TaxSnapshot;

const makeVisit = (tax_snapshot: TaxSnapshot | null) =>
	({
		id: "v1",
		job_id: "job-1",
		name: "Visit",
		status: "Scheduled",
		arrival_constraint: "anytime",
		finish_constraint: "when_done",
		scheduled_start_at: "2026-09-02T15:00:00.000Z",
		scheduled_end_at: "2026-09-02T17:00:00.000Z",
		total: 105.5,
		subtotal: 100,
		tax_snapshot,
		visit_techs: [],
		line_items: [
			{ id: "l1", name: "Part", item_type: "Material", quantity: 1, unit_price: 100, total: 100, taxable: true },
		],
		job: {
			id: "job-1",
			job_number: "J-0010",
			name: "Furnace",
			client: { name: "Acme" },
		},
	}) as unknown as JobVisit;

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/dispatch/jobs/job-1/visits/v1?tab=financials"]}>
				<Routes>
					<Route
						path="/dispatch/jobs/:jobId/visits/:visitId"
						element={<JobVisitDetailPage />}
					/>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	useAuthStore
		.getState()
		.login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["view_jobs", "edit_jobs"]);
	job = { id: "job-1", job_number: "J-0010", name: "Furnace" } as unknown as Job;
});

describe("JobVisitDetailPage financials tax provenance", () => {
	it("shows the address-rate chip, place and basis from the visit's own source", () => {
		visit = makeVisit(snap("provider"));
		renderPage();
		expect(screen.getByTitle("Rate looked up from the service address")).toBeInTheDocument();
		expect(screen.getByText("Rates for La Crosse, WI")).toBeInTheDocument();
		expect(screen.getByText("Taxable lines $100.00")).toBeInTheDocument();
	});

	it("falls back to the job's tax source when the visit snapshot has none", () => {
		visit = makeVisit(snap(null));
		visit.job = { ...visit.job!, tax_source: "manual_override" } as JobVisit["job"];
		renderPage();
		expect(screen.getByText("Tax group")).toBeInTheDocument();
	});

	it("flags a pending tax review on the job with a link to it", () => {
		visit = makeVisit(snap("provider"));
		visit.job = {
			...visit.job!,
			tax_needs_review: true,
			tax_review_ack_at: null,
		} as JobVisit["job"];
		renderPage();
		expect(screen.getByText(/Tax review is pending on the job/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /job/i })).toHaveAttribute(
			"href",
			"/dispatch/jobs/job-1"
		);
	});

	it("omits the review line once acknowledged", () => {
		visit = makeVisit(snap("provider"));
		visit.job = {
			...visit.job!,
			tax_needs_review: true,
			tax_review_ack_at: "2026-09-03T00:00:00.000Z",
		} as JobVisit["job"];
		renderPage();
		expect(screen.queryByText(/Tax review is pending/)).toBeNull();
	});
});
