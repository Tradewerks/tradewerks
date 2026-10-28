import { useState } from "react";
import { Edit2, Trash2 } from "lucide-react";
import NotesRail from "../detail/NotesRail";
import NoteComposer from "../detail/NoteComposer";
import NoteEditCard from "../detail/NoteEditCard";
import { useNoteEditSession } from "../detail/useNoteEditSession";
import ConfirmDialog from "../ui/ConfirmDialog";
import type { InvoiceNote } from "../../types/invoices";
import {
	useInvoiceNotesQuery,
	useCreateInvoiceNoteMutation,
	useUpdateInvoiceNoteMutation,
	useDeleteInvoiceNoteMutation,
} from "../../hooks/useInvoices";
import { usePermission } from "../../hooks/usePermission";

interface InvoiceNoteManagerProps {
	invoiceId: string;
}

export default function InvoiceNoteManager({ invoiceId }: InvoiceNoteManagerProps) {
	const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	const { data: notes, isLoading } = useInvoiceNotesQuery(invoiceId);
	const createNote = useCreateInvoiceNoteMutation();
	const updateNote = useUpdateInvoiceNoteMutation();
	const deleteNote = useDeleteInvoiceNoteMutation();

	// permissions
	const EDIT_NOTES = usePermission("edit_invoices");

	const session = useNoteEditSession(notes?.map((n) => n.id) ?? []);

	// Throws on failure so NoteEditCard shows the error and stays open.
	const handleEditSave = async (content: string) => {
		if (!EDIT_NOTES || !session.editingId) return;
		await updateNote.mutateAsync({
			invoiceId,
			noteId: session.editingId,
			data: { content: content.trim() },
		});
	};

	const handleEdit = (note: InvoiceNote) => {
		if (!EDIT_NOTES) return;
		session.start(note.id);
	};

	const handleDelete = (noteId: string) => {
		if (!EDIT_NOTES) return;
		setDeleteError(null);
		setNoteToDelete(noteId);
	};

	const confirmDelete = async () => {
		if (!noteToDelete) return;
		try {
			await deleteNote.mutateAsync({ invoiceId, noteId: noteToDelete });
			setNoteToDelete(null);
		} catch (error) {
			console.error("Failed to delete note:", error);
			setDeleteError(error instanceof Error ? error.message : "Failed to delete note");
		}
	};

	const formatDate = (date: Date | string) => {
		const d = typeof date === "string" ? new Date(date) : date;
		return d.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	};

	const noteState = isLoading ? "loading" : notes && notes.length > 0 ? "ready" : "empty";

	return (
		<>
			<NotesRail
				title="Notes"
				state={noteState}
				newestId={notes?.[0]?.id}
				editing={session.editingId !== null}
				composer={
					<NoteComposer
						onSubmit={async (content) => {
							await createNote.mutateAsync({
								invoiceId,
								data: { content: content.trim() },
							});
						}}
						canWrite={EDIT_NOTES}
						pending={createNote.isPending}
						disabled={isLoading}
					/>
				}
			>
				{notes?.map((note) => {
					const meta = (
						<div className="flex items-center gap-2 text-xs text-text-muted">
							<span>{formatDate(note.created_at)}</span>
							{note.updated_at &&
								new Date(note.updated_at).getTime() !==
									new Date(note.created_at).getTime() && <span>(edited)</span>}
							{note.creator_dispatcher && (
								<>
									<span>•</span>
									<span>{note.creator_dispatcher.name}</span>
								</>
							)}
							{note.creator_tech && (
								<>
									<span>•</span>
									<span>{note.creator_tech.name}</span>
								</>
							)}
						</div>
					);
					return session.editingId === note.id ? (
						<NoteEditCard
							key={note.id}
							initialContent={note.content}
							onSave={handleEditSave}
							onClose={session.stop}
							pending={updateNote.isPending}
							meta={meta}
						/>
					) : (
						<div
							key={note.id}
							className="p-3 bg-surface rounded-lg border border-border group hover:border-border-strong transition-colors"
						>
							<div className="flex justify-between items-start mb-2">
								<p className="text-text-primary text-sm whitespace-pre-wrap flex-1 break-words min-w-0">
									{note.content}
								</p>
								<div className="flex gap-2 ml-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
									<button
										ref={session.editButtonRef(note.id)}
										onClick={() => handleEdit(note)}
										disabled={!EDIT_NOTES || session.isLocked(note.id)}
										aria-label="Edit note"
										className="text-text-tertiary hover:text-primary-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
									>
										<Edit2 size={14} />
									</button>
									<button
										onClick={() => handleDelete(note.id)}
										disabled={!EDIT_NOTES || session.isLocked(note.id)}
										className="text-text-tertiary hover:text-error-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
										title="Delete note"
										aria-label="Delete note"
									>
										<Trash2 size={14} />
									</button>
								</div>
							</div>
							{meta}
						</div>
					);
				})}
			</NotesRail>

			<ConfirmDialog
				open={noteToDelete !== null}
				title="Delete Note"
				body="Are you sure you want to delete this note? This cannot be undone."
				confirmLabel="Delete"
				tone="destructive"
				pending={deleteNote.isPending}
				error={deleteError}
				onConfirm={confirmDelete}
				onCancel={() => {
					setNoteToDelete(null);
					setDeleteError(null);
				}}
			/>
		</>
	);
}
