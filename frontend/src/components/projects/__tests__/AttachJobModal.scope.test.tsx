import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "../../../types/project";

const getJobsPage = vi.fn();
vi.mock("../../../api/jobs", () => ({
	getJobsPage: (...a: unknown[]) => getJobsPage(...a),
}));

import AttachJobModal from "../AttachJobModal";

const row = (id: string, client_id: string, name: string) => ({
	id,
	name,
	job_number: `J-${id}`,
	status: "Scheduled",
	address: null,
	estimated_total: null,
	created_at: "2026-01-01T00:00:00.000Z",
	client_id,
	client: { id: client_id, name: `Client ${client_id}` },
});

const ROWS = [row("a", "own", "Alpha job"), row("b", "other", "Bravo job")];

const project = { id: "p1", project_number: "P-1", client_id: "own", client: { name: "Own" }, jobs: [] } as unknown as Project;

describe("AttachJobModal scope and search", () => {
	beforeEach(() => {
		getJobsPage.mockReset();
		getJobsPage.mockImplementation(async (params: { q?: string }, extras: { client_id?: string }) => {
			let rows = extras.client_id ? ROWS.filter((r) => r.client_id === extras.client_id) : ROWS;
			if (params.q) rows = rows.filter((r) => r.name.toLowerCase().includes(params.q!.toLowerCase()));
			return { rows, total: rows.length };
		});
	});

	const open = async () => {
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AttachJobModal isModalOpen setIsModalOpen={vi.fn()} project={project} attachJob={vi.fn()} />
			</QueryClientProvider>
		);
		await user.click(await screen.findByRole("button", { name: "This client" }));
		return user;
	};

	it("drops picks that belong to other clients when narrowing back to this client", async () => {
		const user = await open();
		await user.click(await screen.findByText("Alpha job"));
		await user.click(await screen.findByText("Bravo job"));
		expect(screen.getByText("— 2 selected")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "All clients" }));

		expect(await screen.findByText("— 1 selected")).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByText("Bravo job")).toBeNull());
		expect(screen.getByRole("button", { name: "Attach 1 job" })).toBeInTheDocument();
	});

	it("keeps picks when the search narrows the visible results", async () => {
		const user = await open();
		await user.click(await screen.findByText("Alpha job"));
		await user.click(await screen.findByText("Bravo job"));

		await user.type(screen.getByPlaceholderText(/Search for jobs/), "alpha");
		// TemplateSearch also filters locally, so wait for the server's narrowed page to land.
		await waitFor(() =>
			expect(getJobsPage).toHaveBeenCalledWith(expect.objectContaining({ q: "alpha" }), expect.anything())
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByText("Bravo job")).toBeNull();

		expect(screen.getByText("— 2 selected")).toBeInTheDocument();
	});
});
