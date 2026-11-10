import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router-dom";
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
	...(await orig<typeof import("react-router-dom")>()),
	useNavigate: () => navigate,
}));
const ROW = {
	id: "org-1",
	name: "Acme Heating",
	tier: { key: "pro", label: "Pro", version: 2 },
	trial: null as null | { tierLabel: string; endsAt: string },
	template: "hvac",
	usage: null,
};
const state = vi.hoisted(() => ({
	rows: [] as unknown[],
	total: null as number | null,
	useOrgs: vi.fn(),
	createOrg: vi.fn(),
}));
vi.mock("../hooks", () => ({
	useOrgs: (...a: unknown[]) => {
		state.useOrgs(...a);
		return {
			isLoading: false,
			error: null,
			data: { rows: state.rows, total: state.total ?? state.rows.length, page: 1, pageSize: 25 },
		};
	},
	useTiers: () => ({
		data: [
			{
				key: "pro",
				label: "Pro",
				assignable: true,
				archived_at: null,
				is_signup_default: false,
				versions: [],
			},
		],
	}),
	useCreateOrg: () => ({ mutateAsync: state.createOrg, isPending: false, error: null }),
}));
vi.mock("../../hooks/useBusinessTypes", () => ({
	useBusinessTypes: () => ({ data: [{ key: "plumbing", label: "Plumbing" }] }),
}));

import OrgsPage from "../pages/OrgsPage";
import { trialEndsInDays } from "../../lib/trialDays";

beforeEach(() => {
	navigate.mockClear();
	state.useOrgs.mockClear();
	state.createOrg.mockReset();
	state.rows = [ROW];
	state.total = null;
});

describe("OrgsPage rows", () => {
	it("clicking anywhere on the row opens the organization", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getAllByText("Pro v2")[0]);
		expect(navigate).toHaveBeenCalledWith("/platform/orgs/org-1");
	});

	it("clicking the name link leaves navigation to the link", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getAllByRole("link", { name: "Acme Heating" })[0]);
		expect(navigate).not.toHaveBeenCalled();
	});

	it("modifier-click on the row does not navigate in place", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		fireEvent.click(screen.getAllByText("Pro v2")[0], { metaKey: true });
		expect(navigate).not.toHaveBeenCalled();
	});
});

describe("build plan 4", () => {
	const renderPage = () => render(<OrgsPage />, { wrapper: MemoryRouter });

	it("trialEndsInDays rounds partial days up", () => {
		const now = Date.parse("2026-10-20T12:00:00Z");
		expect(trialEndsInDays("2026-10-22T11:00:00Z", now)).toBe(2);
		expect(trialEndsInDays("2026-10-20T13:00:00Z", now)).toBe(1);
	});

	it("shows an ending-soon chip for a trial within 7 days", async () => {
		const endsAt = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
		state.rows = [{ ...ROW, trial: { tierLabel: "Enterprise", endsAt } }];
		renderPage();
		expect((await screen.findAllByText("Trial ends in 3 d")).length).toBeGreaterThan(0);
	});

	const renderAt = (url: string) =>
		render(
			<MemoryRouter initialEntries={[url]}>
				<OrgsPage />
			</MemoryRouter>,
		);

	it("the trial filter asks for trials ending in 7 days", async () => {
		state.rows = [];
		renderPage();
		const u = userEvent.setup();
		await u.click(screen.getByRole("button", { name: /Trial/ }));
		await u.click(screen.getByRole("option", { name: "Trials ending in 7 days" }));
		await waitFor(() => expect(state.useOrgs).toHaveBeenLastCalledWith("", 1, true, undefined));
		expect(screen.getByText("No trials end in the next 7 days.")).toBeInTheDocument();
	});

	it("the tier filter asks for orgs on that tier and resets the page", async () => {
		renderAt("/platform/orgs?page=3");
		const u = userEvent.setup();
		await u.click(screen.getByRole("button", { name: /Tier/ }));
		await u.click(screen.getByRole("option", { name: "Pro" }));
		await waitFor(() =>
			expect(state.useOrgs).toHaveBeenLastCalledWith("", 1, false, {
				key: "pro",
				version: undefined,
			}),
		);
		expect(screen.getAllByText("Tier: Pro").length).toBeGreaterThan(0);
	});

	it("deep link reads tier and version, and names them in the chip", () => {
		state.rows = [];
		renderAt("/platform/orgs?tier=pro&version=2");
		expect(state.useOrgs).toHaveBeenLastCalledWith("", 1, false, { key: "pro", version: 2 });
		expect(screen.getByText("Tier: Pro v2")).toBeInTheDocument();
		expect(screen.getByText("No organizations are on Pro v2.")).toBeInTheDocument();
	});

	it("deep link reads q, trial and page from the URL", () => {
		renderAt("/platform/orgs?q=acme&trial=ending&page=2");
		expect(state.useOrgs).toHaveBeenLastCalledWith("acme", 2, true, undefined);
	});

	it("typing a search resets page to 1", async () => {
		renderAt("/platform/orgs?page=3");
		expect(state.useOrgs).toHaveBeenLastCalledWith("", 3, false, undefined);
		await userEvent.type(screen.getByPlaceholderText("Search organizations..."), "zed");
		await waitFor(() => expect(state.useOrgs).toHaveBeenLastCalledWith("zed", 1, false, undefined));
		expect(state.useOrgs).not.toHaveBeenCalledWith("z", expect.anything(), expect.anything());
	});

	it("Enter in the search box also resets page to 1", async () => {
		renderAt("/platform/orgs?page=3");
		const u = userEvent.setup();
		await u.type(screen.getByPlaceholderText("Search organizations..."), "zed{Enter}");
		await waitFor(() => expect(state.useOrgs).toHaveBeenLastCalledWith("zed", 1, false, undefined));
	});

	it("empty with filters offers Clear filters", async () => {
		state.rows = [];
		renderAt("/platform/orgs?trial=ending");
		expect(screen.getByText("No trials end in the next 7 days.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		await waitFor(() => expect(state.useOrgs).toHaveBeenLastCalledWith("", 1, false, undefined));
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});

	it("ctrl-click a row does not navigate in place", () => {
		renderPage();
		fireEvent.click(screen.getAllByText("Pro v2")[0], { ctrlKey: true });
		expect(navigate).not.toHaveBeenCalled();
	});

	it("New organization creates and then shows the invite link", async () => {
		state.rows = [];
		state.createOrg.mockResolvedValue({
			id: "org-new",
			inviteUrl: "http://x/accept-invite?token=abc",
		});
		renderPage();
		const u = userEvent.setup();
		await u.click(screen.getByRole("button", { name: /new organization/i }));
		await u.type(screen.getByLabelText(/company name/i), "Acme");
		await u.type(screen.getByLabelText(/admin name/i), "Pat");
		await u.type(screen.getByLabelText(/admin email/i), "pat@acme.test");
		await u.selectOptions(screen.getByLabelText(/business type/i), "plumbing");
		await u.selectOptions(screen.getByLabelText(/^tier$/i), "pro");
		await u.click(screen.getByRole("button", { name: /create organization/i }));
		expect(
			await screen.findByDisplayValue("http://x/accept-invite?token=abc"),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /open acme/i })).toHaveAttribute(
			"href",
			"/platform/orgs/org-new",
		);
		expect(state.createOrg.mock.calls[0][0]).toEqual({
			name: "Acme",
			admin_name: "Pat",
			admin_email: "pat@acme.test",
			business_type: "plumbing",
			plan_key: "pro",
		});
	});
});

describe("OrgsPage history", () => {
	it("back to a URL with ?page keeps the page", async () => {
		const router = createMemoryRouter([{ path: "/platform/orgs", element: <OrgsPage /> }], {
			initialEntries: ["/platform/orgs?q=acme&page=2", "/platform/orgs?q=zed"],
			initialIndex: 1,
		});
		render(<RouterProvider router={router} />);
		await act(async () => {
			await router.navigate(-1);
		});
		await waitFor(() => expect(state.useOrgs).toHaveBeenLastCalledWith("acme", 2, false, undefined));
		expect(router.state.location.search).toContain("page=2");
	});
});

describe("OrgsPage pagination", () => {
	it("hides the pager when every org fits on one page", () => {
		render(<OrgsPage />, { wrapper: MemoryRouter });
		expect(screen.queryByRole("navigation", { name: "Pagination" })).toBeNull();
	});

	it("pages through the server total without a page-size picker", () => {
		state.total = 60;
		render(<OrgsPage />, { wrapper: MemoryRouter });
		expect(screen.getByText("Showing 1–25 of 60")).toBeInTheDocument();
		expect(screen.queryByRole("group", { name: "Rows per page" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(state.useOrgs).toHaveBeenLastCalledWith("", 2, false, undefined);
	});
});
