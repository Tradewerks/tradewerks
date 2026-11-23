import { useRef, useState } from "react";
import { Loader2, Trash2, Upload, UserRound } from "lucide-react";
import {
	useDeleteTechnicianPhotoMutation,
	useTechnicianByIdQuery,
	useUploadTechnicianPhotoMutation,
} from "../../hooks/useTechnicians";

// Mirrors backend/src/lib/upload.ts (imageUpload): jpeg/png/webp, 5MB.
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

const BUTTON =
	"flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50";

export default function TechnicianPhotoField({ technicianId }: { technicianId: string }) {
	const { data: tech, isLoading } = useTechnicianByIdQuery(technicianId);
	const upload = useUploadTechnicianPhotoMutation();
	const remove = useDeleteTechnicianPhotoMutation();
	const [error, setError] = useState<string | null>(null);
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const photo = tech?.photo_url && tech.photo_url !== failedUrl ? tech.photo_url : null;
	const busy = upload.isPending || remove.isPending;

	const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		if (!ACCEPTED.includes(file.type) || file.size > MAX_BYTES) {
			setError("Choose a JPEG, PNG, or WebP image under 5 MB.");
			return;
		}
		setError(null);
		try {
			await upload.mutateAsync({ id: technicianId, file });
		} catch {
			setError("Upload failed. Please try again.");
		}
	};

	const handleRemove = async () => {
		setError(null);
		try {
			await remove.mutateAsync(technicianId);
		} catch {
			setError("Couldn't remove the photo. Please try again.");
		}
	};

	return (
		<div className="flex items-center gap-3 min-w-0">
			{isLoading ? (
				<div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-surface" />
			) : photo ? (
				<img
					src={photo}
					alt={tech?.name ?? "Technician"}
					className="h-12 w-12 shrink-0 rounded-full bg-surface object-cover"
					onError={() => setFailedUrl(photo)}
				/>
			) : (
				<div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface">
					<UserRound
						size={20}
						className="text-text-muted"
						aria-hidden="true"
					/>
				</div>
			)}

			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						disabled={busy || isLoading}
						className={`${BUTTON} text-text-primary`}
					>
						{upload.isPending ? (
							<Loader2
								size={12}
								className="animate-spin"
							/>
						) : (
							<Upload size={12} />
						)}
						{upload.isPending
							? "Uploading…"
							: photo
								? "Replace Photo"
								: "Upload Photo"}
					</button>
					{photo && (
						<button
							type="button"
							onClick={handleRemove}
							disabled={busy}
							className={`${BUTTON} text-error-text hover:border-error-border hover:bg-error-bg`}
						>
							{remove.isPending ? (
								<Loader2
									size={12}
									className="animate-spin"
								/>
							) : (
								<Trash2 size={12} />
							)}
							Remove
						</button>
					)}
				</div>
				<p className="mt-1 text-xs text-text-tertiary">
					Customers see this on their visit page and in the on-my-way
					email.
				</p>
				{error && (
					<p role="alert" className="mt-1 text-xs text-error-text">
						{error}
					</p>
				)}
			</div>

			<input
				ref={fileRef}
				type="file"
				accept={ACCEPTED.join(",")}
				className="hidden"
				aria-label="Technician photo"
				onChange={handleFile}
			/>
		</div>
	);
}
