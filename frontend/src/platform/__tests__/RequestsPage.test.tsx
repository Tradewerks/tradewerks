import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
	...(await orig<typeof import("react-router-dom")>()),
	useNavigate: () => navigate,
}));
const tiers = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("../hooks", () => ({
	useTiers: () => tiers,
	useRequests: () => ({
		error: null,
		data: {
			rows: [
				{
					id: "r-1",
					organization_id: "org-1",
					org_name: "Acme Heating",
					requested_by_name: "Dana",
					requested_plan_key: "pro",
					requested_plan_label: "Pro",
					requested_modules: [],
					note: null,
					status: "open",
					resolution_note: null,
					resolved_at: null,
					created_at: "2026-10-08T12:00:00Z",
				},
			],
			total: 1,
			page: 1,
			pageSize: 50,
		},
	}),
}));
vi.mock("../components/ResolveRequestDialog", () => ({ default: () => null }));

import RequestsPage from "../pages/RequestsPage";

const pro = {
	key: "pro",
	label: "Pro",
	assignable: true,
	archived_at: null,
	versions: [{ id: "pv-2", version: 2 }],
};

beforeEach(() => {
	navigate.mockClear();
	tiers.data = undefined;
});

describe("RequestsPage Approve", () => {
	it("waits for tiers so a tier request is not treated as unavailable", () => {
		render(<RequestsPage />, { wrapper: MemoryRouter });
		expect(screen.getByRole("button", { name: "Approve…" })).toBeDisabled();
	});

	it("opens the org with the tier change prefilled once tiers load", () => {
		tiers.data = [pro];
		render(<RequestsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getByRole("button", { name: "Approve…" }));
		expect(navigate).toHaveBeenCalledWith("/platform/orgs/org-1", {
			state: {
				prefill: expect.objectContaining({
					requestId: "r-1",
					change: { kind: "plan", planVersionId: "pv-2" },
				}),
			},
		});
	});
});
