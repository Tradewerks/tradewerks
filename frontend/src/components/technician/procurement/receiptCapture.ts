/**
 * Capturing a receipt, shared by the card that replaces one and the button on a
 * visit that starts a purchase with one. Both take the same photo the same way;
 * two copies of the compression settings would let them drift.
 */

/**
 * Longest edge after compression. Higher than a barcode needs: the tax line and
 * the part numbers are the point of the photo, and 1600px lost them on a long
 * receipt shot from arm's length.
 */
const MAX_EDGE = 2200;
const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.5] as const;

/** Server cap is 5MB; leave room for the multipart envelope and metadata. */
const MAX_BYTES = 4.5 * 1024 * 1024;

/** Two rounds of 0.8 scaling under the quality floor, then it goes up as-is. */
const RESCALE_FACTOR = 0.8;
const MAX_RESCALES = 2;

const HEIC_TYPES = ["image/heic", "image/heif", "image/heic-sequence"];

function isHeic(file: File) {
	return HEIC_TYPES.includes(file.type.toLowerCase()) || /\.hei[cf]$/i.test(file.name);
}

function toBlob(canvas: HTMLCanvasElement, quality: number) {
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function jpegName(name: string) {
	return name.replace(/\.[^.]+$/, "") + ".jpg";
}

/**
 * Compress before upload: a phone camera produces 4-8MB per shot, over the 5MB cap
 * and a minute of waiting on a rural connection. Quality drops before pixels do -
 * a soft 2200px receipt still reads where a crisp 1100px one does not.
 *
 * Falls back to the original bytes if encoding fails. HEIC is the exception: the
 * server and browser both refuse it, so failing to convert is fatal and says so
 * rather than dying at upload with a mime-type error.
 */
export async function compress(file: File): Promise<File> {
	if (!file.type.startsWith("image/") && !isHeic(file)) return file;
	const heic = isHeic(file);
	try {
		const bitmap = await createImageBitmap(file);
		let edge = MAX_EDGE;

		for (let attempt = 0; attempt <= MAX_RESCALES; attempt++) {
			const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(bitmap.width * scale);
			canvas.height = Math.round(bitmap.height * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) break;
			ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

			for (const quality of QUALITY_STEPS) {
				const blob = await toBlob(canvas, quality);
				if (!blob) break;
				if (blob.size <= MAX_BYTES) {
					// A gallery pick can already be smaller than anything re-encoding
					// produces — but only a JPEG-family original is safe to pass through.
					if (!heic && blob.size >= file.size) return file;
					return new File([blob], jpegName(file.name), {
						type: "image/jpeg",
					});
				}
			}
			edge = Math.round(edge * RESCALE_FACTOR);
		}
	} catch {
		// decode or encode failed — handled below
	}

	if (heic) {
		throw new Error(
			"That photo format could not be read on this device — take a new photo."
		);
	}
	return file;
}

/**
 * Best-effort and deliberately short-fused: geolocation is GPS-grade on a phone
 * but WiFi-grade or absent on a desktop, and it is advisory only, so waiting on
 * a permission prompt would stall a capture for nothing.
 */
export function readPosition(): Promise<GeolocationPosition | null> {
	if (!navigator.geolocation) return Promise.resolve(null);
	return new Promise((resolve) => {
		navigator.geolocation.getCurrentPosition(
			(pos) => resolve(pos),
			() => resolve(null),
			{ enableHighAccuracy: true, timeout: 5000, maximumAge: 60_000 }
		);
	});
}

/**
 * A still from the live preview. `takePhoto` is worth the try/catch: it returns the
 * sensor's full resolution where the preview track is whatever the browser
 * negotiated, and small print does not survive the difference. Absent on iOS Safari
 * and refused on some Android devices, so the frame grab is the floor.
 */
export async function grabFrame(
	video: HTMLVideoElement,
	track: MediaStreamTrack | null
): Promise<File> {
	const name = `receipt-${Date.now()}.jpg`;

	if (track && typeof window.ImageCapture === "function") {
		try {
			const blob = await new window.ImageCapture(track).takePhoto();
			if (blob.size > 0)
				return new File([blob], name, { type: blob.type || "image/jpeg" });
		} catch {
			// unsupported or device refused mid-stream — fall through to the frame grab
		}
	}

	const width = video.videoWidth;
	const height = video.videoHeight;
	if (!width || !height) throw new Error("The camera is not ready yet — try again.");

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Could not read the camera image.");
	ctx.drawImage(video, 0, 0, width, height);
	const blob = await toBlob(canvas, QUALITY_STEPS[0]);
	if (!blob) throw new Error("Could not read the camera image.");
	return new File([blob], name, { type: "image/jpeg" });
}

/** The upload payload for a photo just taken, ready for `uploadReceipt`. */
export async function captureFrom(file: File) {
	const [compressed, position] = await Promise.all([compress(file), readPosition()]);
	return {
		file: compressed,
		// The device clock at capture, which is what the trail records — distinct
		// from the date printed on the receipt.
		captured_at: new Date().toISOString(),
		capture_lat: position?.coords.latitude,
		capture_lng: position?.coords.longitude,
		capture_accuracy_m: position?.coords.accuracy,
	};
}
