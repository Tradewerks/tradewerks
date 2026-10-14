import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RequestDetailPage from "../RequestDetailPage";
import { useAuthStore } from "../../../auth/authStore";
import type { Request } from "../../../types/requests";

const { updateRequest } = vi.hoisted(() => ({ updateRequest: vi.fn() }));

vi.mock("../../../hooks/useRequests", () => ({
	useRequestByIdQuery: () => ({ data: request, isLoading: false }),
	useUpdateRequestMutation: () => ({
		mutateAsync: updateRequest,
		isPending: false,
	}),
}));
vi.mock("../../../hooks/useQuotes", () => ({
	useCreateQuoteMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useJobs", () => ({
	useCreateJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../components/requests/EditRequest", () => ({ default: () => null }));
vi.mock("../../../components/requests/ConvertToQuote", () => ({ default: () => null }));
vi.mock("../../../components/requests/ConvertToJob", () => ({ default: () => null }));
vi.mock("../../../components/requests/RequestNoteManager", () => ({ default: () => null }));
vi.mock("../../../components/activity/ChangeHistory", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientDetailsCard", () => ({ default: () => null }));

// Reviewing, not New: the page arms a five-second New → Reviewing timer, and a
// fixture already past it keeps that write out of the assertions below.
const request = {
	id: "req-1",
	request_number: "R-1001",
	title: "No heat upstairs",
	status: "Reviewing",
	priority: "High",
	client_id: "c1",
	client: { name: "Acme" },
	created_at: "2026-09-01T00:00:00.000Z",
	updated_at: "2026-09-01T00:00:00.000Z",
	cancellation_reason: null,
	cancelled_at: null,
	quotes: [],
	jobs: [],
} as unknown as Request;

const renderPage = () =>
	render(
		<MemoryRouter initialEntries={["/dispatch/requests/req-1"]}>
			<Routes>
				<Route
					path="/dispatch/requests/:requestId"
					element={<RequestDetailPage />}
				/>
			</Routes>
		</MemoryRouter>
	);

/** Cancel Request is destructive, so placement always parks it in the kebab. */
const openCancelAction = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(screen.getByRole("button", { name: "Request actions" }));
	await user.click(screen.getByRole("menuitem", { name: "Cancel Request" }));
};

beforeEach(() => {
	updateRequest.mockReset();
	updateRequest.mockResolvedValue(request);
	useAuthStore
		.getState()
		.login("dispatcher", "Alex", "d1", "org", "America/Chicago", [
			"view_requests",
			"edit_requests",
			"create_quotes",
			"create_jobs",
		]);
});

describe("RequestDetailPage — Cancel Request confirmation", () => {
	it("opens a confirmation instead of cancelling on the first click", async () => {
		const user = userEvent.setup();
		renderPage();

		await openCancelAction(user);

		expect(screen.getByRole("dialog", { name: "Cancel Request" })).toBeInTheDocument();
		expect(updateRequest).not.toHaveBeenCalled();
	});

	it("cancels the request once the confirmation is accepted", async () => {
		const user = userEvent.setup();
		renderPage();

		await openCancelAction(user);
		const dialog = screen.getByRole("dialog", { name: "Cancel Request" });
		await user.click(within(dialog).getByRole("button", { name: "Cancel Request" }));

		expect(updateRequest).toHaveBeenCalledWith({
			id: "req-1",
			data: { status: "Cancelled" },
		});
	});

	it("leaves the request untouched when the confirmation is dismissed", async () => {
		const user = userEvent.setup();
		renderPage();

		await openCancelAction(user);
		const dialog = screen.getByRole("dialog", { name: "Cancel Request" });
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(updateRequest).not.toHaveBeenCalled();
	});
});
