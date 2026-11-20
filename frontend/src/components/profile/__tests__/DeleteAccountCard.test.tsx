import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, AxiosHeaders } from "axios";

vi.mock("../../../api/account", () => ({
	getAccountDeletionPreview: vi.fn(),
	deleteAccount: vi.fn(),
}));
import * as accountApi from "../../../api/account";
import DeleteAccountCard from "../DeleteAccountCard";
import AccountDeletedPage from "../../../pages/AccountDeletedPage";
import { useAuthStore } from "../../../auth/authStore";

const api = accountApi as unknown as Record<"getAccountDeletionPreview" | "deleteAccount", ReturnType<typeof vi.fn>>;

const apiError = (status: number, code: string, message: string) =>
	new AxiosError(message, String(status), undefined, undefined, {
		status,
		statusText: "",
		headers: {},
		config: { headers: new AxiosHeaders() },
		data: { success: false, data: null, error: { code, message } },
	});

function wrap() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={["/dispatch/profile"]}>
				<Routes>
					<Route path="/dispatch/profile" element={<DeleteAccountCard />} />
					<Route path="/account-deleted" element={<AccountDeletedPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const USER = { kind: "user", confirmation: "DELETE", organization: { name: "Acme HVAC" }, blockers: [] };
const ORG = {
	kind: "organization",
	confirmation: "Acme HVAC",
	organization: { name: "Acme HVAC", users: 12, clients: 340, jobs: 1, invoices: 0, quickbooksConnected: true },
	blockers: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({
		user: { role: "dispatcher", name: "pat@acme.test", userId: "u1", orgId: "o1", orgTimezone: "America/Chicago", permissions: [] },
	});
});

describe("DeleteAccountCard for a dispatcher or technician", () => {
	it("says what is removed and what the organization keeps", async () => {
		api.getAccountDeletionPreview.mockResolvedValue(USER);
		wrap();
		expect(await screen.findByRole("heading", { name: "Delete account" })).toBeInTheDocument();
		expect(screen.getByText(/your name, email, phone, password/i)).toBeInTheDocument();
		expect(screen.getByText(/Kept by Acme HVAC:/)).toBeInTheDocument();
		expect(screen.getByText(/"Deleted user"/)).toBeInTheDocument();
	});

	it("needs DELETE and the password, shows a wrong password, then signs out to the confirmation page", async () => {
		api.getAccountDeletionPreview.mockResolvedValue(USER);
		api.deleteAccount
			.mockRejectedValueOnce(apiError(403, "INVALID_CREDENTIALS", "That password isn't right"))
			.mockResolvedValueOnce({ kind: "user" });
		wrap();
		const u = userEvent.setup();
		await u.click(await screen.findByRole("button", { name: /delete my account…/i }));

		const submit = screen.getByRole("button", { name: "Delete my account" });
		expect(submit).toBeDisabled();
		await u.type(screen.getByLabelText(/to confirm/i), "delete");
		await u.type(screen.getByLabelText(/your password/i), "wrong");
		expect(submit).toBeEnabled();

		await u.click(submit);
		expect(await screen.findByText("That password isn't right")).toBeInTheDocument();
		expect(useAuthStore.getState().user).not.toBeNull();

		await u.clear(screen.getByLabelText(/your password/i));
		await u.type(screen.getByLabelText(/your password/i), "right");
		await u.click(submit);
		expect(await screen.findByRole("heading", { name: "Your account was deleted" })).toBeInTheDocument();
		expect(api.deleteAccount.mock.lastCall?.[0]).toEqual({ password: "right", confirmation: "delete" });
		// AccountDeletedPage signs out in an effect, after the heading has rendered.
		await waitFor(() => expect(useAuthStore.getState().user).toBeNull());
	});

	it("explains what stands in the way and keeps the button off", async () => {
		api.getAccountDeletionPreview.mockResolvedValue({
			...USER,
			blockers: ["You're assigned to 2 open visits. Ask your dispatcher to reassign them first."],
		});
		wrap();
		expect(await screen.findByRole("alert")).toHaveTextContent(/2 open visits/);
		expect(screen.getByRole("button", { name: /delete my account…/i })).toBeDisabled();
	});
});

describe("DeleteAccountCard for the admin", () => {
	it("makes clear the whole organization goes, with what is in it", async () => {
		api.getAccountDeletionPreview.mockResolvedValue(ORG);
		wrap();
		expect(await screen.findByRole("heading", { name: "Delete organization" })).toBeInTheDocument();
		expect(screen.getByText(/deleting your account deletes the whole organization/i)).toBeInTheDocument();
		expect(screen.getByText(/12 user accounts, 340 clients, 1 job, 0 invoices/)).toBeInTheDocument();
		expect(screen.getByText(/QuickBooks is disconnected/)).toBeInTheDocument();
		expect(screen.getByText(/Export anything you need/)).toBeInTheDocument();
	});

	it("asks for the organization's name and lands on the in-progress page", async () => {
		api.getAccountDeletionPreview.mockResolvedValue(ORG);
		api.deleteAccount.mockResolvedValue({ kind: "organization" });
		wrap();
		const u = userEvent.setup();
		await u.click(await screen.findByRole("button", { name: /delete organization…/i }));
		expect(screen.getByRole("heading", { name: "Delete Acme HVAC?" })).toBeInTheDocument();

		const submit = screen.getByRole("button", { name: "Delete organization permanently" });
		await u.type(screen.getByLabelText(/your password/i), "pw");
		await u.type(screen.getByLabelText(/to confirm/i), "DELETE");
		expect(submit).toBeDisabled();
		await u.clear(screen.getByLabelText(/to confirm/i));
		await u.type(screen.getByLabelText(/to confirm/i), "acme  hvac");
		await u.click(submit);

		expect(await screen.findByRole("heading", { name: "Acme HVAC is being deleted" })).toBeInTheDocument();
		expect(screen.getByText(/We'll email you when it's done/)).toBeInTheDocument();
		await waitFor(() => expect(useAuthStore.getState().user).toBeNull());
	});
});
