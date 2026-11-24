import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RecurringPlanDetailPage from "../RecurringPlanDetailPage";
import type { RecurringOccurrence, RecurringPlan } from "../../../types/recurringPlans";

const renewAsync = vi.fn().mockResolvedValue({});
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null };

let plan: RecurringPlan;
let occurrences: RecurringOccurrence[];

vi.mock("../../../hooks/useRecurringPlans", () => ({
	useRecurringPlanByIdQuery: () => ({ data: plan, isLoading: false, error: null }),
	useRecurringTaxEstimateQuery: () => ({ data: undefined }),
	useOccurrencesByJobIdQuery: () => ({ data: occurrences, isLoading: false }),
	usePauseRecurringPlanMutation: () => idle,
	useResumeRecurringPlanMutation: () => idle,
	useCancelRecurringPlanMutation: () => idle,
	useCompleteRecurringPlanMutation: () => idle,
	useRenewRecurringPlanMutation: () => ({ ...idle, mutateAsync: renewAsync }),
	useGenerateOccurrencesMutation: () => idle,
	useGenerateVisitFromOccurrenceMutation: () => idle,
	useSkipOccurrenceMutation: () => idle,
}));
vi.mock("../../../hooks/useInvoices", () => ({ useGenerateInvoiceMutation: () => idle }));
vi.mock("../../../components/ui/DatePicker", () => ({
	default: ({ onChange }: { onChange: (d: Date) => void }) => (
		<button onClick={() => onChange(new Date(2027, 0, 15))}>pick date</button>
	),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../../../components/recurringPlans/RecurringTaxEstimate", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientDetailsCard", () => ({ default: () => null }));
vi.mock("../../../components/recurringPlans/RecurringPlanNoteManager", () => ({ default: () => null }));
vi.mock("../../../components/recurringPlans/EditRecurringPlan", () => ({ default: () => null }));
vi.mock("../../../components/recurringPlans/SkippedDatesCard", () => ({ default: () => null }));
vi.mock("../../../components/activity/ChangeHistory", () => ({ default: () => null }));

const day = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();

const occ = (over: Partial<RecurringOccurrence>): RecurringOccurrence =>
	({
		id: "o",
		recurring_plan_id: "p1",
		occurrence_start_at: iso(-3),
		occurrence_end_at: iso(-3),
		status: "planned",
		job_visit_id: null,
		job_visit: null,
		template_version: 1,
		created_at: "",
		...over,
	}) as unknown as RecurringOccurrence;

const basePlan = {
	id: "p1",
	client_id: "c1",
	name: "Quarterly PM",
	description: "",
	address: "1 Main St",
	priority: "Normal",
	status: "Active",
	starts_at: "2026-01-01T00:00:00.000Z",
	ends_at: null,
	timezone: "America/Chicago",
	billing_mode: "none",
	invoice_timing: "per_visit",
	auto_invoice: false,
	rules: [],
	line_items: [],
	job_container: { id: "job-1", job_number: "J-1", name: "PM", status: "Scheduled" },
} as unknown as RecurringPlan;

const renderPage = (search = "") =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={[`/dispatch/recurring-plans/p1${search}`]}>
				<Routes>
					<Route path="/dispatch/recurring-plans/:recurringPlanId" element={<RecurringPlanDetailPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	renewAsync.mockClear();
	plan = basePlan;
	occurrences = [];
});

describe("RecurringPlanDetailPage", () => {
	it("a past planned occurrence without a visit appears under Missed", () => {
		occurrences = [
			occ({ id: "past", status: "planned" }),
			occ({ id: "future", status: "planned", occurrence_start_at: iso(5), occurrence_end_at: iso(5) }),
		];
		renderPage("?tab=schedule");
		const missed = screen.getByRole("region", { name: /missed \/ needs action/i });
		expect(within(missed).getByRole("button", { name: /create visit/i })).toBeTruthy();
		expect(within(missed).getByRole("button", { name: /skip/i })).toBeTruthy();
		expect(within(missed).getAllByTestId("missed-row")).toHaveLength(1);
	});

	it("a past generated occurrence whose visit is still Scheduled appears under Missed with Open visit", () => {
		occurrences = [
			occ({
				id: "gen",
				status: "generated",
				job_visit_id: "v1",
				job_visit: { id: "v1", status: "Scheduled" } as never,
			}),
		];
		renderPage("?tab=schedule");
		const missed = screen.getByRole("region", { name: /missed \/ needs action/i });
		expect(within(missed).getByRole("button", { name: /open visit/i })).toBeTruthy();
	});

	it("an Expired plan shows Renew and not Pause", () => {
		plan = { ...basePlan, status: "Expired" } as RecurringPlan;
		renderPage();
		expect(screen.getByRole("button", { name: /renew/i })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /pause/i })).toBeNull();
	});

	it("shows the invoice schedule's last failure in the billing card", () => {
		plan = {
			...basePlan,
			billing_mode: "scheduled",
			invoice_schedule: {
				is_active: true,
				frequency: "monthly",
				billing_basis: "fixed_amount",
				last_failure_message: "Client has no billing email",
			},
		} as unknown as RecurringPlan;
		renderPage();
		expect(screen.getByText(/client has no billing email/i)).toBeTruthy();
	});

	it("keeps a missed row out of Upcoming", () => {
		occurrences = [occ({ id: "past", status: "planned" })];
		renderPage("?tab=schedule");
		expect(screen.getByText("No Upcoming Occurrences")).toBeTruthy();
		expect(screen.getAllByTestId("missed-row")).toHaveLength(1);
	});

	it("does not route visits to Missed on a terminal plan", () => {
		plan = { ...basePlan, status: "Cancelled" } as RecurringPlan;
		occurrences = [
			occ({
				id: "gen",
				status: "generated",
				job_visit_id: "v1",
				job_visit: { id: "v1", status: "Scheduled" } as never,
			}),
		];
		renderPage("?tab=schedule");
		expect(screen.queryByTestId("missed-row")).toBeNull();
		expect(screen.getByText("View Visit")).toBeTruthy();
	});

	it("disables Create visit on a paused plan but leaves Skip enabled", () => {
		plan = { ...basePlan, status: "Paused" } as RecurringPlan;
		occurrences = [occ({ id: "past", status: "planned" })];
		renderPage("?tab=schedule");
		const create = screen.getByRole("button", { name: /create visit/i }) as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		expect(create.title).toBe("Plan is paused");
		expect((screen.getByRole("button", { name: "Skip" }) as HTMLButtonElement).disabled).toBe(
			false
		);
	});

	it("shows Resume on a paused plan", () => {
		plan = { ...basePlan, status: "Paused" } as RecurringPlan;
		renderPage();
		expect(screen.getByRole("button", { name: /resume/i })).toBeTruthy();
	});

	it("shows no lifecycle actions on a terminal plan", () => {
		plan = { ...basePlan, status: "Completed" } as RecurringPlan;
		renderPage();
		for (const name of [/pause/i, /resume/i, /renew/i, /complete plan/i]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
	});

	it("renew sends null for No end date", async () => {
		plan = { ...basePlan, status: "Expired" } as RecurringPlan;
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: /renew plan/i }));
		fireEvent.click(screen.getByRole("switch", { name: /no end date/i }));
		fireEvent.click(screen.getByRole("button", { name: "Renew" }));
		await waitFor(() => expect(renewAsync).toHaveBeenCalledWith({ jobId: "job-1", ends_at: null }));
	});

	it("renew sends noon-local ISO for a picked date", async () => {
		plan = { ...basePlan, status: "Expired" } as RecurringPlan;
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: /renew plan/i }));
		fireEvent.click(screen.getByText("pick date"));
		fireEvent.click(screen.getByRole("button", { name: "Renew" }));
		await waitFor(() =>
			expect(renewAsync).toHaveBeenCalledWith({
				jobId: "job-1",
				ends_at: new Date(2027, 0, 15, 12).toISOString(),
			})
		);
	});
});
