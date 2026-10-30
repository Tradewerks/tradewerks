import { useState, useRef } from "react";
import { Plus, Edit2, Trash2, X } from "lucide-react";
import Card from "../ui/Card";
import { HEADER_BTN_PRIMARY } from "../ui/headerActions";
import ConfirmDialog from "../ui/ConfirmDialog";
import type { ProjectNote, ProjectNotePhoto, UpdateProjectNoteInput } from "../../types/project";
import type { NotePhoto } from "../../types/jobs";
import {
	useProjectNotesQuery,
	useCreateProjectNoteMutation,
	useUpdateProjectNoteMutation,
	useDeleteProjectNoteMutation,
	useUploadProjectNotePhotoMutation,
} from "../../hooks/useProjects";
import { usePermission } from "../../hooks/usePermission";
import NotePhotoGallery from "../jobs/NotePhotoGallery";
import NotePhotoPicker from "../jobs/NotePhotoPicker";

interface ProjectNoteManagerProps {
	projectId: string;
}

export default function ProjectNoteManager({ projectId }: ProjectNoteManagerProps) {
	const formRef = useRef<HTMLDivElement>(null);
	const [isAdding, setIsAdding] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [content, setContent] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const [photos, setPhotos] = useState<NotePhoto[]>([]);
	const [existingPhotos, setExistingPhotos] = useState<ProjectNotePhoto[]>([]);

	const { data: notes, isLoading } = useProjectNotesQuery(projectId);
	const createNote = useCreateProjectNoteMutation();
	const updateNote = useUpdateProjectNoteMutation();
	const deleteNote = useDeleteProjectNoteMutation();
	const uploadPhoto = useUploadProjectNotePhotoMutation();

	const EDIT_NOTES = usePermission("edit_projects");

	const resetForm = () => {
		setContent("");
		setIsAdding(false);
		setEditingId(null);
		setErrorMessage(null);
		setPhotos([]);
		setExistingPhotos([]);
	};

	const handleEdit = (note: ProjectNote) => {
		if (!EDIT_NOTES) return;
		setContent(note.content);
		setEditingId(note.id);
		setIsAdding(true);
		setExistingPhotos(note.photos ?? []);
		setPhotos([]);
	};

	const handleDelete = (noteId: string) => {
		if (!EDIT_NOTES) return;
		setDeleteError(null);
		setNoteToDelete(noteId);
	};

	const confirmDelete = async () => {
		if (!noteToDelete) return;
		try {
			await deleteNote.mutateAsync({ projectId, noteId: noteToDelete });
			setNoteToDelete(null);
		} catch (error) {
			console.error("Failed to delete note:", error);
			setDeleteError(error instanceof Error ? error.message : "Failed to delete note");
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!EDIT_NOTES) return;
		setErrorMessage(null);

		if (!content.trim()) return;

		try {
			if (editingId) {
				const updateData: UpdateProjectNoteInput = {
					content,
					photos: [
						...existingPhotos.map((p) => ({ id: p.id, photo_url: p.photo_url, photo_label: p.photo_label })),
						...photos.map((p) => ({ photo_url: p.photo_url, photo_label: p.photo_label, photo_name: p.photo_name })),
					],
				};

				await updateNote.mutateAsync({
					projectId,
					noteId: editingId,
					data: updateData,
				});
			} else {
				await createNote.mutateAsync({
					projectId,
					data: {
						content,
						photos: photos.map((p) => ({
							photo_url: p.photo_url,
							photo_label: p.photo_label,
							photo_name: p.photo_name,
						})),
					},
				});
			}
			resetForm();
		} catch (error) {
			console.error("Failed to save note:", error);
			const errorMsg =
				error instanceof Error ? error.message : "Failed to save note";
			setErrorMessage(errorMsg);
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

	if (isLoading) {
		return (
			<Card title="Project Notes" className="h-fit">
				<div className="text-text-tertiary text-sm">Loading notes...</div>
			</Card>
		);
	}

	return (
		<Card
			title="Project Notes"
			headerAction={
				<button
					disabled={!EDIT_NOTES}
					title={!EDIT_NOTES ? "You don't have permission to perform this action" : ""}
					onClick={() => {
						if (!EDIT_NOTES) return;
						setIsAdding(true);
					}}
					className={HEADER_BTN_PRIMARY}
				>
					<Plus size={14} />
					Add Note
				</button>
			}
			className="h-fit"
		>
			<div className="space-y-4">
				{isAdding && !editingId && (
					<div ref={formRef} className="p-4 bg-surface rounded-lg border border-border">
						<div className="flex justify-between items-center mb-4">
							<h3 className="text-text-primary font-semibold">New Note</h3>
							<button
								onClick={resetForm}
								className="text-text-tertiary hover:text-text-primary transition-colors"
							>
								<X size={20} />
							</button>
						</div>

						{errorMessage && (
							<div className="mb-4 p-3 bg-error-bg border border-error-border rounded-md text-error-text text-sm">
								{errorMessage}
							</div>
						)}

						<form onSubmit={handleSubmit} className="space-y-3">
							<textarea
								value={content}
								onChange={(e) => setContent(e.target.value)}
								placeholder="Enter your note..."
								rows={4}
								className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
								required
								autoFocus
							/>

							<NotePhotoPicker
								uploadPhoto={(file) => uploadPhoto.mutateAsync({ projectId, file })}
								capture={false}
								photos={photos}
								onPhotosChange={setPhotos}
								disabled={createNote.isPending}
							/>

							<button
								type="submit"
								disabled={createNote.isPending || updateNote.isPending}
								className="w-full px-4 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded-md text-sm font-medium transition-colors"
							>
								{createNote.isPending || updateNote.isPending ? "Saving..." : "Add Note"}
							</button>
						</form>
					</div>
				)}

				{notes && notes.length > 0 ? (
					<div className="space-y-3">
						{notes.map((note) => (
							<div key={note.id}>
								<div className="p-3 bg-surface rounded-lg border border-border group hover:border-border-strong transition-colors">
									<div className="flex justify-between items-start mb-2">
										<div className="flex-1">
											{note.photos && note.photos.length > 0 && (
												<NotePhotoGallery photos={note.photos} />
											)}
											<p className="text-text-primary text-sm mb-1 whitespace-pre-wrap">
												{note.content}
											</p>
										</div>

										<div className="flex gap-2 ml-3 opacity-0 group-hover:opacity-100 transition-opacity">
											<button
												onClick={() => handleEdit(note)}
												disabled={!EDIT_NOTES}
												className="text-text-tertiary hover:text-primary-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
												aria-label="Edit note"
											>
												<Edit2 size={14} />
											</button>
											<button
												onClick={() => handleDelete(note.id)}
												disabled={!EDIT_NOTES}
												className="text-text-tertiary hover:text-error-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
												title="Delete note"
												aria-label="Delete note"
											>
												<Trash2 size={14} />
											</button>
										</div>
									</div>

									<div className="flex items-center gap-2 text-xs text-text-muted">
										<span>{formatDate(note.created_at)}</span>
										{note.updated_at &&
											new Date(note.updated_at).getTime() !== new Date(note.created_at).getTime() && (
												<span>(edited)</span>
											)}
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
								</div>

								{editingId === note.id && (
									<div className="mt-2">
										<div ref={formRef} className="p-4 bg-surface rounded-lg border border-border">
											<div className="flex justify-between items-center mb-4">
												<h3 className="text-text-primary font-semibold">Edit Note</h3>
												<button
													onClick={resetForm}
													className="text-text-tertiary hover:text-text-primary transition-colors"
												>
													<X size={20} />
												</button>
											</div>

											{errorMessage && (
												<div className="mb-4 p-3 bg-error-bg border border-error-border rounded-md text-error-text text-sm">
													{errorMessage}
												</div>
											)}

											<form onSubmit={handleSubmit} className="space-y-3">
												<textarea
													value={content}
													onChange={(e) => setContent(e.target.value)}
													placeholder="Enter your note..."
													rows={4}
													className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary"
													required
													autoFocus
												/>

												<NotePhotoPicker
													uploadPhoto={(file) => uploadPhoto.mutateAsync({ projectId, file })}
													capture={false}
													photos={photos}
													onPhotosChange={setPhotos}
													existingPhotos={existingPhotos}
													onRemoveExisting={(id) =>
														setExistingPhotos((prev) => prev.filter((p) => p.id !== id))
													}
													disabled={updateNote.isPending}
												/>

												<button
													type="submit"
													disabled={createNote.isPending || updateNote.isPending}
													className="w-full px-4 py-2 bg-primary-hover hover:bg-primary-active disabled:bg-primary-disabled disabled:cursor-not-allowed text-on-primary rounded-md text-sm font-medium transition-colors"
												>
													{createNote.isPending || updateNote.isPending ? "Saving..." : "Update Note"}
												</button>
											</form>
										</div>
									</div>
								)}
							</div>
						))}
					</div>
				) : (
					<p className="text-text-tertiary text-sm text-center py-4">No notes available</p>
				)}
			</div>

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
		</Card>
	);
}
