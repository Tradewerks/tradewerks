import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { JobVisit } from "../../../types/jobs";

// Past now also holds open visits that ended before the Mine window, so the real
// card renders here: an abandoned Scheduled visit must not read as done.

const getAssignedVisits = vi.fn();
const getAssignedPastVisits = vi.fn();
vi.mock("../../../api/jobs", () => ({
	getAssignedVisits: (...a: unknown[]) => getAssignedVisits(...a),
	getAssignedPastVisits: (...a: unknown[]) => getAssignedPastVisits(...a),
}));
vi.mock("../../../components/technicianComponents/VisitActionButtons", () => ({
	default: () => <div data-testid="visit-actions" />,
}));
vi.mock("../../../auth/authStore", () => ({
	useAuthStore: () => ({ user: { userId: "tech-1", orgTimezone: "UTC" } }),
}));

import TechnicianVisitsPage from "../TechnicianVisitsPage";

const visit = (id: string, name: string, status: string): JobVisit =>
	({
		id,
		name,
		status,
		scheduled_start_at: "2026-01-05T15:00:00.000Z",
		scheduled_end_at: "2026-01-05T16:00:00.000Z",
		visit_techs: [{ tech_id: "tech-1", tech: { id: "tech-1", name: "Tech" } }],
		time_entries: [],
		job: { client: { name: "Acme" }, address: "1 Main" },
	}) as unknown as JobVisit;

beforeEach(() => {
	vi.clearAllMocks();
	getAssignedVisits.mockResolvedValue([]);
});

describe("TechnicianVisitsPage — Past tab status", () => {
	it("an overdue open visit on the Past tab shows its real status", async () => {
		getAssignedPastVisits.mockResolvedValue({
			rows: [visit("v1", "Stale visit", "Scheduled"), visit("v2", "Done visit", "Completed")],
			total: 2,
			page: 1,
			limit: 20,
		});
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MemoryRouter>
					<TechnicianVisitsPage />
				</MemoryRouter>
			</QueryClientProvider>
		);
		await userEvent.click(screen.getByRole("button", { name: "Past" }));

		const stale = await screen.findByTitle("Stale visit");
		const staleHeader = within(stale.parentElement!);
		expect(staleHeader.getByText("Overdue")).toBeInTheDocument();
		expect(staleHeader.queryByText("Completed")).not.toBeInTheDocument();
		expect(stale).not.toHaveClass("line-through");

		const done = screen.getByTitle("Done visit");
		expect(within(done.parentElement!).getByText("Completed")).toBeInTheDocument();
		expect(done).toHaveClass("line-through");
	});
});
