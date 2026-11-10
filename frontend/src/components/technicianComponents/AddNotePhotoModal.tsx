import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import type { JobVisit, NotePhoto } from "../../types/jobs";
import NotePhotoPicker from "../jobs/NotePhotoPicker";

export type { NotePhoto } from "../../types/jobs";

interface AddNotePhotoModalProps {
	visits: JobVisit[];
	preselectedVisitId?: string | null;
	onClose: () => void;
	onSubmit: (visitId: string, jobId: string, content: string, photos: NotePhoto[]) => Promise<void>;
}

export default function AddNotePhotoModal({
	visits,
	preselectedVisitId,
	onClose,
	onSubmit,
}: AddNotePhotoModalProps) {
	const [content, setContent] = useState("");
	const [selectedVisitId, setSelectedVisitId] = useState(
		preselectedVisitId ?? visits[0]?.id ?? "",
	);
	const [photos, setPhotos] = useState<NotePhoto[]>([]);
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [visible, setVisible] = useState(false);

	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const selectedVisit = visits.find((v) => v.id === selectedVisitId);
	const canSave = (content.trim().length > 0 || photos.length > 0) && !isSaving;

	useEffect(() => {
		setTimeout(() => setVisible(true), 10);
	}, []);

	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [content]);

	const handleSubmit = async () => {
		if (!canSave || !selectedVisit) return;
		setIsSaving(true);
		setSaveError(null);
		try {
			await onSubmit(selectedVisitId, selectedVisit.job_id, content.trim(), photos);
			onClose();
		} catch {
			setSaveError("Failed to save. Please try again.");
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="fixed inset-0 z-[60] flex items-end justify-center bg-overlay">
			<div
				className={`w-full max-w-lg bg-base rounded-t-2xl border border-border-subtle transition-transform duration-200 ease-out ${
					visible ? "translate-y-0" : "translate-y-full"
				}`}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3.5 border-b border-border-subtle">
					<h2 className="text-sm font-semibold text-text-primary">Add Note / Photo</h2>
					<button
						onClick={onClose}
						aria-label="Close"
						className="text-text-muted hover:text-text-primary p-3 -my-3 -mr-3 rounded-md hover:bg-surface transition-colors"
					>
						<X size={16} />
					</button>
				</div>

				{/* Visit pills */}
				{visits.length > 1 && (
					<div className="flex gap-2 px-4 py-2.5 overflow-x-auto border-b border-border-subtle scrollbar-none">
						{visits.map((v) => (
							<button
								key={v.id}
								onClick={() => setSelectedVisitId(v.id)}
								className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
									selectedVisitId === v.id
										? "bg-primary-hover text-on-primary"
										: "bg-surface border border-border text-text-tertiary hover:text-text-primary"
								}`}
							>
								{v.name ?? "Visit"}
								{v.job?.client?.name ? ` — ${v.job.client.name}` : ""}
							</button>
						))}
					</div>
				)}

				{/* Textarea */}
				<textarea
					ref={textareaRef}
					value={content}
					onChange={(e) => setContent(e.target.value)}
					placeholder="Add a note…"
					autoFocus
					className="w-full px-4 pt-3 pb-2 bg-transparent text-sm text-text-primary placeholder:text-faint focus:outline-none resize-none min-h-[96px] max-h-[40vh] overflow-y-auto"
				/>

				<div className="px-4 pb-3 space-y-2">
					<NotePhotoPicker
						jobId={selectedVisit?.job_id ?? ""}
						photos={photos}
						onPhotosChange={setPhotos}
						disabled={isSaving || !selectedVisit}
					/>
				</div>

				{/* Save error */}
				{saveError && (
					<p role="alert" className="text-xs text-error-text px-4 pb-2">{saveError}</p>
				)}

				{/* Actions */}
				<div className="flex gap-3 px-4 pt-3 pb-8 border-t border-border-subtle">
					<button
						onClick={onClose}
						className="flex-1 py-3 text-sm rounded-xl border border-border text-text-tertiary hover:bg-surface hover:text-text-primary transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={handleSubmit}
						disabled={!canSave}
						className="flex-1 py-3 text-sm rounded-xl bg-primary-hover hover:bg-primary text-on-primary font-semibold disabled:opacity-40 transition-colors"
					>
						{isSaving ? "Saving…" : "Save Note"}
					</button>
				</div>
			</div>
		</div>
	);
}
