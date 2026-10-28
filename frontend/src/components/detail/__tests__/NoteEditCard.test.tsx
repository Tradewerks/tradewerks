import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NoteEditCard from "../NoteEditCard";

const scrollIntoView = vi.fn();
let onSave: Mock<(content: string) => Promise<void>>;
let onClose: Mock<() => void>;

beforeEach(() => {
	Element.prototype.scrollIntoView = scrollIntoView;
	scrollIntoView.mockClear();
	onSave = vi.fn<(content: string) => Promise<void>>().mockResolvedValue(undefined);
	onClose = vi.fn<() => void>();
});
afterEach(() => vi.restoreAllMocks());

const renderCard = (initialContent = "Original") =>
	render(
		<NoteEditCard
			initialContent={initialContent}
			onSave={onSave}
			onClose={onClose}
			pending={false}
			meta={<span>meta line</span>}
			attachments={<span>attachments</span>}
			below={<span>below slot</span>}
		/>
	);

const box = () => screen.getByLabelText("Edit note text") as HTMLTextAreaElement;
const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("NoteEditCard", () => {
	it("shows the note once, with slots in spec order", () => {
		renderCard();
		expect(screen.getAllByDisplayValue("Original")).toHaveLength(1);
		expect(screen.queryByText("Edit Note")).not.toBeInTheDocument();
		const order = [
			screen.getByText("meta line"),
			box(),
			screen.getByText("attachments"),
			screen.getByText("below slot"),
			screen.getByRole("button", { name: "Update Note" }),
		];
		for (let i = 0; i < order.length - 1; i++) expect(follows(order[i], order[i + 1])).toBe(true);
	});

	it("focuses the textarea with the caret at the end", () => {
		renderCard("Original");
		expect(document.activeElement).toBe(box());
		expect(box().selectionStart).toBe("Original".length);
	});

	it("Escape cancels without reaching document listeners", async () => {
		const user = userEvent.setup();
		const docKey = vi.fn();
		document.addEventListener("keydown", docKey);
		renderCard();
		await user.keyboard("{Escape}");
		document.removeEventListener("keydown", docKey);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(docKey).not.toHaveBeenCalled();
	});

	it("Escape and Ctrl+Enter inside an attachment field leave the edit alone", async () => {
		const user = userEvent.setup();
		render(
			<NoteEditCard
				initialContent="Original"
				onSave={onSave}
				onClose={onClose}
				pending={false}
				attachments={<input aria-label="Photo name" />}
			/>
		);
		await user.click(screen.getByLabelText("Photo name"));
		await user.keyboard("{Escape}");
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(onClose).not.toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("Ctrl+Enter saves, then closes", async () => {
		const user = userEvent.setup();
		renderCard("");
		await user.type(box(), "edited text");
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(onSave).toHaveBeenCalledWith("edited text");
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("Cancel closes without saving", async () => {
		const user = userEvent.setup();
		renderCard();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("whitespace-only content cannot be saved", async () => {
		const user = userEvent.setup();
		renderCard("");
		await user.type(box(), "   ");
		expect(screen.getByRole("button", { name: "Update Note" })).toBeDisabled();
		await user.keyboard("{Control>}{Enter}{/Control}");
		expect(onSave).not.toHaveBeenCalled();
	});

	it("a failed save shows the error and keeps the editor open with its text", async () => {
		const user = userEvent.setup();
		onSave.mockRejectedValue(new Error("Boom"));
		renderCard("");
		await user.type(box(), "kept");
		await user.click(screen.getByRole("button", { name: "Update Note" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Boom");
		expect(box()).toHaveValue("kept");
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Update Note" })).toBeEnabled();
	});

	it("shows Saving... while pending", () => {
		render(<NoteEditCard initialContent="x" onSave={onSave} onClose={onClose} pending />);
		expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
	});

	it("scrolls its action bar into the nearest scroller on mount", () => {
		renderCard();
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
	});
});
