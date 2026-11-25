import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobsPage from "../JobsPage";
import { useAuthStore } from "../../../auth/authStore";
import type { ListParams, PagedResult } from "../../../types/paging";
import type { RecurringPlan } from "../../../types/recurringPlans";

const { state, getJobsPage, plansEnabled } = vi.hoisted(() => ({
	state: { jobs: [] as unknown[], plans: [] as unknown[] },
	getJobsPage: vi.fn(),
	plansEnabled: [] as (boolean | undefined)[],
}));

vi.mock("../../../api/jobs", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/jobs")>()),
	getJobsPage,
}));
vi.mock("../../../hooks/useJobs", () => ({
	useCreateJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useRecurringPlans", () => ({
	useAllRecurringPlansQuery: (enabled?: boolean) => {
		plansEnabled.push(enabled);
		return { data: state.plans, isLoading: false, error: null };
	},
}));
vi.mock("../../../hooks/useClients", () => ({
	useClientByIdQuery: () => ({ data: undefined }),
}));
vi.mock("../../../components/jobs/CreateJob", () => ({ default: () => null }));
vi.mock("../../../components/recurringPlans/CreateRecurringPlan", () => ({ default: () => null }));
const mockUsePageReport = vi.fn();
vi.mock("../../../components/reports/usePageReport", () => ({
	usePageReport: (...args: unknown[]) => mockUsePageReport(...args),
}));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const job = {
	id: "job-1",
	job_number: "J-1001",
	name: "Furnace tune-up",
	address: "12 Job Street",
	status: "Scheduled",
	priority: "High",
	client: { id: "c1", name: "Acme" },
	client_id: "c1",
	visits: [],
	estimated_total: 100,
	created_at: "2026-06-01T00:00:00Z",
};

const jobRow = (n: number, status = "Scheduled") => ({
	...job,
	id: `job-${n}`,
	job_number: `J-${n}`,
	name: `Job ${n}`,
	status,
});

const pageOf = (params: ListParams, rows: unknown[]): PagedResult<unknown> => ({
	rows,
	total: 120,
	page: params.page,
	limit: params.limit,
});

const plan = {
	id: "plan-1",
	client_id: "c1",
	name: "Quarterly filter swap",
	description: "",
	address: "742 Evergreen Terrace",
	priority: "Medium",
	status: "Active",
	starts_at: "2026-01-01",
	timezone: "America/Chicago",
	generation_window_days: 30,
	min_advance_days: 1,
	billing_mode: "per_visit",
	invoice_timing: "on_completion",
	auto_invoice: false,
	created_at: "2026-01-01",
	updated_at: "2026-01-01",
	client: { name: "Acme" },
	occurrences: [],
	line_items: [],
} as unknown as RecurringPlan;

const renderAt = (url: string) => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>
				<Routes>
					<Route path="/dispatch/jobs" element={<JobsPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
};

beforeEach(() => {
	getJobsPage.mockReset();
	getJobsPage.mockImplementation((params: ListParams) =>
		Promise.resolve(pageOf(params, state.jobs)),
	);
	state.jobs = [job];
	state.plans = [plan];
	useAuthStore
		.getState()
		.login("dispatcher", "Alex", "d1", "org", "America/Chicago", [
			"view_jobs",
			"create_jobs",
			"manage_recurring_plans",
		]);
});

describe("JobsPage columns (U7 / 05-F2)", () => {
	it("Jobs view hides the Property column (address is rendered inside the job cell)", async () => {
		renderAt("/dispatch/jobs");
		expect(await screen.findByText("Furnace tune-up")).toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "Property" })).toBeNull();
		expect(screen.getByText("12 Job Street")).toBeInTheDocument();
	});

	it("Templates view shows the Property column so the plan address is visible", async () => {
		renderAt("/dispatch/jobs?view=templates");
		expect(await screen.findByText("Quarterly filter swap")).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: "Property" })).toBeInTheDocument();
		expect(screen.getByText("742 Evergreen Terrace")).toBeInTheDocument();
	});
});

describe("JobsPage report (recurring plans get their own)", () => {
	it("asks for the jobs report in the Jobs view", async () => {
		renderAt("/dispatch/jobs");
		await screen.findByRole("table");
		expect(mockUsePageReport).toHaveBeenLastCalledWith("jobs", "Jobs report", { allowed: true });
	});

	it("asks for the recurring-plans report in the Templates view", async () => {
		renderAt("/dispatch/jobs?view=templates");
		await screen.findByRole("table");
		expect(mockUsePageReport).toHaveBeenLastCalledWith("recurring_plans", "Recurring plans report", {
			allowed: true,
		});
	});

	it("disallows the plans report for a user who can't see plans", async () => {
		useAuthStore
			.getState()
			.login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["view_jobs"]);
		renderAt("/dispatch/jobs?view=templates");
		await screen.findByRole("group", { name: "View context" });
		expect(mockUsePageReport).toHaveBeenLastCalledWith("recurring_plans", "Recurring plans report", {
			allowed: false,
		});
	});

	it("marks the Jobs/Plans toggle as a report-context control", async () => {
		renderAt("/dispatch/jobs");
		const group = await screen.findByRole("group", { name: "View context" });
		expect(group).toHaveAttribute("data-report-context");
	});

	it("offers forward Date presets in the Plans view (a plan's date is its next visit)", async () => {
		renderAt("/dispatch/jobs?view=templates");
		await userEvent.click(await screen.findByRole("button", { name: /^Date/ }));
		expect(screen.getByText("Next 30 days")).toBeInTheDocument();
	});

	it("Today shows every plan running today, whatever its next visit", async () => {
		renderAt("/dispatch/jobs?view=templates&date=today");
		expect(await screen.findByText("Quarterly filter swap")).toBeInTheDocument();
	});

	it("hides a plan that ended before the range", async () => {
		state.plans = [{ ...plan, ends_at: "2026-02-01" }];
		renderAt("/dispatch/jobs?view=templates&date=today");
		await screen.findByRole("group", { name: "View context" });
		expect(screen.queryByText("Quarterly filter swap")).toBeNull();
	});

	it("offers one coherent Plans date menu: past and future ranges, no Tomorrow", async () => {
		renderAt("/dispatch/jobs?view=templates");
		await userEvent.click(await screen.findByRole("button", { name: /^Date/ }));
		for (const label of ["Today", "Last 30 days", "This month", "Next 30 days", "Next month"]) {
			expect(screen.getByText(label)).toBeInTheDocument();
		}
		expect(screen.queryByText("Tomorrow")).toBeNull();
	});
});

describe("JobsPage server paging", () => {
	it("changing page requests page 2 and keeps page 1 as placeholder", async () => {
		let release!: (v: PagedResult<unknown>) => void;
		getJobsPage.mockImplementation((params: ListParams) =>
			params.page === 1
				? Promise.resolve(pageOf(params, [jobRow(1)]))
				: new Promise((res) => (release = res)),
		);
		renderAt("/dispatch/jobs");
		await screen.findByText("Job 1");

		fireEvent.click(screen.getByLabelText("Next page"));

		await waitFor(() =>
			expect(getJobsPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ page: 2 }),
				expect.anything(),
			),
		);
		// Page 2 is still in flight: page 1's rows stay on screen.
		expect(screen.getByText("Job 1")).toBeTruthy();

		await act(async () => release(pageOf({ page: 2, limit: 50 }, [jobRow(51)])));
		await screen.findByText("Job 51");
		expect(screen.queryByText("Job 1")).toBeNull();
	});

	it("status in the URL pre-selects the filter", async () => {
		getJobsPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [jobRow(1, "InProgress")])),
		);
		renderAt("/dispatch/jobs?status=InProgress&status=Scheduled");
		await screen.findByText("Job 1");

		expect(getJobsPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1, status: ["InProgress", "Scheduled"] }),
			expect.anything(),
		);
		expect(screen.getByText("Status: In Progress")).toBeTruthy();
		expect(screen.getByText("Status: Scheduled")).toBeTruthy();
	});

	it("sends every search chip as one space-joined q", async () => {
		renderAt("/dispatch/jobs?search=acme&search=main");
		await waitFor(() =>
			expect(getJobsPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ q: "acme main" }),
				expect.anything(),
			),
		);
	});

	it("maps the Job # sort to job_number", async () => {
		renderAt("/dispatch/jobs?sort=jobNumber&dir=asc");
		await screen.findByText("Furnace tune-up");
		expect(getJobsPage.mock.calls[0][0]).toMatchObject({ sort: "job_number", dir: "asc" });
	});

	it("drops the retired Date sort from the request and the chips", async () => {
		renderAt("/dispatch/jobs?sort=date&dir=asc");
		await waitFor(() => expect(getJobsPage).toHaveBeenCalled());
		expect(getJobsPage.mock.calls[0][0].sort).toBeUndefined();
		expect(screen.queryByText(/^Sort:/)).toBeNull();
	});

	it("does not fetch jobs in the Templates view", async () => {
		renderAt("/dispatch/jobs?view=templates");
		await screen.findByText("Quarterly filter swap");
		expect(getJobsPage).not.toHaveBeenCalled();
	});

	it("the Jobs view does not enable the recurring-plans download; Templates does", async () => {
		plansEnabled.length = 0;
		renderAt("/dispatch/jobs");
		await waitFor(() => expect(getJobsPage).toHaveBeenCalled());
		expect(plansEnabled.every((e) => e === false)).toBe(true);

		plansEnabled.length = 0;
		renderAt("/dispatch/jobs?view=templates");
		await screen.findByText("Quarterly filter swap");
		expect(plansEnabled).toContain(true);
	});
});
