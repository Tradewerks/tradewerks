import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import InvoiceNoteManager from "../InvoiceNoteManager";

const create = { mutateAsync: vi.fn(), isPending: false };
const update = { mutateAsync: vi.fn(), isPending: false };
const del = { mutateAsync: vi.fn(), isPending: false };
let notesResult: { data: unknown; isLoading: boolean };

vi.mock("../../../hooks/useInvoices", () => ({
	useInvoiceNotesQuery: () => notesResult,
	useCreateInvoiceNoteMutation: () => create,
	useUpdateInvoiceNoteMutation: () => update,
	useDeleteInvoiceNoteMutation: () => del,
}));
vi.mock("../../../hooks/usePermission", () => ({
	usePermission: () => true,
}));

const PLACEHOLDER = "Leave context for whoever picks this up next…";

beforeEach(() => {
	vi.clearAllMocks();
	update.mutateAsync.mockResolvedValue(undefined);
	notesResult = {
		data: [
			{
				id: "n1",
				content: "First note",
				created_at: "2026-10-01T00:00:00Z",
				updated_at: "2026-10-01T00:00:00Z",
			},
		],
		isLoading: false,
	};
});

describe("InvoiceNoteManager", () => {
	it("trims an in-place edit before saving", async () => {
		const user = userEvent.setup();
		render(<InvoiceNoteManager invoiceId="i1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		const box = screen.getByLabelText("Edit note text");
		await user.clear(box);
		await user.type(box, "  Changed  ");
		await user.click(screen.getByRole("button", { name: "Update Note" }));
		expect(update.mutateAsync).toHaveBeenCalledWith({
			invoiceId: "i1",
			noteId: "n1",
			data: { content: "Changed" },
		});
	});

	it("keeps the edit open on an outside click", async () => {
		const user = userEvent.setup();
		render(<InvoiceNoteManager invoiceId="i1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		fireEvent.mouseDown(document.body);
		expect(screen.getByLabelText("Edit note text")).toBeInTheDocument();
	});

	it("hides the composer while editing and brings it back on Cancel", async () => {
		const user = userEvent.setup();
		render(<InvoiceNoteManager invoiceId="i1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		expect(screen.getByPlaceholderText(PLACEHOLDER).closest("[hidden]")).not.toBeNull();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByPlaceholderText(PLACEHOLDER).closest("[hidden]")).toBeNull();
	});
});
