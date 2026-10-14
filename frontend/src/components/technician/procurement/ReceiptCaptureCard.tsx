import { useEffect, useState } from "react";
import {
	Camera,
	Check,
	Loader2,
	MapPin,
	MapPinOff,
	Maximize2,
	RefreshCw,
	ScanLine,
} from "lucide-react";
import { useRetryOcr, useUploadReceipt } from "../../../hooks/useFieldPurchases";
import { useToast } from "../../ui/useToast";
import { errorMessage } from "../../../util/util";
import { captureFrom } from "./receiptCapture";
import ReceiptScanner from "./ReceiptScanner";
import ReceiptLightbox from "../../fieldPurchases/ReceiptLightbox";
import { FOCUS_RING } from "../../fieldPurchases/fieldPurchaseFormat";
import type { FieldPurchase } from "../../../types/fieldPurchases";
import { sheetCopy } from "./sheetCopy";

interface Props {
	purchase: FieldPurchase;
	editable: boolean;
}

export default function ReceiptCaptureCard({ purchase, editable }: Props) {
	const [scanning, setScanning] = useState(false);
	const [viewing, setViewing] = useState(false);
	const [rotation, setRotation] = useState(0);
	const [preview, setPreview] = useState<string | null>(null);
	const upload = useUploadReceipt();
	const retryOcr = useRetryOcr();
	const toast = useToast();
	const copy = sheetCopy(purchase.kind);

	// The object URL holds the whole photo in memory until it is let go, and a
	// technician can retake one several times before it uploads.
	useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

	const hasReceipt = !!purchase.receipt_image_url;
	// The local preview wins while an upload is in flight — it is the photo the
	// technician just took, and the server URL still points at the old one.
	const shown = preview ?? purchase.receipt_image_url;
	// A retake is a new document. Without this, a technician who turned a bad shot
	// sideways to read it gets the correctly-oriented replacement served rotated.
	// The dispatch viewer resets the same way on a url change.
	useEffect(() => setRotation(0), [shown]);
	const hasGeo = purchase.has_geo;
	const reading = purchase.ocr_status === "pending";
	const readFailed = purchase.ocr_status === "failed";

	async function onRetryOcr() {
		try {
			await retryOcr.mutateAsync(purchase.id);
		} catch (err) {
			toast.error(errorMessage(err, `Could not read the ${copy.noun}`));
		}
	}

	// Throws on purpose: the scanner is still open and shows the reason next to a
	// Retake, which is a better place to fail than a toast behind a closed sheet.
	async function onAccept(file: File) {
		const capture = await captureFrom(file);
		await upload.mutateAsync({ id: purchase.id, capture });
		setPreview(URL.createObjectURL(capture.file));
		setScanning(false);
		toast.success(`${copy.receiptTitle} attached`);
	}

	return (
		<section className="rounded-xl border border-border bg-base p-4">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-sm font-semibold text-text-primary">
					{copy.receiptTitle}
				</h2>
				{hasReceipt && (
					<span className="inline-flex items-center gap-1 text-xs text-text-muted">
						{hasGeo ? (
							<MapPin aria-hidden size={12} />
						) : (
							<MapPinOff aria-hidden size={12} />
						)}
						{hasGeo ? "Location recorded" : "No location"}
					</span>
				)}
			</div>

			{shown && (
				<>
					<button
						type="button"
						onClick={() => setViewing(true)}
						aria-label={`Open the ${copy.noun} photo full screen`}
						className={`relative mb-3 block min-h-11 w-full overflow-hidden rounded-lg border border-border transition-colors duration-150 hover:bg-surface-raised ${FOCUS_RING}`}
					>
						{/* Cropped to a consistent strip rather than letterboxed: a
						    receipt is tall and narrow, and object-contain shrank the
						    print to nothing to fit the whole page in. Reading it is
						    the sheet's job, not the thumbnail's. */}
						<img
							src={shown}
							alt=""
							className="h-40 w-full object-cover object-top"
						/>
						<span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-overlay px-2 py-1 text-xs font-medium text-text-primary">
							<Maximize2 aria-hidden size={12} /> Tap to
							read
						</span>
					</button>
					{viewing && (
						<ReceiptLightbox
							url={shown}
							label={`${copy.receiptTitle} photo`}
							rotation={rotation}
							onRotate={() =>
								setRotation((r) => (r + 90) % 360)
							}
							onClose={() => setViewing(false)}
						/>
					)}
				</>
			)}

			{/* One live region for the three OCR states, not three: they replace each
			    other on the detail poll, and three regions announcing in sequence reads
			    worse than one that changes. Always mounted so the change is what fires. */}
			<div role="status" aria-live="polite">
				{/* Reading is advisory progress: the lines can be typed in at any point,
				    and the tech is never blocked waiting for it. */}
				{hasReceipt && reading && (
					<p className="mb-3 inline-flex items-center gap-1.5 text-xs text-text-secondary">
						<Loader2
							aria-hidden
							size={12}
							className="animate-spin"
						/>{" "}
						Reading the {copy.noun}…
					</p>
				)}
				{hasReceipt &&
					purchase.ocr_status === "succeeded" &&
					purchase.ocr_line_count != null && (
						<p className="mb-3 inline-flex items-center gap-1.5 text-xs text-text-muted">
							<ScanLine aria-hidden size={12} /> Read{" "}
							{purchase.ocr_line_count} line
							{purchase.ocr_line_count === 1 ? "" : "s"} —
							check each one against the paper.
						</p>
					)}
				{hasReceipt && purchase.ocr_status === "skipped" && purchase.ocr_error && (
					<p className="mb-3 flex items-start gap-1.5 text-xs text-text-secondary">
						<ScanLine aria-hidden size={12} className="mt-0.5 shrink-0" />
						{purchase.ocr_error}
					</p>
				)}
				{hasReceipt && readFailed && editable && (
					<div className="mb-3 flex items-center justify-between gap-2 rounded-md bg-warning-bg px-2.5 py-2">
						<p className="text-xs text-warning-text">
							Could not read the {copy.noun} — enter the
							lines by hand.
						</p>
						<button
							type="button"
							disabled={retryOcr.isPending}
							onClick={() => void onRetryOcr()}
							className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-warning-text underline-offset-2 hover:underline disabled:opacity-40"
						>
							<RefreshCw
								aria-hidden
								size={12}
								className={
									retryOcr.isPending
										? "animate-spin"
										: ""
								}
							/>{" "}
							Try again
						</button>
					</div>
				)}
			</div>

			{editable ? (
				<>
					<button
						type="button"
						onClick={() => setScanning(true)}
						className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary-hover text-sm font-medium text-on-primary transition-colors hover:bg-primary-active"
					>
						<Camera aria-hidden size={16} />
						{hasReceipt
							? "Replace photo"
							: copy.photograph}
					</button>
					{scanning && (
						<ReceiptScanner
							title={
								hasReceipt
									? "Replace photo"
									: copy.photograph
							}
							confirmLabel={
								hasReceipt
									? "Replace photo"
									: "Use photo"
							}
							onAccept={onAccept}
							onClose={() => setScanning(false)}
						/>
					)}
					{!hasReceipt && (
						<p className="mt-2 text-xs text-text-muted">
							{copy.photoRequired}
						</p>
					)}
				</>
			) : hasReceipt ? (
				<p className="inline-flex items-center gap-1.5 text-xs text-text-muted">
					<Check aria-hidden size={12} /> Captured
					{purchase.captured_at
						? ` ${new Date(purchase.captured_at).toLocaleString()}`
						: ""}
				</p>
			) : (
				// A purchase awaiting pre-approval has not been bought, so there is
				// nothing to have photographed. Claiming otherwise is the one thing
				// this card must not do.
				<p className="text-xs text-text-muted">{copy.noPhoto}</p>
			)}
		</section>
	);
}
