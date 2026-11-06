import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import JobsPage from "../JobsPage";
import { useAuthStore } from "../../../auth/authStore";
import type { Job } from "../../../types/jobs";
import type { RecurringPlan } from "../../../types/recurringPlans";

const { state } = vi.hoisted(() => ({
	state: { jobs: [] as unknown[], plans: [] as unknown[] },
}));

vi.mock("../../../hooks/useJobs", () => ({
	useAllJobsQuery: () => ({ data: state.jobs, isLoading: false, error: null }),
	useCreateJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useRecurringPlans", () => ({
	useAllRecurringPlansQuery: () => ({ data: state.plans, isLoading: false, error: null }),
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
	client: { name: "Acme" },
	client_id: "c1",
	visits: [],
	estimated_total: 100,
} as unknown as Job;

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

const renderAt = (url: string) =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<Routes>
				<Route path="/dispatch/jobs" element={<JobsPage />} />
			</Routes>
		</MemoryRouter>,
	);

beforeEach(() => {
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
