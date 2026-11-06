import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import NotesRail from "../NotesRail";

afterEach(() => vi.restoreAllMocks());

describe("NotesRail", () => {
	it("renders the title, the list region and the composer, composer last", () => {
		render(
			<NotesRail title="Notes" state="ready" composer={<div>composer</div>}>
				<div>row one</div>
			</NotesRail>
		);
		expect(screen.getByText("Notes")).toBeInTheDocument();
		const row = screen.getByText("row one");
		const composer = screen.getByText("composer");
		expect(row.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows a loading skeleton and no rows while loading", () => {
		const { container } = render(
			<NotesRail title="Notes" state="loading" composer={<div>composer</div>}>
				<div>row one</div>
			</NotesRail>
		);
		expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
		expect(screen.queryByText("row one")).not.toBeInTheDocument();
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
	});

	it("shows the empty copy when there are no notes", () => {
		render(<NotesRail title="Notes" state="empty" composer={<div>composer</div>} />);
		expect(screen.getByText("No notes yet.")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("No notes yet.");
	});

	it("scrolls the list to top when the newest note changes", () => {
		const scrollTo = vi.fn();
		HTMLElement.prototype.scrollTo = scrollTo;
		const ui = (id: string) => (
			<NotesRail title="Notes" state="ready" composer={<div>c</div>} newestId={id}>
				<div>row</div>
			</NotesRail>
		);
		const { rerender } = render(ui("a"));
		expect(scrollTo).not.toHaveBeenCalled();
		rerender(ui("b"));
		expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
	});

	it("fills its rail: card is h-full, list scrolls, composer does not", () => {
		const { container } = render(
			<NotesRail title="Notes" state="ready" composer={<div>composer</div>}>
				<div>row</div>
			</NotesRail>
		);
		expect((container.firstChild as HTMLElement).className).toContain("lg:h-full");
		const list = screen.getByText("row").parentElement as HTMLElement;
		expect(list.className).toContain("overflow-y-auto");
		expect(list.className).toContain("flex-1");
		expect(list.className).toContain("min-h-0");
		const wrapper = screen.getByText("composer").parentElement as HTMLElement;
		expect(wrapper.className).toContain("shrink-0");
		expect(wrapper.className).toContain("border-t");
	});

	it("while editing, hides the composer footer but keeps it mounted", () => {
		const ui = (editing: boolean) => (
			<NotesRail title="Notes" state="ready" composer={<div>composer</div>} editing={editing}>
				<div>row</div>
			</NotesRail>
		);
		const { rerender } = render(ui(true));
		const wrapper = screen.getByText("composer").parentElement as HTMLElement;
		expect(wrapper).toHaveAttribute("hidden");
		rerender(ui(false));
		expect(screen.getByText("composer").parentElement).not.toHaveAttribute("hidden");
	});

	it("does not jump to the newest note while a note is being edited", () => {
		const scrollTo = vi.fn();
		HTMLElement.prototype.scrollTo = scrollTo;
		const ui = (id: string, editing: boolean) => (
			<NotesRail title="Notes" state="ready" composer={<div>c</div>} newestId={id} editing={editing}>
				<div>row</div>
			</NotesRail>
		);
		const { rerender } = render(ui("a", true));
		rerender(ui("b", true));
		expect(scrollTo).not.toHaveBeenCalled();
		rerender(ui("b", false));
		expect(scrollTo).not.toHaveBeenCalled();
	});
});
