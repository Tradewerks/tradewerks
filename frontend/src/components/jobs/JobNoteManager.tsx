import { useState } from "react";
import { Edit2, Trash2, Calendar } from "lucide-react";
import NotesRail from "../detail/NotesRail";
import NoteComposer from "../detail/NoteComposer";
import NoteEditCard from "../detail/NoteEditCard";
import { useNoteEditSession } from "../detail/useNoteEditSession";
import ConfirmDialog from "../ui/ConfirmDialog";
import type { JobNote, JobVisit, JobNotePhoto, NotePhoto, UpdateJobNoteInput } from "../../types/jobs";
import {
	useJobNotesQuery,
	useCreateJobNoteMutation,
	useUpdateJobNoteMutation,
	useDeleteJobNoteMutation,
} from "../../hooks/useJobs";
import { usePermission } from "../../hooks/usePermission";
import NotePhotoGallery from "./NotePhotoGallery";
import NotePhotoPicker from "./NotePhotoPicker";

interface JobNoteManagerProps {
	jobId: string;
	visits?: JobVisit[];
	visitId?: string; // If provided, automatically attach notes to this visit
}

export default function JobNoteManager({ jobId, visits, visitId }: JobNoteManagerProps) {
	const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	// Composer photos (new note) are kept apart from the inline edit's photos so
	// editing a note never touches an unsent composer draft.
	const [composerPhotos, setComposerPhotos] = useState<NotePhoto[]>([]);
	const [editPhotos, setEditPhotos] = useState<NotePhoto[]>([]);
	const [existingPhotos, setExistingPhotos] = useState<JobNotePhoto[]>([]);

	const { data: notes, isLoading } = useJobNotesQuery(jobId);
	const createNote = useCreateJobNoteMutation();
	const updateNote = useUpdateJobNoteMutation();
	const deleteNote = useDeleteJobNoteMutation();

	// permissions
	const EDIT_NOTES = usePermission("edit_jobs");

	// Filter notes based on context
	const filteredNotes = visitId
		? notes?.filter((note) => note.visit_id === visitId) || []
		: notes || [];

	const session = useNoteEditSession(filteredNotes.map((n) => n.id));

	const closeEdit = () => {
		session.stop();
		setEditPhotos([]);
		setExistingPhotos([]);
	};

	const handleEdit = (note: JobNote) => {
		if (!EDIT_NOTES) return;
		setExistingPhotos(note.photos ?? []);
		setEditPhotos([]);
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
			await deleteNote.mutateAsync({ jobId, noteId: noteToDelete });
			setNoteToDelete(null);
		} catch (error) {
			console.error("Failed to delete note:", error);
			setDeleteError(error instanceof Error ? error.message : "Failed to delete note");
		}
	};

	// Throws on failure so NoteEditCard shows the error and stays open.
	const handleEditSave = async (content: string) => {
		if (!EDIT_NOTES || !session.editingId) return;
		const updateData: UpdateJobNoteInput = {
			content,
			photos: [
				...existingPhotos.map((p) => ({ id: p.id, photo_url: p.photo_url, photo_label: p.photo_label })),
				...editPhotos.map((p) => ({ photo_url: p.photo_url, photo_label: p.photo_label, photo_name: p.photo_name })),
			],
		};
		await updateNote.mutateAsync({
			jobId,
			noteId: session.editingId,
			data: updateData,
		});
		setEditPhotos([]);
		setExistingPhotos([]);
	};

	const formatDate = (date: Date | string) => {
		const d = typeof date === "string" ? new Date(date) : date;
		return d.toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	};

	const getVisitLabel = (noteVisitId: string) => {
		const visit = visits?.find((v) => v.id === noteVisitId);
		if (!visit) return "Unknown Visit";
		const visitName = visit.name ? `${visit.name} - ` : "";
		return `${visitName}${formatDate(visit.scheduled_start_at)}`;
	};

	const renderMeta = (note: JobNote) => (
		<div className="flex items-center gap-2 text-xs text-text-muted">
			<span>{formatDate(note.created_at)}</span>
			{note.updated_at &&
				new Date(note.updated_at).getTime() !==
					new Date(note.created_at).getTime() && <span>(edited)</span>}
			{note.creator_tech && (
				<>
					<span>•</span>
					<span>{note.creator_tech.name}</span>
				</>
			)}
			{note.creator_dispatcher && (
				<>
					<span>•</span>
					<span>{note.creator_dispatcher.name}</span>
				</>
			)}
		</div>
	);

	const renderVisitLabel = (note: JobNote) =>
		!visitId &&
		note.visit_id && (
			<div className="flex items-center gap-1.5 text-xs text-primary-text mt-2">
				<Calendar size={12} />
				<span>Visit: {getVisitLabel(note.visit_id)}</span>
			</div>
		);

	const noteState = isLoading ? "loading" : filteredNotes.length > 0 ? "ready" : "empty";

	return (
		<>
			<NotesRail
				title={visitId ? "Visit Notes" : "Job Notes"}
				state={noteState}
				newestId={filteredNotes[0]?.id}
				editing={session.editingId !== null}
				composer={
					<NoteComposer
						onSubmit={async (content) => {
							await createNote.mutateAsync({
								jobId,
								data: {
									content,
									visit_id: visitId || null,
									photos: composerPhotos.map((p) => ({
										photo_url: p.photo_url,
										photo_label: p.photo_label,
										photo_name: p.photo_name,
									})),
								},
							});
							setComposerPhotos([]);
						}}
						canWrite={EDIT_NOTES}
						pending={createNote.isPending}
						disabled={isLoading}
						attachments={
							<NotePhotoPicker
								jobId={jobId}
								capture={false}
								photos={composerPhotos}
								onPhotosChange={setComposerPhotos}
								disabled={!EDIT_NOTES || isLoading || createNote.isPending}
							/>
						}
					/>
				}
			>
				{filteredNotes.map((note) =>
					session.editingId === note.id ? (
						<NoteEditCard
							key={note.id}
							initialContent={note.content}
							onSave={handleEditSave}
							onClose={closeEdit}
							pending={updateNote.isPending}
							meta={renderMeta(note)}
							below={renderVisitLabel(note)}
							attachments={
								<NotePhotoPicker
									jobId={jobId}
									capture={false}
									photos={editPhotos}
									onPhotosChange={setEditPhotos}
									existingPhotos={existingPhotos}
									onRemoveExisting={(id) =>
										setExistingPhotos((prev) => prev.filter((p) => p.id !== id))
									}
									disabled={updateNote.isPending}
								/>
							}
						/>
					) : (
						<div
							key={note.id}
							className="p-3 bg-surface rounded-lg border border-border group hover:border-border-strong transition-colors"
						>
							<div className="flex justify-between items-start mb-2">
								<div className="flex-1 min-w-0">
									{note.photos && note.photos.length > 0 && (
										<div className="mt-2">
											<NotePhotoGallery photos={note.photos} />
										</div>
									)}
									<p className="text-text-primary text-sm mb-1 whitespace-pre-wrap break-words">
										{note.content}
									</p>

									{renderVisitLabel(note)}
								</div>

								<div className="flex gap-2 ml-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
									<button
										ref={session.editButtonRef(note.id)}
										onClick={() => handleEdit(note)}
										disabled={!EDIT_NOTES || session.isLocked(note.id)}
										className="text-text-tertiary hover:text-primary-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
										aria-label="Edit note"
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

							{renderMeta(note)}
						</div>
					)
				)}
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
