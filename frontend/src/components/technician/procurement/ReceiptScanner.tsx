import { useEffect, useRef, useState } from "react";
import {
	Camera,
	Check,
	Flashlight,
	FlashlightOff,
	Image as ImageIcon,
	Loader2,
	RotateCcw,
	X,
	ZoomIn,
} from "lucide-react";
import { useCameraStream, type UseCameraStreamResult } from "../../../hooks/useCameraStream";
import { useDialogA11y } from "../../../hooks/useDialogA11y";
import { usePinchZoom } from "../../../hooks/usePinchZoom";
import { errorMessage } from "../../../util/util";
import { grabFrame } from "./receiptCapture";

/**
 * Receipt capture, camera-first.
 *
 * Replaces a hidden file input with `capture="environment"`, one attribute doing
 * two incompatible jobs: Android jumps to the camera and cannot reach the gallery,
 * iOS shows a chooser instead of a camera, and neither lets a technician look at
 * the shot before it becomes the only record of the purchase. So: live preview,
 * torch, shutter, then a review step that can be zoomed and retaken.
 */

/** Review zoom, in image-width multiples; the container scrolls to pan. */
const ZOOM_STEPS = [1, 2, 3] as const;

const GALLERY_ACCEPT = "image/*,.heic,.heif";

const STAGE = "relative flex aspect-[3/4] max-h-[65vh] items-center justify-center bg-black";
const OVERLAY_CHIP = "pointer-events-none absolute rounded-md bg-black/60 px-2 py-1 text-white";

interface Props {
	onAccept: (file: File) => Promise<void>;
	onClose: () => void;
	title?: string;
	/** Label on the accept button — the next step differs per entry point. */
	confirmLabel?: string;
}

export default function ReceiptScanner({
	onAccept,
	onClose,
	title = "Photograph receipt",
	confirmLabel = "Use photo",
}: Props) {
	const [candidate, setCandidate] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [grabbing, setGrabbing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const reviewing = candidate !== null;
	const camera = useCameraStream({
		resolution: "document",
		fallbackHint: "Choose a photo instead.",
		// The review stage replaces the preview entirely; the camera has nothing to
		// show and no reason to stay open behind it.
		active: !reviewing,
	});
	const cameraDown = camera.status === "error";

	// The object URL holds the whole photo in memory until it is let go, and a
	// technician can retake one several times before it uploads.
	useEffect(() => {
		if (!candidate) {
			setPreviewUrl(null);
			return;
		}
		const url = URL.createObjectURL(candidate);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [candidate]);

	// Escape is held off mid-upload: the request is already in flight and the
	// purchase would be left without the photo it is waiting on. Everything else
	// — initial focus, the Tab trap, focus back to whatever opened this — is the
	// hook's, which is why the close button no longer holds a ref of its own.
	const dialogProps = useDialogA11y<HTMLDivElement>(() => {
		if (!busy) onClose();
	});

	async function onShutter() {
		const video = camera.videoRef.current;
		if (!video) return;
		setGrabbing(true);
		setFailure(null);
		try {
			setCandidate(await grabFrame(video, camera.trackRef.current));
		} catch (err) {
			setFailure(errorMessage(err, "Could not take the photo — try again."));
		} finally {
			setGrabbing(false);
		}
	}

	async function onUse() {
		if (!candidate) return;
		setBusy(true);
		setFailure(null);
		try {
			await onAccept(candidate);
		} catch (err) {
			// Kept on the review step on purpose: the photo is still in hand, so the
			// way out is one more tap rather than another trip to the camera.
			setFailure(errorMessage(err, "Could not attach the receipt"));
		} finally {
			setBusy(false);
		}
	}

	function onGalleryPick(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setFailure(null);
		setCandidate(file);
	}

	return (
		<div
			{...dialogProps}
			aria-label={title}
			className="fixed inset-0 z-[60] flex items-center justify-center bg-overlay"
		>
			<div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-canvas shadow-2xl">
				<div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
					<span className="flex items-center gap-2 text-sm font-bold text-text-primary">
						<Camera aria-hidden size={16} className="text-primary" />
						{reviewing ? "Check the photo" : title}
					</span>
					{/* The glyph stays at 16; the target grows to the 44px every other
					    control in this flow already is. The negative margin keeps the X
					    optically where it was against the header padding. */}
					<button
						type="button"
						onClick={onClose}
						disabled={busy}
						aria-label="Close"
						className="-mr-3.5 flex h-11 w-11 items-center justify-center text-text-faint transition-colors hover:text-text-secondary disabled:opacity-40"
					>
						<X aria-hidden size={16} />
					</button>
				</div>

				{reviewing ? (
					<ReviewStage previewUrl={previewUrl} />
				) : (
					<CaptureStage
						camera={camera}
						grabbing={grabbing}
						onShutter={() => void onShutter()}
					/>
				)}

				{failure && (
					<p className="flex-shrink-0 bg-warning-bg px-5 py-2 text-xs text-warning-text">
						{failure}
					</p>
				)}

				<input
					ref={fileRef}
					type="file"
					// No `capture` attribute: this path exists precisely to reach a photo
					// that was already taken, which `capture` suppresses on Android.
					accept={GALLERY_ACCEPT}
					className="hidden"
					// Cleared after every pick: without it, re-choosing the same photo
					// after a failed upload fires no change event at all.
					onChange={onGalleryPick}
				/>

				{reviewing ? (
					<div className="flex flex-shrink-0 gap-2 border-t border-border px-5 py-3.5">
						<button
							type="button"
							onClick={() => setCandidate(null)}
							disabled={busy}
							className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface text-sm font-medium text-text-primary transition-colors hover:enabled:border-border-strong disabled:opacity-40"
						>
							<RotateCcw aria-hidden size={15} /> Retake
						</button>
						<button
							type="button"
							onClick={() => void onUse()}
							disabled={busy}
							className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary-hover text-sm font-semibold text-on-primary transition-colors hover:enabled:bg-primary-active disabled:opacity-40"
						>
							{busy ? (
								<Loader2
									aria-hidden
									size={15}
									className="animate-spin"
								/>
							) : (
								<Check aria-hidden size={15} />
							)}
							{busy ? "Uploading…" : confirmLabel}
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						className={`flex flex-shrink-0 items-center justify-center gap-1.5 border-t border-border px-5 py-3.5 text-sm transition-colors ${
							cameraDown
								? "font-semibold text-primary"
								: "font-medium text-text-secondary hover:text-text-primary"
						}`}
					>
						<ImageIcon aria-hidden size={15} />
						{cameraDown
							? "Choose a photo"
							: "Choose an existing photo"}
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * The shot, before it becomes the record. Zoom is stepped rather than pinched:
 * the container scrolls, so panning a 3x receipt is the same gesture the
 * technician already uses on every other page.
 */
function ReviewStage({ previewUrl }: { previewUrl: string | null }) {
	const [zoomStep, setZoomStep] = useState(0);
	const zoom = ZOOM_STEPS[zoomStep];

	return (
		<div className={`${STAGE} overflow-auto`}>
			{previewUrl && (
				<img
					src={previewUrl}
					alt="Receipt just captured"
					style={{ width: `${zoom * 100}%` }}
					className="max-w-none object-contain"
				/>
			)}
			<button
				type="button"
				onClick={() => setZoomStep((s) => (s + 1) % ZOOM_STEPS.length)}
				aria-label={`Zoom, currently ${zoom} times`}
				className="absolute bottom-3 right-3 flex h-11 items-center gap-1.5 rounded-full bg-black/60 px-3.5 text-xs font-semibold text-white"
			>
				<ZoomIn aria-hidden size={16} />
				{zoom}×
			</button>
		</div>
	);
}

function CaptureStage({
	camera,
	grabbing,
	onShutter,
}: {
	camera: UseCameraStreamResult;
	grabbing: boolean;
	onShutter: () => void;
}) {
	const down = camera.status === "error";
	const { containerRef, zoomIndicator, pinchHint, pinchHandlers } = usePinchZoom({
		zoomCaps: camera.zoomCaps,
		zoomLevel: camera.zoomLevel,
		setZoom: camera.setZoom,
		enabled: !down,
	});

	if (down) {
		return (
			<div className={STAGE}>
				<p className="px-6 py-10 text-center text-sm text-text-muted">
					{camera.errorMessage}
				</p>
			</div>
		);
	}

	const starting = camera.status === "starting";
	const torchLabel = camera.torchOn ? "Turn torch off" : "Turn torch on";
	const caption = starting
		? "Starting camera…"
		: "Fill the frame with the receipt — flatten it if you can";

	return (
		<div
			ref={containerRef}
			{...pinchHandlers}
			className={`${STAGE} touch-none overflow-hidden`}
		>
			<video
				ref={camera.videoRef}
				className="h-full w-full object-cover"
				muted
				playsInline
			/>

			<div className="pointer-events-none absolute inset-x-6 inset-y-4 rounded-lg border-2 border-dashed border-white/50" />

			{starting && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
					<Loader2
						aria-hidden
						size={28}
						className="text-text-faint motion-safe:animate-spin"
					/>
				</div>
			)}

			{zoomIndicator && (
				<div
					className={`${OVERLAY_CHIP} left-3 top-3 text-xs font-semibold`}
				>
					{zoomIndicator}
				</div>
			)}

			{pinchHint && (
				<div
					className={`${OVERLAY_CHIP} left-3 right-3 top-3 text-center text-xs font-medium`}
				>
					{pinchHint}
				</div>
			)}

			{camera.torchSupported && (
				<button
					type="button"
					onClick={() => camera.setTorch(!camera.torchOn)}
					aria-label={torchLabel}
					className={`absolute bottom-4 right-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 transition-colors ${
						camera.torchOn ? "text-primary" : "text-white"
					}`}
				>
					{camera.torchOn ? (
						<FlashlightOff aria-hidden size={18} />
					) : (
						<Flashlight aria-hidden size={18} />
					)}
				</button>
			)}

			<button
				type="button"
				onClick={onShutter}
				disabled={starting || grabbing}
				aria-label="Take photo"
				className="absolute bottom-4 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full bg-white ring-4 ring-white/30 transition-transform active:scale-95 disabled:opacity-40"
			>
				{grabbing ? (
					<Loader2 aria-hidden size={22} className="animate-spin text-black" />
				) : (
					<Camera aria-hidden size={22} className="text-black" />
				)}
			</button>

			<div
				aria-live="polite"
				className="pointer-events-none absolute bottom-20 left-3 right-3 text-center text-xs font-medium text-white/90"
			>
				{caption}
			</div>
		</div>
	);
}
