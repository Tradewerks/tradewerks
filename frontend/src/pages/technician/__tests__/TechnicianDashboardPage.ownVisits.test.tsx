import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { JobVisit } from "../../../types/jobs";

// The dashboard's cards come from the bounded own-visits read; the unbounded
// per-tech endpoint is never requested.

const getAssignedVisits = vi.fn();
const getJobVisitsByTechId = vi.fn();
vi.mock("../../../api/jobs", () => ({
	getAssignedVisits: (...a: unknown[]) => getAssignedVisits(...a),
	getJobVisitsByTechId: (...a: unknown[]) => getJobVisitsByTechId(...a),
}));
vi.mock("../../../auth/authStore", () => ({
	useAuthStore: () => ({ user: { userId: "tech-1", orgTimezone: "UTC" } }),
}));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => false }));
vi.mock("../../../hooks/useTechnicians", () => ({
	useTechnicianByIdQuery: () => ({ data: undefined }),
	useGoAvailableMutation: () => ({ mutateAsync: vi.fn() }),
	useGoOfflineMutation: () => ({ mutateAsync: vi.fn() }),
	useGoOnBreakMutation: () => ({ mutateAsync: vi.fn() }),
	useMarkDoneMutation: () => ({ mutateAsync: vi.fn() }),
	useReturnFromJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../components/technicianComponents/TechVisitCard", () => ({
	default: ({ visit }: { visit: JobVisit }) => <div data-testid="visit-card">{visit.name}</div>,
}));
vi.mock("../../../components/technicianComponents/AddNotePhotoModal", () => ({ default: () => null }));

import TechnicianDashboardPage from "../TechnicianDashboardPage";

const visit = (id: string, extra: Partial<JobVisit> = {}) =>
	({
		id,
		name: id,
		status: "InProgress",
		scheduled_start_at: "2020-01-01T10:00:00.000Z",
		scheduled_end_at: "2020-01-01T11:00:00.000Z",
		visit_techs: [{ tech_id: "tech-1" }],
		time_entries: [{ tech_id: "tech-1", clocked_out_at: null }],
		job: { name: id, address: "1 Main", client: { name: "Acme" } },
		...extra,
	}) as unknown as JobVisit;

beforeEach(() => {
	vi.clearAllMocks();
	// A stale in-progress visit (the server keeps it on Mine) plus a pool visit that must not show.
	getAssignedVisits.mockResolvedValue([visit("stale"), visit("pool", { visit_techs: [] })]);
});

describe("TechnicianDashboardPage own visits", () => {
	it("renders cards from the own-visits source and never requests the per-tech endpoint", async () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MemoryRouter>
					<TechnicianDashboardPage />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		await waitFor(() => expect(screen.getAllByTestId("visit-card").length).toBeGreaterThan(0));
		expect(screen.getAllByTestId("visit-card").every((c) => c.textContent === "stale")).toBe(true);
		expect(getAssignedVisits).toHaveBeenCalledWith(undefined, { own: true });
		expect(getJobVisitsByTechId).not.toHaveBeenCalled();
	});
});
