import { useRef, useState } from "react";
import { X, Camera, Loader2 } from "lucide-react";
import axios from "axios";
import { useUploadNotePhotoMutation } from "../../hooks/useJobs";
import type { NotePhoto, JobNotePhoto } from "../../types/jobs";
import ImageCarousel from "../inventory/ImageCarousel";

const PHOTO_LABELS = ["Before", "After", "Other"] as const;
type PhotoLabel = (typeof PHOTO_LABELS)[number];

// Mirrors backend/src/lib/upload.ts (noteImageUpload): jpeg/png/webp, 5MB.
const NOTE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const NOTE_PHOTO_ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Client-side pre-check so a rejected file never leaves the device; null when OK. */
const validateNotePhoto = (file: Pick<File, "size" | "type">): string | null => {
	if (!(NOTE_PHOTO_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
		return "Unsupported file type. Please choose a JPEG, PNG, or WebP image.";
	}
	if (file.size > NOTE_PHOTO_MAX_BYTES) {
		return `Photo is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum size is 5 MB.`;
	}
	return null;
};

const uploadErrorMessage = (err: unknown): string => {
	if (axios.isAxiosError(err)) {
		const serverMessage = err.response?.data?.error?.message;
		if (typeof serverMessage === "string" && serverMessage) return serverMessage;
	}
	if (err instanceof Error && err.message) return err.message;
	return "Upload failed. Please try again.";
};

interface NotePhotoPickerProps {
	jobId?: string;
	/** Overrides the default job-note upload endpoint; use for non-job entities (e.g. projects). */
	uploadPhoto?: (file: File) => Promise<{ url: string; raw_url: string }>;
	photos: NotePhoto[];
	onPhotosChange: (photos: NotePhoto[]) => void;
	disabled?: boolean;
	existingPhotos?: JobNotePhoto[];
	onRemoveExisting?: (id: string) => void;
	/**
	 * Passed through to the file input. Defaults to "environment" (rear camera on
	 * mobile) because the technician note modal relies on it; dispatcher callers can
	 * pass `capture={false}` to get a plain file picker.
	 */
	capture?: "environment" | "user" | false;
}

export default function NotePhotoPicker({
	jobId,
	uploadPhoto,
	photos,
	onPhotosChange,
	disabled,
	existingPhotos,
	onRemoveExisting,
	capture = "environment",
}: NotePhotoPickerProps) {
	const [pendingFile, setPendingFile] = useState<File | null>(null);
	const [labelPickerOpen, setLabelPickerOpen] = useState(false);
	const [selectedLabel, setSelectedLabel] = useState<PhotoLabel>("Before");
	const [isUploading, setIsUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [pendingUpload, setPendingUpload] = useState<{ url: string; raw_url: string } | null>(null);

	const fileInputRef = useRef<HTMLInputElement>(null);
	const uploadMutation = useUploadNotePhotoMutation();

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;

		const validationError = validateNotePhoto(file);
		if (validationError) {
			setUploadError(validationError);
			return;
		}

		setUploadError(null);
		setIsUploading(true);
		setLabelPickerOpen(true);
		setPendingFile(file);
		setSelectedLabel("Before");

		try {
			const res = uploadPhoto
				? await uploadPhoto(file)
				: await uploadMutation.mutateAsync({ jobId: jobId!, file });
			setPendingUpload(res);
		} catch (err) {
			setUploadError(uploadErrorMessage(err));
			setLabelPickerOpen(false);
			setPendingFile(null);
		} finally {
			setIsUploading(false);
		}
	};

	const handleConfirmLabel = () => {
		if (!pendingFile || !pendingUpload) return;
		onPhotosChange([
			...photos,
			{ photo_url: pendingUpload.raw_url, photo_label: selectedLabel, filename: pendingFile.name, preview_url: pendingUpload.url },
		]);
		setPendingFile(null);
		setLabelPickerOpen(false);
		setUploadError(null);
		setPendingUpload(null);
	};

	const handleCancelLabel = () => {
		setPendingFile(null);
		setPendingUpload(null);
		setLabelPickerOpen(false);
		setUploadError(null);
	};

	const handleRemovePhoto = (idx: number) => {
		onPhotosChange(photos.filter((_, i) => i !== idx));
	};

	return (
		<>
			{existingPhotos && existingPhotos.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{existingPhotos.map((p) => (
						<div
							key={p.id}
							className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-surface border border-border text-xs text-text-secondary"
						>
							<Camera size={11} className="text-text-muted shrink-0" />
							<span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary-bg text-primary-text border border-primary-border">
								{p.photo_label}
							</span>
							{onRemoveExisting && (
								<button
									type="button"
									onClick={() => onRemoveExisting(p.id)}
									aria-label="Remove photo"
									className="text-text-faint hover:text-text-secondary ml-0.5 p-0.5"
								>
									<X size={11} />
								</button>
							)}
						</div>
					))}
				</div>
			)}

			{photos.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{photos.map((p, i) => (
						<div
							key={i}
							className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-surface border border-border text-xs text-text-secondary"
						>
							<Camera size={11} className="text-text-muted shrink-0" />
							<span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary-bg text-primary-text border border-primary-border">
								{p.photo_label}
							</span>
							<span className="max-w-[100px] truncate text-text-tertiary">{p.filename}</span>
							<button
								type="button"
								onClick={() => handleRemovePhoto(i)}
								aria-label={`Remove ${p.filename}`}
								className="text-text-faint hover:text-text-secondary ml-0.5 p-0.5"
							>
								<X size={11} />
							</button>
						</div>
					))}
				</div>
			)}

			<div>
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					disabled={disabled || labelPickerOpen || isUploading}
					className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-border text-xs text-text-muted hover:text-text-secondary hover:border-border-strong transition-colors disabled:opacity-40"
				>
					{isUploading ? (
						<Loader2 size={13} className="animate-spin" />
					) : (
						<Camera size={13} />
					)}
					{photos.length > 0 ? "Attach Another Photo" : "Attach Photo"}
				</button>
				{uploadError && <p role="alert" className="text-xs text-error-text mt-1.5">{uploadError}</p>}
			</div>

			<input
				ref={fileInputRef}
				type="file"
				accept={NOTE_PHOTO_ACCEPTED_TYPES.join(",")}
				{...(capture ? { capture } : {})}
				className="hidden"
				onChange={handleFileChange}
			/>

			{labelPickerOpen && (
				<div className="fixed inset-0 z-[65] flex items-end justify-center">
					<div className="absolute inset-0 bg-overlay" />
					<div className="relative w-full max-w-lg bg-base rounded-t-2xl border border-border-subtle p-4 pb-8 z-10">
						<div className="flex items-center justify-between mb-3">
							<h3 className="text-sm font-semibold text-text-primary">Photo Type</h3>
							<button
								type="button"
								onClick={handleCancelLabel}
								aria-label="Close"
								className="text-text-muted hover:text-text-primary"
							>
								<X size={18} />
							</button>
						</div>
						{pendingFile && (
							<p className="text-xs text-text-muted mb-3 truncate">{pendingFile.name}</p>
						)}
						{isUploading ? (
							<div className="flex items-center justify-center gap-2 py-6 text-text-muted text-sm">
								<Loader2 size={16} className="animate-spin" />
								Uploading…
							</div>
						) : uploadError ? (
							<p className="text-xs text-error-text py-4 text-center">{uploadError}</p>
						) : (
							<>
								{pendingUpload && (
									<ImageCarousel
										images={[pendingUpload.url]}
										compact
										objectFit="contain"
										frameClassName="h-80"
										className="w-full mb-4"
									/>
								)}
								<div className="flex gap-2 mb-4">
									{PHOTO_LABELS.map((l) => (
										<button
											key={l}
											type="button"
											onClick={() => setSelectedLabel(l)}
											className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${
												selectedLabel === l
													? "bg-primary-hover text-on-primary"
													: "bg-surface text-text-tertiary border border-border hover:bg-surface-raised"
											}`}
										>
											{l}
										</button>
									))}
								</div>
								<div className="flex gap-2">
									<button
										type="button"
										onClick={handleCancelLabel}
										className="flex-1 py-2 text-sm rounded-lg border border-border text-text-tertiary hover:bg-surface"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={handleConfirmLabel}
										className="flex-1 py-2 text-sm rounded-lg bg-primary-hover hover:bg-primary text-on-primary font-medium"
									>
										Attach Photo →
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</>
	);
}
