import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgDetail, StaffChangesPreview, TierRow } from "../types";

const { success, state, tiers } = vi.hoisted(() => {
	const tiers: TierRow[] = [
		{
			key: "pro",
			label: "Pro",
			assignable: true,
			archived_at: null,
			is_signup_default: false,
			is_trial_default: false,
			versions: [
				{
					id: "pv-3",
					version: 3,
					modules: ["inventory"],
					limits: {},
					note: null,
					created_at: "",
					org_count: 0,
					trial_org_count: 0,
				},
			],
		},
	];
	return {
		success: vi.fn(),
		state: {
			detail: null as unknown as OrgDetail,
			preview: null as unknown as StaffChangesPreview,
		},
		tiers,
	};
});

vi.mock("../../components/ui/useToast", () => ({
	useToast: () => ({ success, error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
// Module-level so the dialog's reset effect sees a stable fn.
const resolveStub = { mutate: () => {}, reset: () => {}, isPending: false, error: null };
const applyStub = { mutateAsync: async () => ({}), isPending: false, error: null };
const previewStub = {
	get data() {
		return state.preview;
	},
	isFetching: false,
	error: null,
	refetch: async () => ({}),
};
vi.mock("../hooks", () => ({
	useOrg: () => ({ isLoading: false, error: null, data: state.detail }),
	useTiers: () => ({ data: tiers, error: null }),
	useOrgHistory: () => ({ isLoading: false, data: [] }),
	useOpenRequestFor: () => null,
	useResolveRequest: () => resolveStub,
	useApplyChanges: () => applyStub,
	usePreviewChanges: () => previewStub,
}));
vi.mock("../components/ChangeDialog", () => ({ default: () => null }));

import OrgDetailPage from "../pages/OrgDetailPage";

const makeDetail = (trial: boolean): OrgDetail => ({
	org: { id: "org-1", name: "Acme" },
	entitlement: {
		plan_version_id: "pv-2",
		plan_source: "operator",
		template_key: "hvac",
		trial_plan_version_id: trial ? "tv-1" : null,
		trial_ends_at: trial ? "2026-10-21T12:00:00Z" : null,
		module_choices: {},
		module_grants: {},
		limit_overrides: {},
		updated_at: "t",
	},
	resolved: {
		planKey: "pro",
		planVersion: 2,
		trialActive: trial,
		modules: { inventory: "not_in_plan" },
		limits: {},
	},
	usage: null,
	catalog: [{ key: "inventory", label: "Inventory", kind: "optional" }],
	breakdown: {
		modules: { inventory: { state: "not_in_plan", source: "not_in_tier" } },
		limits: {} as never,
		baseTier: { key: "pro", label: "Pro", version: 2 },
		trialTier: trial
			? { key: "max", label: "Max", version: 1, endsAt: "2026-10-21T12:00:00Z" }
			: null,
	},
});
const diff = (gained: string[]) => ({ gained, lost: [], raised: [], lowered: [] });

const renderPage = () =>
	render(
		<MemoryRouter initialEntries={["/platform/orgs/org-1"]}>
			<Routes>
				<Route path="/platform/orgs/:orgId" element={<OrgDetailPage />} />
			</Routes>
		</MemoryRouter>
	);
const inventoryRow = () => screen.getByText("Inventory").closest("li")!;

beforeEach(() => success.mockClear());

const saveDraft = async () => {
	fireEvent.change(screen.getByLabelText("New tier"), { target: { value: "pv-3" } });
	// The preview is debounced; Save stays disabled until it settles.
	await act(() => new Promise((r) => setTimeout(r, 300)));
	fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Customer asked" } });
	fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
};

describe("OrgDetailPage after saving the plan draft", () => {
	it("toasts the change, marks the changed row and resets the tier picker", async () => {
		state.detail = makeDetail(false);
		state.preview = {
			before: {} as never,
			after: {} as never,
			diff: diff(["inventory"]),
			blockers: [],
			overCap: [],
			breakdown: state.detail.breakdown!,
		};
		renderPage();
		await saveDraft();

		await waitFor(() =>
			expect(success).toHaveBeenCalledWith("Plan saved · Inventory on")
		);
		expect(within(inventoryRow()).getByText(/Changed just now/)).toBeInTheDocument();
		expect(screen.getByLabelText("New tier")).toHaveValue("");
	});

	it("says nothing changes today for a tier change during a trial", async () => {
		state.detail = makeDetail(true);
		state.preview = {
			before: {} as never,
			after: {} as never,
			diff: diff([]),
			blockers: [],
			overCap: [],
			breakdown: state.detail.breakdown!,
		};
		renderPage();
		await saveDraft();

		await waitFor(() =>
			expect(success).toHaveBeenCalledWith("Plan saved · Saved. No change today.")
		);
	});
});
