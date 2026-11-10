import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AccessCard, { type AccessCardUser } from "../AccessCard";
import type { OrganizationRole } from "../../../types/organizations";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAssign = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
let mockRoles: OrganizationRole[] = [];

vi.mock("../../../hooks/useOrgRoles", () => ({
	useOrgRolesQuery: () => ({ data: mockRoles }),
	useAssignOrgRoleMutation: () => ({ mutateAsync: mockAssign, isPending: false }),
	useUpdateOrgRoleMutation: () => ({ mutateAsync: mockUpdate, isPending: false }),
	useCreateOrgRoleMutation: () => ({ mutateAsync: mockCreate, isPending: false }),
}));

vi.mock("../../../hooks/usePermission", () => ({
	usePermission: () => true,
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CURRENT_ROLE_ID = "role-current";

function makeRole(overrides: Partial<OrganizationRole> & { id: string }): OrganizationRole {
	return {
		name: overrides.id,
		base_tier: "dispatcher",
		permissions: [],
		is_default: false,
		_count: { dispatchers: 2, technicians: 0 },
		...overrides,
	};
}

function makeUser(overrides: Partial<AccessCardUser> = {}): AccessCardUser {
	return {
		id: "disp-1",
		name: "Pat",
		role: "dispatcher",
		permissions: ["view_jobs"],
		organization_role: { id: CURRENT_ROLE_ID, name: "Basic" },
		...overrides,
	};
}

// Enter edit mode and swap the single held permission (View Jobs) for View Clients,
// so the draft becomes exactly {view_clients} — a set both tiers can express.
// jsdom renders both layouts; click in the stacked (phone) one.
async function draftViewClientsOnly() {
	await userEvent.click(screen.getByRole("button", { name: "Edit access" }));
	const stacked = within(screen.getByRole("list"));
	await userEvent.click(stacked.getByTitle("view_jobs"));
	await userEvent.click(stacked.getByTitle("view_clients"));
	await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockAssign.mockResolvedValue(true);
	mockUpdate.mockResolvedValue({});
	mockCreate.mockResolvedValue({ id: "role-new" });
	mockRoles = [];
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AccessCard — tier-aware role matching", () => {
	it("assigns the same-tier role even when a technician role has identical permissions", async () => {
		mockRoles = [
			makeRole({ id: CURRENT_ROLE_ID, name: "Basic", permissions: ["view_jobs"] }),
			makeRole({ id: "tech-match", base_tier: "technician", permissions: ["view_clients"] }),
			makeRole({ id: "disp-match", base_tier: "dispatcher", permissions: ["view_clients"] }),
		];
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
		expect(mockAssign).toHaveBeenCalledWith({
			user_id: "disp-1",
			user_type: "dispatcher",
			role_id: "disp-match",
		});
	});

	it("ignores a technician-tier match and offers to create a new role instead", async () => {
		mockRoles = [
			makeRole({ id: CURRENT_ROLE_ID, name: "Basic", permissions: ["view_jobs"] }),
			makeRole({ id: "tech-match", base_tier: "technician", permissions: ["view_clients"] }),
		];
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		expect(await screen.findByText("Name the new role")).toBeInTheDocument();
		expect(mockAssign).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
	});
});

describe("AccessCard — default role protection", () => {
	it("never rewrites the org default role in place, even for its only member", async () => {
		mockRoles = [
			makeRole({
				id: CURRENT_ROLE_ID,
				name: "Default Dispatcher",
				permissions: ["view_jobs"],
				is_default: true,
				_count: { dispatchers: 1, technicians: 0 },
			}),
		];
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		expect(await screen.findByText("Name the new role")).toBeInTheDocument();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("updates a non-default role in place when the user is its only member", async () => {
		mockRoles = [
			makeRole({
				id: CURRENT_ROLE_ID,
				name: "Solo",
				permissions: ["view_jobs"],
				_count: { dispatchers: 1, technicians: 0 },
			}),
		];
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ id: CURRENT_ROLE_ID, permissions: ["view_clients"] }),
		);
		expect(screen.queryByText("Name the new role")).not.toBeInTheDocument();
	});
});

describe("AccessCard — failures are visible", () => {
	it("shows the assign error inline and stays in edit mode", async () => {
		mockRoles = [
			makeRole({ id: CURRENT_ROLE_ID, name: "Basic", permissions: ["view_jobs"] }),
			makeRole({ id: "disp-match", permissions: ["view_clients"] }),
		];
		mockAssign.mockRejectedValue(new Error("Role \"X\" is a technician role and cannot be assigned to a dispatcher"));
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("cannot be assigned to a dispatcher");
		// still editing: Save/Cancel visible, Edit access not
		expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Edit access" })).not.toBeInTheDocument();
	});

	it("shows the update error inline and stays in edit mode", async () => {
		mockRoles = [
			makeRole({
				id: CURRENT_ROLE_ID,
				name: "Solo",
				permissions: ["view_jobs"],
				_count: { dispatchers: 1, technicians: 0 },
			}),
		];
		mockUpdate.mockRejectedValue(new Error("Failed to update organization role"));
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		expect(await screen.findByRole("alert")).toHaveTextContent("Failed to update organization role");
		expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
	});

	it("leaves edit mode after a successful assign", async () => {
		mockRoles = [
			makeRole({ id: CURRENT_ROLE_ID, name: "Basic", permissions: ["view_jobs"] }),
			makeRole({ id: "disp-match", permissions: ["view_clients"] }),
		];
		render(<AccessCard user={makeUser()} tier="dispatcher" />);

		await draftViewClientsOnly();

		expect(await screen.findByRole("button", { name: "Edit access" })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
