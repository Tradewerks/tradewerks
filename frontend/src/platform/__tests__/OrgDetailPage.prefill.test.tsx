import { fireEvent, render, screen, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
	...(await orig<typeof import("react-router-dom")>()),
	useNavigate: () => navigate,
}));
// Module-level so the dialog's reset effect sees a stable fn.
const resolveStub = { mutate: () => {}, reset: () => {}, isPending: false, error: null };
const applyStub = { mutateAsync: async () => ({}), isPending: false, error: null };
const previewStub = { data: undefined, isFetching: false, error: null, refetch: async () => ({}) };
const h = vi.hoisted(() => ({
	openRequest: null as unknown,
	tiers: { data: [] as unknown, error: null },
}));
vi.mock("../hooks", () => ({
	useOrg: () => ({
		isLoading: false,
		error: null,
		data: {
			org: { id: "org-1", name: "Acme" },
			entitlement: {
				plan_version_id: "pv-2",
				plan_source: "operator",
				template_key: "hvac",
				trial_plan_version_id: null,
				trial_ends_at: null,
				module_choices: {},
				module_grants: {},
				limit_overrides: {},
				updated_at: "t",
			},
			resolved: {
				planKey: "pro",
				planVersion: 2,
				trialActive: false,
				modules: {},
				limits: {},
			},
			usage: null,
			catalog: [],
			breakdown: null,
		},
	}),
	useTiers: () => h.tiers,
	useOrgHistory: () => ({ isLoading: false, data: [] }),
	useOpenRequestFor: () => h.openRequest,
	useResolveRequest: () => resolveStub,
	useApplyChanges: () => applyStub,
	usePreviewChanges: () => previewStub,
}));
vi.mock("../components/ChangeDialog", () => ({
	default: ({
		change,
		title,
		requestId,
	}: {
		change: unknown;
		title: string;
		requestId?: string;
	}) =>
		change ? (
			<p>
				dialog: {title} request: {requestId ?? "none"}
			</p>
		) : null,
}));

import OrgDetailPage from "../pages/OrgDetailPage";

const renderAt = (state?: unknown) =>
	render(
		<MemoryRouter initialEntries={[{ pathname: "/platform/orgs/org-1", state }]}>
			{/* Stands in for the shell's nav and Back, which the page no longer renders. */}
			<Link to="/platform/orgs">Organizations</Link>
			<Routes>
				<Route path="/platform/orgs/:orgId" element={<OrgDetailPage />} />
			</Routes>
		</MemoryRouter>
	);

beforeEach(() => {
	navigate.mockClear();
	h.openRequest = null;
	h.tiers = { data: [], error: null };
});

describe("OrgDetailPage prefill", () => {
	it("seeds the plan draft with a prefilled tier change, opens no dialog, clears router state", () => {
		renderAt({
			prefill: {
				change: { kind: "plan", planVersionId: "pv-3" },
				title: "Approve request: Pro",
			},
		});
		expect(
			screen.getByRole("region", { name: "Unsaved plan changes" })
		).toBeInTheDocument();
		expect(screen.queryByText(/dialog:/)).toBeNull();
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith(
			{ pathname: "/platform/orgs/org-1", search: "" },
			{ replace: true, state: null }
		);
	});

	it("keeps the clicked request id even when the org has no open request cached", () => {
		renderAt({
			prefill: {
				change: { kind: "plan", planVersionId: "pv-3" },
				title: "Approve request: Pro",
				requestId: "r-stale",
			},
		});
		expect(
			screen.getByRole("checkbox", { name: "Mark request approved" })
		).toBeChecked();
	});

	it("still opens the dialog for a prefilled limit change", () => {
		renderAt({
			prefill: {
				change: { kind: "limit", key: "technicians", override: 9 },
				title: "Approve request: seats",
				requestId: "r-1",
			},
		});
		expect(
			screen.getByText("dialog: Approve request: seats request: r-1")
		).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Unsaved plan changes" })).toBeNull();
	});

	it("does nothing without a prefill", () => {
		renderAt();
		expect(screen.queryByText(/dialog:/)).toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("OrgDetailPage request banner", () => {
	beforeEach(() => {
		h.openRequest = {
			id: "r-1",
			requested_by_name: "Dana",
			requested_plan_key: "pro",
			requested_plan_label: "Pro",
			requested_modules: [],
			note: null,
			created_at: "2026-10-08T12:00:00Z",
		};
	});

	it("waits for tiers so the tier part is not shown as unavailable", () => {
		h.tiers = { data: undefined, error: null };
		renderAt();
		expect(
			screen.queryByRole("region", { name: "Open subscription request" })
		).toBeNull();
		expect(screen.queryByText(/no longer available/)).toBeNull();
	});

	it("shows the banner once tiers load", () => {
		renderAt();
		expect(
			screen.getByRole("region", { name: "Open subscription request" })
		).toBeInTheDocument();
	});

	it("Apply seeds the draft with the box ticked, not a dialog", () => {
		h.tiers = {
			data: [
				{
					key: "pro",
					label: "Pro",
					assignable: true,
					archived_at: null,
					versions: [
						{ id: "pv-3", version: 3, modules: [], limits: {} },
					],
				},
			],
			error: null,
		};
		renderAt();
		const banner = screen.getByRole("region", { name: "Open subscription request" });
		fireEvent.click(within(banner).getByRole("button", { name: "Apply…" }));
		expect(screen.queryByText(/dialog:/)).toBeNull();
		expect(
			screen.getByRole("checkbox", { name: "Mark request approved" })
		).toBeChecked();
	});
});

describe("OrgDetailPage unsaved draft guard", () => {
	const startDraft = () =>
		renderAt({
			prefill: { change: { kind: "plan", planVersionId: "pv-3" }, title: "Tier" },
		});

	it("asks before leaving through an in-app link, and leaves on confirm", () => {
		startDraft();
		navigate.mockClear();
		fireEvent.click(screen.getByRole("link", { name: "Organizations" }));
		expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
		expect(navigate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
		expect(navigate).toHaveBeenCalledWith("/platform/orgs");
	});

	it("stays on the page on Cancel", () => {
		startDraft();
		fireEvent.click(screen.getByRole("link", { name: "Organizations" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
		expect(
			screen.getByRole("region", { name: "Unsaved plan changes" })
		).toBeInTheDocument();
	});

	it("warns the browser before unload while a draft exists", () => {
		startDraft();
		const ev = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
	});

	it("does not guard without a draft", () => {
		renderAt();
		const ev = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
	});
});
