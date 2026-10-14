import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ActivityLog } from "../../../types/logs";
import { useAuthStore } from "../../../auth/authStore";

const { historyState, getClientById, getJobById, getProjectById, getDispatcherById, getOrgRoleById } =
	vi.hoisted(() => ({
		historyState: { data: [] as ActivityLog[], hasMore: false, total: 0 },
		getClientById: vi.fn(async (id: string) => ({ id, name: `Client ${id}` })),
		getJobById: vi.fn(async (id: string) => ({ id, name: `Job ${id}` })),
		getProjectById: vi.fn(async (id: string) => ({ id, name: `Project ${id}` })),
		getDispatcherById: vi.fn(async (id: string) => ({ id, name: `Disp ${id}` })),
		getOrgRoleById: vi.fn(async (id: string) => ({ id, name: `Role ${id}` })),
	}));

vi.mock("../../../hooks/useChangeHistory", () => ({
	CHANGE_HISTORY_PAGE_SIZE: 20,
	CHANGE_HISTORY_REFETCH_MS: 60000,
	useChangeHistory: () => ({
		data: historyState,
		isLoading: false,
		isFetching: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("../../../api/clients", () => ({ getClientById }));
vi.mock("../../../api/jobs", () => ({ getJobById }));
vi.mock("../../../api/project", () => ({ getProjectById }));
vi.mock("../../../api/dispatchers", () => ({ getDispatcherById }));
vi.mock("../../../api/organizations", () => ({ getOrgRoleById }));

import ChangeHistory from "../ChangeHistory";

const mkLog = (i: number, o: Partial<ActivityLog> = {}): ActivityLog => ({
	id: `log-${i}`,
	event_type: "job.updated",
	action: "updated",
	entity_type: "job",
	entity_id: "job-x",
	actor_type: "dispatcher",
	actor_id: "d1",
	actor_name: "Alex",
	changes: { name: { old: `a${i}`, new: `b${i}` } },
	timestamp: new Date(Date.now() - i * 60000).toISOString(),
	ip_address: null,
	user_agent: null,
	reason: null,
	organization_id: "org",
	...o,
});

const loginWith = (permissions: string[]) =>
	useAuthStore.getState().login("dispatcher", "Alex", "d1", "org", "America/Chicago", permissions);

function renderWith(qc?: QueryClient) {
	const client =
		qc ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<ChangeHistory scope={{ kind: "actor", type: "dispatcher", id: "d1" }} />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const chip = (label: string) => screen.getByRole("button", { name: label });

beforeEach(() => {
	vi.clearAllMocks();
	historyState.data = [];
	historyState.hasMore = false;
	historyState.total = 0;
	loginWith(["view_clients", "view_jobs", "view_projects", "view_dispatchers"]);
});

describe("ChangeHistory — L1 sensitive keys", () => {
	it("never renders password values from a dispatcher.password.changed row", () => {
		historyState.data = [
			mkLog(0, {
				event_type: "dispatcher.password.changed",
				action: "changed",
				entity_type: "dispatcher",
				changes: {
					password: { old: "$2a$10$OLDHASHOLDHASHOLDHASH", new: "$2a$10$NEWHASHNEWHASHNEWHASH" },
					reset_token: { old: null, new: "tok_123456" },
				},
			}),
		];
		historyState.total = 1;
		const { container } = renderWith();
		expect(container.textContent).not.toContain("$2a$10$");
		expect(container.textContent).not.toContain("tok_123456");
		expect(container.textContent).not.toMatch(/Password/);
		expect(container.textContent).not.toMatch(/Reset token/);
		// The event itself is still visible, just without its payload.
		expect(container.textContent).toContain("Dispatcher changed by Alex");
	});
});

describe("ChangeHistory — L3 verb filter vs Show more", () => {
	it("keeps 'Show more' visible when the active chips match nothing on the loaded page but hasMore", () => {
		historyState.data = Array.from({ length: 20 }, (_, i) => mkLog(i));
		historyState.hasMore = true;
		historyState.total = 57;
		renderWith();
		expect(screen.getByText("Show more")).toBeInTheDocument();

		// Every loaded row is an update, so it is the only chip shown.
		expect(screen.queryByRole("button", { name: "Deleted" })).toBeNull();
		fireEvent.click(chip("Updated"));

		expect(screen.getByText("No changes match the selected filters.")).toBeInTheDocument();
		expect(screen.getByText("Show more")).toBeInTheDocument();
		expect(screen.getByText(/Showing 0 of 20 loaded/)).toBeInTheDocument();
	});

	it("shows rows with verbs no chip lists under 'Other' (on by default) and hides them when Other is off", () => {
		historyState.data = [
			mkLog(0, {
				event_type: "invoice.auto_creation_failed",
				action: "failed",
				entity_type: "job_visit",
				changes: { reason: { old: null, new: "no client" } },
			}),
			mkLog(1, {
				event_type: "oauth_refresh_token.reuse_detected",
				action: "reuse_detected",
				entity_type: "oauth_refresh_token",
				changes: null,
			}),
			mkLog(2, { event_type: "invoice.push_failed", action: "push_failed", entity_type: "invoice", changes: null }),
			mkLog(3),
		];
		historyState.total = 4;
		const { container } = renderWith();

		expect(chip("Other")).toHaveAttribute("aria-pressed", "true");
		expect(container.textContent).toContain("Visit failed by Alex");
		expect(container.textContent).toContain("Oauth refresh token reuse detected by Alex");
		expect(container.textContent).toContain("Invoice push failed by Alex");
		expect(container.textContent).toContain("Job updated by Alex");
		expect(screen.getByText(/Showing 4 of 4 loaded/)).toBeInTheDocument();

		fireEvent.click(chip("Other"));
		expect(container.textContent).not.toContain("Visit failed by Alex");
		expect(container.textContent).not.toContain("reuse detected");
		expect(container.textContent).not.toContain("push failed");
		expect(container.textContent).toContain("Job updated by Alex");
		expect(screen.getByText(/Showing 1 of 4 loaded/)).toBeInTheDocument();
	});

	it("labels the counter as 'of N loaded' and appends the server total only while there is more", () => {
		historyState.data = Array.from({ length: 5 }, (_, i) => mkLog(i));
		historyState.hasMore = true;
		historyState.total = 42;
		const { rerender } = renderWith();
		expect(screen.getByText("Showing 5 of 5 loaded · 42 total")).toBeInTheDocument();

		historyState.hasMore = false;
		historyState.total = 5;
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<MemoryRouter>
					<ChangeHistory scope={{ kind: "actor", type: "dispatcher", id: "d1" }} />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		expect(screen.getByText("Showing 5 of 5 loaded")).toBeInTheDocument();
		expect(screen.queryByText("Show more")).toBeNull();
	});
});

describe("ChangeHistory — L4 reference lookups", () => {
	it("does not look up roles without manage_roles and renders a truncated id instead", async () => {
		historyState.data = [
			mkLog(0, {
				changes: { organization_role_id: { old: null, new: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
			}),
		];
		historyState.total = 1;
		const { container } = renderWith();
		await new Promise((r) => setTimeout(r, 20));
		expect(getOrgRoleById).not.toHaveBeenCalled();
		expect(container.textContent).toContain("aaaaaaaa…");
		expect(container.textContent).not.toContain("aaaaaaaa-bbbb");
	});

	it("looks up roles (once per distinct id) when the viewer has manage_roles", async () => {
		loginWith(["view_clients", "view_jobs", "manage_roles"]);
		historyState.data = [
			mkLog(0, { changes: { organization_role_id: { old: "r1", new: "r2" } } }),
			mkLog(1, { changes: { organization_role_id: { old: "r2", new: "r1" } } }),
		];
		historyState.total = 2;
		renderWith();
		await waitFor(() => expect(screen.getAllByText(/Role r1/).length).toBeGreaterThan(0));
		expect(getOrgRoleById).toHaveBeenCalledTimes(2);
		expect(new Set(getOrgRoleById.mock.calls.map((c) => c[0]))).toEqual(new Set(["r1", "r2"]));
	});

	it("client/job lookups do not retry on failure (one request per distinct id)", async () => {
		getClientById.mockImplementation(async () => {
			throw Object.assign(new Error("Forbidden"), { response: { status: 403 } });
		});
		getJobById.mockImplementation(async () => {
			throw Object.assign(new Error("Forbidden"), { response: { status: 403 } });
		});
		historyState.data = Array.from({ length: 6 }, (_, i) =>
			mkLog(i, {
				changes: {
					client_id: { old: `c${i % 2}`, new: `c${(i + 1) % 2}` },
					job_id: { old: null, new: `j${i % 3}` },
				},
			}),
		);
		historyState.total = 6;
		// App-like defaults: retry would be 3 unless the hook opts out.
		renderWith(new QueryClient({ defaultOptions: { queries: { retryDelay: 1, gcTime: 0 } } }));
		await new Promise((r) => setTimeout(r, 150));
		expect(getClientById).toHaveBeenCalledTimes(2);
		expect(getJobById).toHaveBeenCalledTimes(3);
	});

	it("renders truncated ids for clients/jobs/projects when the viewer lacks the view permission", async () => {
		loginWith([]);
		historyState.data = [
			mkLog(0, {
				changes: {
					client_id: { old: null, new: "client-0000-1111" },
					job_id: { old: null, new: "job-0000-1111" },
					project_id: { old: null, new: "project-0000-1111" },
				},
			}),
		];
		historyState.total = 1;
		const { container } = renderWith();
		await new Promise((r) => setTimeout(r, 20));
		expect(getClientById).not.toHaveBeenCalled();
		expect(getJobById).not.toHaveBeenCalled();
		expect(getProjectById).not.toHaveBeenCalled();
		expect(container.textContent).toContain("client-0…");
		expect(container.textContent).toContain("job-0000…");
		expect(container.textContent).toContain("project-…");
	});
});
