import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { JobVisit } from "../../../types/jobs";
import type { PagedResult } from "../../../types/paging";

// The Past tab reads the paged past scope through the real hooks; only the api
// module and the card (its action buttons carry their own data layer) are stubbed.

const getAssignedVisits = vi.fn();
const getAssignedPastVisits = vi.fn();
vi.mock("../../../api/jobs", () => ({
	getAssignedVisits: (...a: unknown[]) => getAssignedVisits(...a),
	getAssignedPastVisits: (...a: unknown[]) => getAssignedPastVisits(...a),
}));
vi.mock("../../../components/technicianComponents/TechVisitCard", () => ({
	default: ({ visit }: { visit: JobVisit }) => <div data-testid="visit-card">{visit.name}</div>,
}));
vi.mock("../../../auth/authStore", () => ({
	useAuthStore: () => ({ user: { userId: "tech-1", orgTimezone: "UTC" } }),
}));

import TechnicianVisitsPage from "../TechnicianVisitsPage";
import { qk } from "../../../lib/queryKeys";

const visit = (n: number): JobVisit =>
	({
		id: `v${n}`,
		name: `Visit ${n}`,
		status: "Completed",
		scheduled_start_at: "2026-01-01T00:00:00.000Z",
		scheduled_end_at: "2026-01-01T01:00:00.000Z",
		visit_techs: [{ tech_id: "tech-1" }],
		job: { client: { name: "Acme" }, address: "1 Main" },
	}) as unknown as JobVisit;

const page = (from: number, count: number, total: number, pageNo: number): PagedResult<JobVisit> => ({
	rows: Array.from({ length: count }, (_, i) => visit(from + i)),
	total,
	page: pageNo,
	limit: 20,
});

function renderPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>
				<TechnicianVisitsPage />
			</MemoryRouter>
		</QueryClientProvider>
	);
}

async function openPast() {
	await userEvent.click(screen.getByRole("button", { name: "Past" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	getAssignedVisits.mockResolvedValue([]);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TechnicianVisitsPage — Past tab", () => {
	it("Past tab loads the first page of past visits", async () => {
		getAssignedPastVisits.mockResolvedValue(page(1, 20, 45, 1));
		renderPage();
		await openPast();

		expect(await screen.findByText("Visit 1")).toBeInTheDocument();
		expect(screen.getAllByTestId("visit-card")).toHaveLength(20);
		expect(getAssignedPastVisits).toHaveBeenCalledTimes(1);
		expect(getAssignedPastVisits).toHaveBeenCalledWith({ page: 1, limit: 20 });
		expect(screen.getByText("Showing 20 of 45")).toBeInTheDocument();
	});

	it("Load more fetches the next page and appends", async () => {
		getAssignedPastVisits
			.mockResolvedValueOnce(page(1, 20, 45, 1))
			.mockResolvedValueOnce(page(21, 20, 45, 2));
		renderPage();
		await openPast();
		await screen.findByText("Visit 20");

		await userEvent.click(screen.getByRole("button", { name: "Load more" }));

		expect(await screen.findByText("Visit 40")).toBeInTheDocument();
		expect(screen.getByText("Visit 1")).toBeInTheDocument();
		expect(screen.getAllByTestId("visit-card")).toHaveLength(40);
		expect(getAssignedPastVisits).toHaveBeenLastCalledWith({ page: 2, limit: 20 });
		expect(screen.getByText("Showing 40 of 45")).toBeInTheDocument();
	});

	it("Load more hides when all pages are loaded", async () => {
		getAssignedPastVisits
			.mockResolvedValueOnce(page(1, 20, 25, 1))
			.mockResolvedValueOnce(page(21, 5, 25, 2));
		renderPage();
		await openPast();
		await screen.findByText("Visit 20");

		await userEvent.click(screen.getByRole("button", { name: "Load more" }));

		expect(await screen.findByText("Visit 25")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
		expect(screen.getByText("Showing 25 of 25")).toBeInTheDocument();
	});

	it("past pages live under the assigned key the tech socket invalidates", () => {
		expect(qk.visits.assignedPast(20).slice(0, 2)).toEqual([...qk.visits.assigned()]);
	});

	it("a failed next page does not auto-retry", async () => {
		// The sentinel reports visible every time it is observed, as it would on a
		// short list, so any re-arm after the failure would fire another request.
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				cb: (entries: Array<{ isIntersecting: boolean }>) => void;
				constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
					this.cb = cb;
				}
				observe() {
					setTimeout(() => this.cb([{ isIntersecting: true }]), 0);
				}
				disconnect() {}
				unobserve() {}
			}
		);
		getAssignedPastVisits
			.mockResolvedValueOnce(page(1, 20, 45, 1))
			.mockRejectedValue(new Error("400"));
		renderPage();
		await openPast();
		await screen.findByText("Visit 20");

		expect(await screen.findByText("Couldn't load more")).toBeInTheDocument();
		await new Promise((r) => setTimeout(r, 50));
		expect(getAssignedPastVisits).toHaveBeenCalledTimes(2);
		// Rows stay; the whole-list failure message is not shown over them.
		expect(screen.getAllByTestId("visit-card")).toHaveLength(20);
		expect(screen.queryByText("Failed to load visits.")).not.toBeInTheDocument();

		// The button is the manual retry.
		getAssignedPastVisits.mockResolvedValueOnce(page(21, 20, 45, 2));
		await userEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Visit 40")).toBeInTheDocument();
	});

	it("pages that overlap after a shift do not repeat rows", async () => {
		getAssignedPastVisits
			.mockResolvedValueOnce(page(1, 20, 45, 1))
			// A visit moved into Past between reads, so page 2 repeats row 20.
			.mockResolvedValueOnce(page(20, 20, 45, 2));
		renderPage();
		await openPast();
		await screen.findByText("Visit 20");

		await userEvent.click(screen.getByRole("button", { name: "Load more" }));

		expect(await screen.findByText("Visit 39")).toBeInTheDocument();
		expect(screen.getAllByText("Visit 20")).toHaveLength(1);
		expect(screen.getAllByTestId("visit-card")).toHaveLength(39);
	});

	it("loads the next page when the end of the list scrolls into view", async () => {
		let notify: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
					notify = cb;
				}
				observe() {}
				disconnect() {}
				unobserve() {}
			}
		);
		getAssignedPastVisits
			.mockResolvedValueOnce(page(1, 20, 45, 1))
			.mockResolvedValueOnce(page(21, 20, 45, 2));
		renderPage();
		await openPast();
		await screen.findByText("Visit 20");

		await waitFor(() => expect(notify).toBeDefined());
		notify!([{ isIntersecting: true }]);

		expect(await screen.findByText("Visit 40")).toBeInTheDocument();
	});
});
