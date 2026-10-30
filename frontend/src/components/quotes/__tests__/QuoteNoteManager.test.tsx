import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import QuoteNoteManager from "../QuoteNoteManager";

const create = { mutateAsync: vi.fn(), isPending: false };
const update = { mutateAsync: vi.fn(), isPending: false };
const del = { mutateAsync: vi.fn(), isPending: false };
let notesResult: { data: unknown; isLoading: boolean };
let canEdit = true;

vi.mock("../../../hooks/useQuotes", () => ({
	useQuoteNotesQuery: () => notesResult,
	useCreateQuoteNoteMutation: () => create,
	useUpdateQuoteNoteMutation: () => update,
	useDeleteQuoteNoteMutation: () => del,
}));
vi.mock("../../../hooks/usePermission", () => ({
	usePermission: () => canEdit,
}));

const PLACEHOLDER = "Leave context for whoever picks this up next…";
const note = (id: string, content: string) => ({
	id,
	content,
	created_at: "2026-10-01T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
});

beforeEach(() => {
	vi.clearAllMocks();
	canEdit = true;
	create.mutateAsync.mockResolvedValue(undefined);
	update.mutateAsync.mockResolvedValue(undefined);
	notesResult = { data: [note("n1", "First note")], isLoading: false };
});

describe("QuoteNoteManager", () => {
	it("has an always-open composer and no Add Note header button", () => {
		render(<QuoteNoteManager quoteId="q1" />);
		expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
		const buttons = screen.getAllByRole("button", { name: "Add Note" });
		expect(buttons).toHaveLength(1);
		expect(buttons[0].closest("form")).not.toBeNull();
	});

	it("creates a note from the composer", async () => {
		const user = userEvent.setup();
		render(<QuoteNoteManager quoteId="q1" />);
		await user.type(screen.getByPlaceholderText(PLACEHOLDER), "Call first");
		await user.click(screen.getByRole("button", { name: "Add Note" }));
		expect(create.mutateAsync).toHaveBeenCalledWith({
			quoteId: "q1",
			data: { content: "Call first" },
		});
	});

	it("keeps a composer draft when an existing note is edited", async () => {
		const user = userEvent.setup();
		render(<QuoteNoteManager quoteId="q1" />);
		const composer = screen.getByPlaceholderText(PLACEHOLDER);
		await user.type(composer, "draft");
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		const editBox = screen.getByLabelText("Edit note text");
		expect(composer).toHaveValue("draft");
		expect(composer.closest("[hidden]")).not.toBeNull();
		await user.clear(editBox);
		await user.type(editBox, "Changed");
		await user.click(screen.getByRole("button", { name: "Update Note" }));
		expect(update.mutateAsync).toHaveBeenCalledWith({
			quoteId: "q1",
			noteId: "n1",
			data: { content: "Changed" },
		});
		expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue("draft");
	});

	it("clicking outside the inline edit keeps the edit open and the composer draft", async () => {
		const user = userEvent.setup();
		render(<QuoteNoteManager quoteId="q1" />);
		await user.type(screen.getByPlaceholderText(PLACEHOLDER), "draft");
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		fireEvent.mouseDown(document.body);
		expect(screen.getByDisplayValue("First note")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Edit note text")).not.toBeInTheDocument();
		const composer = screen.getByPlaceholderText(PLACEHOLDER);
		expect(composer.closest("[hidden]")).toBeNull();
		expect(composer).toHaveValue("draft");
	});

	it("edits in place: the note text appears once", async () => {
		const user = userEvent.setup();
		render(<QuoteNoteManager quoteId="q1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		expect(screen.getByLabelText("Edit note text")).toHaveValue("First note");
		expect(screen.queryByText("First note", { selector: "p" })).not.toBeInTheDocument();
		expect(screen.queryByText("Edit Note")).not.toBeInTheDocument();
	});

	it("blocks writing without edit_quotes", async () => {
		canEdit = false;
		const user = userEvent.setup();
		render(<QuoteNoteManager quoteId="q1" />);
		expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeDisabled();
		const edit = screen.getByRole("button", { name: "Edit note" });
		const remove = screen.getByRole("button", { name: "Delete note" });
		expect(edit).toBeDisabled();
		expect(remove).toBeDisabled();
		await user.click(edit);
		await user.click(remove);
		expect(create.mutateAsync).not.toHaveBeenCalled();
		expect(update.mutateAsync).not.toHaveBeenCalled();
		expect(del.mutateAsync).not.toHaveBeenCalled();
	});

	it("renders notes newest first in API order", () => {
		notesResult = {
			data: [note("n2", "Newer note"), note("n1", "Older note")],
			isLoading: false,
		};
		render(<QuoteNoteManager quoteId="q1" />);
		const newer = screen.getByText("Newer note");
		const older = screen.getByText("Older note");
		expect(newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
