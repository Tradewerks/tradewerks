import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import NoteComposer from "../NoteComposer";

const PLACEHOLDER = "Leave context for whoever picks this up next…";

describe("NoteComposer", () => {
	it("submits non-blank text raw and clears on success", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(<NoteComposer onSubmit={onSubmit} canWrite pending={false} />);
		const box = screen.getByPlaceholderText(PLACEHOLDER);
		const submit = screen.getByRole("button", { name: "Add Note" });
		expect(submit).toBeDisabled();
		await user.type(box, "   ");
		expect(submit).toBeDisabled();
		await user.type(box, "Gate code 4417");
		await user.click(submit);
		expect(onSubmit).toHaveBeenCalledWith("   Gate code 4417");
		expect(box).toHaveValue("");
	});

	it("keeps the text and shows the error when save fails, then retries", async () => {
		const user = userEvent.setup();
		const onSubmit = vi
			.fn()
			.mockRejectedValueOnce(new Error("Network down"))
			.mockResolvedValueOnce(undefined);
		render(<NoteComposer onSubmit={onSubmit} canWrite pending={false} />);
		const box = screen.getByPlaceholderText(PLACEHOLDER);
		await user.type(box, "Call first");
		await user.click(screen.getByRole("button", { name: "Add Note" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
		expect(box).toHaveValue("Call first");
		await user.click(screen.getByRole("button", { name: "Add Note" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(box).toHaveValue("");
	});

	it("is disabled with the permission reason when the viewer cannot write", () => {
		render(<NoteComposer onSubmit={vi.fn()} canWrite={false} pending={false} />);
		const box = screen.getByPlaceholderText(PLACEHOLDER);
		expect(box).toBeDisabled();
		expect(screen.getByRole("button", { name: "Add Note" })).toBeDisabled();
		expect(box).toHaveAttribute("title", "You don't have permission to perform this action");
	});

	it("is disabled without a permission title when disabled is set", () => {
		render(<NoteComposer onSubmit={vi.fn()} canWrite pending={false} disabled />);
		const box = screen.getByPlaceholderText(PLACEHOLDER);
		const submit = screen.getByRole("button", { name: "Add Note" });
		expect(box).toBeDisabled();
		expect(submit).toBeDisabled();
		expect(box).not.toHaveAttribute("title");
		expect(submit).not.toHaveAttribute("title");
	});

	it("shows Saving... and blocks submit while pending", () => {
		render(<NoteComposer onSubmit={vi.fn()} canWrite pending />);
		const submit = screen.getByRole("button", { name: "Saving..." });
		expect(submit).toBeDisabled();
		expect(screen.getByLabelText("New note")).toBeDisabled();
	});

	it("renders attachments between the textarea and the submit", () => {
		render(
			<NoteComposer
				onSubmit={vi.fn()}
				canWrite
				pending={false}
				attachments={<div>photo strip</div>}
			/>
		);
		const box = screen.getByPlaceholderText(PLACEHOLDER);
		const strip = screen.getByText("photo strip");
		const submit = screen.getByRole("button", { name: "Add Note" });
		expect(box.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(strip.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
