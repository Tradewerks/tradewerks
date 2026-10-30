import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useNoteEditSession, type NoteEditSession } from "../useNoteEditSession";

let session: NoteEditSession;

function Harness({ ids }: { ids: string[] }) {
	session = useNoteEditSession(ids);
	return (
		<div>
			{ids.map((id) =>
				session.editingId === id ? (
					<textarea key={id} aria-label={`editor ${id}`} />
				) : (
					<button
						key={id}
						ref={session.editButtonRef(id)}
						disabled={session.isLocked(id)}
						aria-label={`edit ${id}`}
					/>
				)
			)}
		</div>
	);
}

describe("useNoteEditSession", () => {
	it("opens one note and locks the others", () => {
		render(<Harness ids={["a", "b"]} />);
		act(() => session.start("a"));
		expect(session.editingId).toBe("a");
		expect(session.isLocked("a")).toBe(false);
		expect(session.isLocked("b")).toBe(true);
		expect(screen.getByLabelText("edit b")).toBeDisabled();
	});

	it("nothing is locked while no note is open", () => {
		render(<Harness ids={["a", "b"]} />);
		expect(session.isLocked("a")).toBe(false);
		expect(session.isLocked("b")).toBe(false);
	});

	it("stop closes and returns focus to that note's edit button", () => {
		render(<Harness ids={["a", "b"]} />);
		act(() => session.start("a"));
		act(() => session.stop());
		expect(session.editingId).toBeNull();
		expect(document.activeElement).toBe(screen.getByLabelText("edit a"));
	});

	it("closes itself when the edited note disappears", () => {
		const { rerender } = render(<Harness ids={["a", "b"]} />);
		act(() => session.start("a"));
		rerender(<Harness ids={["b"]} />);
		expect(session.editingId).toBeNull();
		expect(session.isLocked("b")).toBe(false);
	});
});
