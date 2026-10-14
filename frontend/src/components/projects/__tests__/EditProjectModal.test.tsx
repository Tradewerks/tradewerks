import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditProjectModal from "../EditProjectModal";
import type { Project } from "../../../types/project";

const CLIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISPATCHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("../../../hooks/useClients", () => ({
	useAllClientsQuery: () => ({ data: [{ id: CLIENT_ID, name: "Acme HVAC" }] }),
}));

vi.mock("../../../hooks/useDispatchers", () => ({
	useActiveDispatchersQuery: () => ({ data: [{ id: DISPATCHER_ID, name: "Dana Dispatcher" }] }),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		project_number: "P-0001",
		name: "Rooftop replacement",
		description: "Scope",
		client_id: CLIENT_ID,
		client: { id: CLIENT_ID, name: "Acme HVAC" },
		status: "Active",
		priority: "Medium",
		address: "1 Main St",
		coords: null,
		budget: null,
		starts_at: null,
		target_end_at: null,
		created_at: "2026-01-01T00:00:00.000Z",
		jobs: [],
		manager_dispatcher_id: DISPATCHER_ID,
		manager_dispatcher: { id: DISPATCHER_ID, name: "Dana Dispatcher" },
		...overrides,
	};
}

const mockUpdateProject = vi.fn();

function renderModal(project = makeProject()) {
	return render(
		<EditProjectModal
			isModalOpen
			setIsModalOpen={vi.fn()}
			project={project}
			updateProject={mockUpdateProject}
		/>,
	);
}

function managerSelect() {
	return screen.getByRole("option", { name: "Unassigned" }).closest("select") as HTMLSelectElement;
}

// The modal renders through a portal, so query the document rather than the container.
function dateInputs() {
	const inputs = document.querySelectorAll<HTMLInputElement>('input[type="date"]');
	return { start: inputs[0], end: inputs[1] };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUpdateProject.mockResolvedValue("");
});

describe("EditProjectModal — clearable fields", () => {
	it("sends manager_dispatcher_id: null when the manager is set to Unassigned", async () => {
		renderModal();

		await userEvent.selectOptions(managerSelect(), "");
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => expect(mockUpdateProject).toHaveBeenCalledTimes(1));
		expect(mockUpdateProject.mock.calls[0][0]).toEqual(
			expect.objectContaining({ manager_dispatcher_id: null, client_id: CLIENT_ID }),
		);
	});

	it("sends description: '' and address: '' when those fields are cleared", async () => {
		renderModal();

		await userEvent.clear(screen.getByPlaceholderText("Site address"));
		await userEvent.clear(screen.getByPlaceholderText("Scope, phasing, notes..."));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => expect(mockUpdateProject).toHaveBeenCalledTimes(1));
		expect(mockUpdateProject.mock.calls[0][0]).toEqual(
			expect.objectContaining({ description: "", address: "" }),
		);
	});
});

describe("EditProjectModal — client-side validation", () => {
	it("blocks submit and shows an error when the target end is before the start", async () => {
		renderModal();
		const { start, end } = dateInputs();

		fireEvent.change(start, { target: { value: "2026-09-10" } });
		fireEvent.change(end, { target: { value: "2026-09-01" } });
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		expect(
			await screen.findByText("Target end date cannot be before the start date"),
		).toBeInTheDocument();
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});

	it("submits when the target end is on or after the start", async () => {
		renderModal();
		const { start, end } = dateInputs();

		fireEvent.change(start, { target: { value: "2026-09-01" } });
		fireEvent.change(end, { target: { value: "2026-09-10" } });
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => expect(mockUpdateProject).toHaveBeenCalledTimes(1));
		expect(screen.queryByText("Target end date cannot be before the start date")).not.toBeInTheDocument();
	});

	it("surfaces the server error returned by updateProject", async () => {
		mockUpdateProject.mockResolvedValue("Client not found");
		renderModal();

		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		expect(await screen.findByText("Client not found")).toBeInTheDocument();
	});
});
