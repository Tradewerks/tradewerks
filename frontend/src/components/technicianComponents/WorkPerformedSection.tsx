import { useState, useMemo } from "react";
import { PlusCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useCreateJobNoteMutation, useJobNotesQuery } from "../../hooks/useJobs";
import { formatDateTime, FALLBACK_TIMEZONE } from "../../util/util";
import { useAuthStore } from "../../auth/authStore";
import type { JobNote, JobVisit } from "../../types/jobs";
import NotePhotoGallery from "../jobs/NotePhotoGallery";
import AddNotePhotoModal from "../../components/technicianComponents/AddNotePhotoModal";
import type { NotePhoto } from "../../components/technicianComponents/AddNotePhotoModal";

// ── Note Item ─────────────────────────────────────────────────────────────────

function NoteItem({ note, tz }: { note: JobNote; tz: string }) {
	return (
		<div className="px-4 py-3 border-b border-border-subtle last:border-0">
			{note.content && (
				<p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">{note.content}</p>
			)}
			{note.photos && note.photos.length > 0 && (
				<div className="mt-2">
					<NotePhotoGallery photos={note.photos} />
				</div>
			)}
			<p className="text-[11px] text-text-faint mt-1">
				{note.creator_tech?.name ?? note.creator_dispatcher?.name ?? "You"} · {formatDateTime(note.created_at, tz)}
			</p>
		</div>
	);
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function WorkPerformedSection({
	jobId,
	visitId,
}: {
	jobId: string;
	visitId: string;
}) {
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	const { data: notes = [], isLoading: notesLoading } = useJobNotesQuery(jobId);
	const createNote = useCreateJobNoteMutation();

	const [showNotePhotoModal, setShowNotePhotoModal] = useState(false);
	const [expanded, setExpanded] = useState(true);

	const visitNotes = useMemo(
		() =>
			[...notes]
				.filter((n) => n.visit_id === visitId || !n.visit_id)
				.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()),
		[notes, visitId],
	);

	const handleAddNotePhoto = async (
		visitId: string,
		jobId: string,
		content: string,
		photos: NotePhoto[],
	) => {
		await createNote.mutateAsync({
			jobId,
			data: {
				content,
				visit_id: visitId,
				photos: photos.map((p) => ({
					photo_url: p.photo_url,
					photo_label: p.photo_label,
					photo_name: p.photo_name,
				})),
			},
		});
	};

	return (
		<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
			{/* Header */}
			<button
				onClick={() => setExpanded((p) => !p)}
				aria-expanded={expanded}
				aria-controls="work-performed-panel"
				className="w-full flex items-center justify-between px-4 py-3 bg-base border-b border-border-subtle"
			>
				<span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
					Work Performed
					{visitNotes.length > 0 && (
						<span className="ml-2 text-text-muted font-normal normal-case tracking-normal">
							({visitNotes.length})
						</span>
					)}
				</span>
				{expanded ? <ChevronUp size={14} className="text-text-muted" /> : <ChevronDown size={14} className="text-text-muted" />}
			</button>

			{expanded && (
				<>
					{/* Action row */}
					<div id="work-performed-panel" className="px-4 py-3 border-b border-border-subtle bg-surface">
						<button
							onClick={() => setShowNotePhotoModal(true)}
							className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-surface border border-border text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
						>
							<PlusCircle size={14} />
							Add Note / Photo
						</button>
					</div>

					{/* Note list */}
					{notesLoading ? (
						// Reserves roughly a NoteItem's height so real notes popping in
						// don't shift the page layout (was a measured CLS contributor).
						<div className="px-4 py-3 space-y-2 animate-pulse">
							<div className="h-3.5 w-3/4 bg-surface rounded" />
							<div className="h-2.5 w-1/4 bg-surface rounded" />
						</div>
					) : visitNotes.length === 0 ? (
						<p className="px-4 py-6 text-center text-sm text-text-faint bg-surface">No notes yet</p>
					) : (
						<div className="bg-surface">
							{visitNotes.map((note) => (
								<NoteItem key={note.id} note={note} tz={tz} />
							))}
						</div>
					)}
				</>
			)}

			{/* Add Note / Photo modal */}
			{showNotePhotoModal && (
				<AddNotePhotoModal
					visits={[{ id: visitId, job_id: jobId } as JobVisit]}
					preselectedVisitId={visitId}
					onClose={() => setShowNotePhotoModal(false)}
					onSubmit={handleAddNotePhoto}
				/>
			)}
		</div>
	);
}
