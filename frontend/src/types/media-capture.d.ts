// lib.dom in TS 5.9 doesn't type torch/zoom/focusMode — Chromium supports them via MediaTrackConstraintSet.
export {};

declare global {
	interface MediaTrackCapabilities {
		torch?: boolean;
		zoom?: { min: number; max: number; step: number };
	}

	interface MediaTrackConstraintSet {
		torch?: boolean;
		zoom?: number;
		focusMode?: string;
	}

	interface MediaTrackSettings {
		torch?: boolean;
		zoom?: number;
	}

	// Chromium-only, and read off `window` so the absence on iOS Safari is a
	// runtime branch rather than a crash.
	interface ImageCapture {
		takePhoto(photoSettings?: Record<string, unknown>): Promise<Blob>;
		grabFrame(): Promise<ImageBitmap>;
	}

	interface Window {
		ImageCapture?: {
			prototype: ImageCapture;
			new (track: MediaStreamTrack): ImageCapture;
		};
	}
}
