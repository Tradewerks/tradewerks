import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobDetailPage from "../JobDetailPage";
import { useAuthStore } from "../../../auth/authStore";
import type { Job, JobVisit } from "../../../types/jobs";
import type { TaxSnapshot } from "../../../types/tax";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

let job: Job;
let visits: JobVisit[];

vi.mock("../../../hooks/useJobs", () => ({
	useJobByIdQuery: () => ({ data: job, isLoading: false }),
	useJobVisitsByJobIdQuery: () => ({ data: visits }),
	useCreateJobVisitMutation: () => idle,
	useDeleteJobMutation: () => idle,
	useCancelJobVisitMutation: () => idle,
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

const state = { id: "s", name: "WI", rate: 0.05, jurisdiction_type: "state" };
const snap = (cents: number, subtotalCents: number): TaxSnapshot => ({
	version: 2,
	source: "provider",
	rounding: "jurisdiction_half_up",
	rate_set_id: "g1",
	locked_at: "draft",
	client_exempt: false,
	non_taxable_amount_cents: 0,
	total_tax_cents: cents,
	subtotal_cents: subtotalCents,
	discount_cents: 0,
	total_cents: subtotalCents + cents,
	effective_rate: 0.05,
	groups: [
		{
			id: "g1",
			name: "La Crosse, WI (auto)",
			rates: [state],
			taxable_amount_cents: subtotalCents,
			tax_amount_cents: cents,
		},
	],
});

const baseJob = {
	id: "job-1",
	job_number: "J-0010",
	name: "Furnace",
	client_id: "c1",
	address: "1 Main St",
	status: "In Progress",
	priority: "Normal",
	created_at: "2026-09-01T00:00:00.000Z",
	subtotal: 200,
	tax_source: "provider",
	line_items: [
		{ id: "l1", name: "Labor", item_type: "Labor", quantity: 1, unit_price: 200, total: 200, taxable: true },
	],
	notes: [],
} as unknown as Job;

const visit = (id: string, status: string, tax_snapshot: TaxSnapshot | null) =>
	({
		id,
		job_id: "job-1",
		status,
		scheduled_start_at: "2026-09-02T15:00:00.000Z",
		scheduled_end_at: "2026-09-02T17:00:00.000Z",
		tax_snapshot,
		line_items: [
			{ id: `${id}-l`, name: "Part", item_type: "Material", quantity: 1, unit_price: 100, total: 100, taxable: true },
		],
	}) as unknown as JobVisit;

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/dispatch/jobs/job-1?tab=financials"]}>
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
	visits = [];
	modulesOn.clear();
	qbTaxCalculation.mockClear();
});

describe("JobDetailPage QuickBooks tax-calculation query", () => {
	it("stays off without the QuickBooks module", () => {
		job = { ...baseJob, tax_amount: 10, tax_snapshot: snap(1000, 20000) } as Job;
		renderPage();
		expect(qbTaxCalculation).toHaveBeenCalled();
		expect(qbTaxCalculation.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
	});

	it("runs with the QuickBooks module on and a taxable line", () => {
		modulesOn.add("quickbooks");
		job = { ...baseJob, tax_amount: 10, tax_snapshot: snap(1000, 20000) } as Job;
		renderPage();
		expect(qbTaxCalculation).toHaveBeenLastCalledWith(true);
	});
});

describe("JobDetailPage financials tax rows", () => {
	it("sums the job and completed visit tax into one named row", () => {
		job = { ...baseJob, tax_amount: 10, tax_snapshot: snap(1000, 20000) } as Job;
		visits = [
			visit("v1", "Completed", snap(500, 10000)),
			visit("v2", "Scheduled", snap(999, 10000)),
		];
		renderPage();
		expect(screen.getByText("Wisconsin state (5%):")).toBeInTheDocument();
		expect(screen.getByText("$15.00")).toBeInTheDocument();
	});

	it("keeps the job's tax row when the job has no snapshot", () => {
		job = { ...baseJob, tax_amount: 10.4, tax_rate: 0.052, tax_snapshot: null } as Job;
		renderPage();
		expect(screen.getByText("Job charges tax (5.2%):")).toBeInTheDocument();
		expect(screen.getByText("$10.40")).toBeInTheDocument();
	});

	it("shows the job's own tax beside visit tax for a manual job", () => {
		job = { ...baseJob, tax_amount: 7.25, tax_rate: 0.03625, tax_snapshot: null } as Job;
		visits = [visit("v1", "Completed", snap(500, 10000))];
		renderPage();
		expect(screen.getByText("$7.25")).toBeInTheDocument();
		expect(screen.getByText("$5.00")).toBeInTheDocument();
		expect(screen.getByText("Total Tax:").nextSibling).toHaveTextContent("$12.25");
	});

	it("does not show a stale job snapshot's tax", () => {
		job = { ...baseJob, tax_amount: 7.25, tax_snapshot: snap(1000, 20000) } as Job;
		visits = [visit("v1", "Completed", snap(500, 10000))];
		renderPage();
		expect(screen.getByText("$7.25")).toBeInTheDocument();
		expect(screen.queryByText("$10.00")).toBeNull();
	});
});
