import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { JobVisit } from "../../../types/jobs";

// The tech dashboard, map and mileage read the bounded /assigned window, never the
// every-visit-ever /technicians/:id/visits endpoint.

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
	useTranslation: () => ({
		t: (k: string, o?: { miles?: string }) => (o?.miles ? `${o.miles} mi` : k),
		i18n: { language: "en" },
	}),
}));
vi.mock("../../../components/ui/maps/DynamicMap", () => ({
	default: ({ staticMarkers }: { staticMarkers: { id: string }[] }) => (
		<div data-testid="markers">{staticMarkers.map((m) => m.id).join(",")}</div>
	),
}));

import TechnicianMileagePage from "../TechnicianMileagePage";
import TechnicianMapPage from "../TechnicianMapPage";

const mine = (id: string, extra: Partial<JobVisit> = {}) =>
	({
		id,
		name: id,
		status: "Scheduled",
		scheduled_start_at: new Date().toISOString(),
		estimated_drive_miles: 4,
		visit_techs: [{ tech_id: "tech-1" }],
		job: { name: id, address: "1 Main", coords: { lat: 1, lon: 2 }, client: { name: "Acme" } },
		...extra,
	}) as unknown as JobVisit;

const claimable = mine("pool", { visit_techs: [] });

const renderPage = (ui: React.ReactElement) => {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter>{ui}</MemoryRouter>
		</QueryClientProvider>,
	);
};

beforeEach(() => {
	vi.clearAllMocks();
	getAssignedVisits.mockResolvedValue([mine("v1"), claimable]);
});

describe("technician pages on the assigned window", () => {
	it("mileage asks /assigned for the viewed week only and moves the window with the week", async () => {
		renderPage(<TechnicianMileagePage />);
		await waitFor(() => expect(getAssignedVisits).toHaveBeenCalledTimes(1));
		const first = getAssignedVisits.mock.calls[0][0] as { from: string; to: string };
		expect(new Date(first.to).getTime() - new Date(first.from).getTime()).toBeGreaterThanOrEqual(
			7 * 24 * 3600_000 - 3600_000,
		);
		expect(new Date(first.to).getTime() - new Date(first.from).getTime()).toBeLessThanOrEqual(
			7 * 24 * 3600_000 + 3600_000,
		);

		await userEvent.click(screen.getAllByRole("button")[0]);
		await waitFor(() => expect(getAssignedVisits).toHaveBeenCalledTimes(2));
		const second = getAssignedVisits.mock.calls[1][0] as { from: string; to: string };
		expect(new Date(second.to).getTime()).toBe(new Date(first.from).getTime());
		expect(getJobVisitsByTechId).not.toHaveBeenCalled();
	});

	it("map plots only the caller's own open visits, not the claimable pool", async () => {
		renderPage(<TechnicianMapPage />);
		await waitFor(() => expect(screen.getByTestId("markers").textContent).toBe("v1"));
		expect(getJobVisitsByTechId).not.toHaveBeenCalled();
	});
});
