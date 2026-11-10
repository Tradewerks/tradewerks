import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JobNoteManager from "../JobNoteManager";

const create = { mutateAsync: vi.fn(), isPending: false };
const update = { mutateAsync: vi.fn(), isPending: false };
const del = { mutateAsync: vi.fn(), isPending: false };
let notesResult: { data: unknown; isLoading: boolean };
let canEdit = true;

vi.mock("../../../hooks/useJobs", () => ({
	useJobNotesQuery: () => notesResult,
	useCreateJobNoteMutation: () => create,
	useUpdateJobNoteMutation: () => update,
	useDeleteJobNoteMutation: () => del,
}));
vi.mock("../../../hooks/usePermission", () => ({
	usePermission: () => canEdit,
}));

const NEW_PHOTO = { photo_url: "u", photo_label: null, photo_name: "a.jpg" };

vi.mock("../NotePhotoPicker", () => ({
	default: (props: {
		photos: unknown[];
		onPhotosChange: (p: unknown[]) => void;
		existingPhotos?: { id: string }[];
		disabled?: boolean;
	}) => (
		<div data-testid={props.existingPhotos ? "edit-picker" : "composer-picker"}>
			<span>photo strip</span>
			<span data-testid="disabled">{String(!!props.disabled)}</span>
			<span data-testid="count">{props.photos.length}</span>
			<span data-testid="existing">{props.existingPhotos?.map((p) => p.id).join(",")}</span>
			<button type="button" onClick={() => props.onPhotosChange([NEW_PHOTO])}>
				add photo
			</button>
		</div>
	),
}));

vi.mock("../NotePhotoGallery", () => ({
	default: () => <div data-testid="gallery" />,
}));

const PLACEHOLDER = "Leave context for whoever picks this up next…";
const note = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
	id,
	content,
	visit_id: null,
	created_at: "2026-10-01T00:00:00Z",
	updated_at: "2026-10-01T00:00:00Z",
	...extra,
});

beforeEach(() => {
	vi.clearAllMocks();
	canEdit = true;
	create.mutateAsync.mockResolvedValue(undefined);
	update.mutateAsync.mockResolvedValue(undefined);
	notesResult = { data: [note("n1", "First note")], isLoading: false };
});

describe("JobNoteManager", () => {
	it("puts the photo picker inside the pinned composer", () => {
		render(<JobNoteManager jobId="j1" />);
		const submit = screen.getByRole("button", { name: "Add Note" });
		const form = submit.closest("form");
		expect(form).not.toBeNull();
		expect(form!).toContainElement(screen.getByText("photo strip"));
	});

	it("creates with the composer's photos and clears them after", async () => {
		const user = userEvent.setup();
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getByRole("button", { name: "add photo" }));
		await user.type(screen.getByPlaceholderText(PLACEHOLDER), "Hello");
		await user.click(screen.getByRole("button", { name: "Add Note" }));
		expect(create.mutateAsync).toHaveBeenCalledWith({
			jobId: "j1",
			data: { content: "Hello", visit_id: null, photos: [NEW_PHOTO] },
		});
		expect(await screen.findByText("0", { selector: "[data-testid=count]" })).toBeInTheDocument();
	});

	it("on a visit page attaches visit_id and lists only that visit's notes", async () => {
		const user = userEvent.setup();
		notesResult = {
			data: [note("n1", "Visit one note", { visit_id: "v1" }), note("n2", "Other visit note", { visit_id: "v2" })],
			isLoading: false,
		};
		render(<JobNoteManager jobId="j1" visitId="v1" />);
		expect(screen.getByText("Visit one note")).toBeInTheDocument();
		expect(screen.queryByText("Other visit note")).not.toBeInTheDocument();
		await user.type(screen.getByPlaceholderText(PLACEHOLDER), "x");
		await user.click(screen.getByRole("button", { name: "Add Note" }));
		expect(create.mutateAsync).toHaveBeenCalledWith({
			jobId: "j1",
			data: { content: "x", visit_id: "v1", photos: [] },
		});
	});

	it("keeps composer photos separate from an inline edit's photos", async () => {
		const user = userEvent.setup();
		notesResult = {
			data: [
				note("n1", "First note", {
					photos: [{ id: "p1", photo_url: "x", photo_label: null }],
				}),
			],
			isLoading: false,
		};
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getByRole("button", { name: "add photo" }));
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		const composer = screen.getByTestId("composer-picker");
		const edit = screen.getByTestId("edit-picker");
		expect(composer.querySelector("[data-testid=count]")).toHaveTextContent("1");
		expect(edit.querySelector("[data-testid=count]")).toHaveTextContent("0");
		expect(edit.querySelector("[data-testid=existing]")).toHaveTextContent("p1");
	});

	it("disables the composer's photo picker without edit permission", () => {
		canEdit = false;
		render(<JobNoteManager jobId="j1" />);
		const picker = screen.getByTestId("composer-picker");
		expect(picker.querySelector("[data-testid=disabled]")).toHaveTextContent("true");
	});

	it("disables the composer's photo picker while notes load", () => {
		notesResult = { data: undefined, isLoading: true };
		render(<JobNoteManager jobId="j1" />);
		const picker = screen.getByTestId("composer-picker");
		expect(picker.querySelector("[data-testid=disabled]")).toHaveTextContent("true");
	});

	it("shows the error and keeps composer photos when create fails", async () => {
		const user = userEvent.setup();
		create.mutateAsync.mockRejectedValueOnce(new Error("boom"));
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getByRole("button", { name: "add photo" }));
		await user.type(screen.getByPlaceholderText(PLACEHOLDER), "Hello");
		await user.click(screen.getByRole("button", { name: "Add Note" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("boom");
		expect(screen.getByTestId("composer-picker").querySelector("[data-testid=count]")).toHaveTextContent("1");
	});

	it("shows the visit label on a non-visit page", () => {
		notesResult = { data: [note("n1", "Tagged", { visit_id: "v1" })], isLoading: false };
		const visits = [{ id: "v1", name: "Install", scheduled_start_at: "2026-10-05T12:00:00Z" }];
		render(<JobNoteManager jobId="j1" visits={visits as never} />);
		expect(screen.getByText(/Visit:\s*Install - /)).toBeInTheDocument();
	});

	it("edits in place: note text once, no Edit Note heading, composer hidden", async () => {
		const user = userEvent.setup();
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		expect(screen.queryByText("First note", { selector: "p" })).not.toBeInTheDocument();
		expect(screen.getAllByDisplayValue("First note")).toHaveLength(1);
		expect(screen.queryByText("Edit Note")).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText(PLACEHOLDER).closest("[hidden]")).not.toBeNull();
	});

	it("saves an in-place edit with kept photos, then returns to view mode", async () => {
		const user = userEvent.setup();
		notesResult = {
			data: [note("n1", "First note", { photos: [{ id: "p1", photo_url: "x", photo_label: null }] })],
			isLoading: false,
		};
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		const box = screen.getByLabelText("Edit note text");
		await user.clear(box);
		await user.type(box, "Changed");
		await user.click(screen.getByRole("button", { name: "Update Note" }));
		expect(update.mutateAsync).toHaveBeenCalledWith({
			jobId: "j1",
			noteId: "n1",
			data: { content: "Changed", photos: [{ id: "p1", photo_url: "x", photo_label: null }] },
		});
		await waitFor(() => expect(screen.queryByLabelText("Edit note text")).not.toBeInTheDocument());
		expect(screen.getByPlaceholderText(PLACEHOLDER).closest("[hidden]")).toBeNull();
	});

	it("keeps the edit open on an outside click", async () => {
		const user = userEvent.setup();
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		fireEvent.mouseDown(document.body);
		expect(screen.getByDisplayValue("First note")).toBeInTheDocument();
	});

	it("locks the other notes' actions while one is being edited", async () => {
		const user = userEvent.setup();
		notesResult = { data: [note("n1", "First note"), note("n2", "Second note")], isLoading: false };
		render(<JobNoteManager jobId="j1" />);
		await user.click(screen.getAllByRole("button", { name: "Edit note" })[0]);
		expect(screen.getByRole("button", { name: "Edit note" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Delete note" })).toBeDisabled();
	});

	it("hides the photo gallery while that note is being edited", async () => {
		const user = userEvent.setup();
		notesResult = {
			data: [note("n1", "First note", { photos: [{ id: "p1", photo_url: "x", photo_label: null }] })],
			isLoading: false,
		};
		render(<JobNoteManager jobId="j1" />);
		expect(screen.getByTestId("gallery")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Edit note" }));
		expect(screen.queryByTestId("gallery")).not.toBeInTheDocument();
	});
});
