import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The rear camera, with no opinion about what it is pointed at. Split out of
 * `useCameraScanner` so receipt capture and barcode scanning share one lifecycle -
 * including the teardown that has to run or the camera light stays on.
 */

export type CameraStreamStatus = "starting" | "live" | "error";

/**
 * A barcode needs a fast, small frame; a receipt needs the tax line to survive, so
 * 720p there is the difference between OCR reading it and a tech retyping it.
 */
export type CameraResolution = "scan" | "document";

const RESOLUTIONS: Record<CameraResolution, { width: number; height: number }> = {
	scan: { width: 1280, height: 720 },
	document: { width: 2560, height: 1440 },
};

export interface CameraZoomCaps {
	min: number;
	max: number;
	step: number;
}

interface UseCameraStreamOptions {
	resolution?: CameraResolution;
	/** Appended to every failure message, so each caller names its own way out. */
	fallbackHint?: string;
	/**
	 * False tears the stream down and holds it down. A preview that is off screen
	 * still holds the camera open — light on, battery draining — and the only
	 * honest way back is to let the effect re-run, which rebinds `srcObject`; an
	 * imperative stop cannot, which is why there isn't one.
	 */
	active?: boolean;
}

export interface UseCameraStreamResult {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	trackRef: React.RefObject<MediaStreamTrack | null>;
	status: CameraStreamStatus;
	errorMessage: string | null;
	zoomCaps: CameraZoomCaps | null;
	zoomLevel: number;
	setZoom: (level: number) => void;
	torchSupported: boolean;
	torchOn: boolean;
	setTorch: (on: boolean) => void;
	/** Also drops the stream, so a caller-side failure needs no separate stop(). */
	fail: (message: string) => void;
}

export function useCameraStream({
	resolution = "scan",
	fallbackHint = "",
	active = true,
}: UseCameraStreamOptions = {}): UseCameraStreamResult {
	const videoRef = useRef<HTMLVideoElement>(null);
	const trackRef = useRef<MediaStreamTrack | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const [status, setStatus] = useState<CameraStreamStatus>("starting");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [zoomCaps, setZoomCaps] = useState<CameraZoomCaps | null>(null);
	const [zoomLevel, setZoomLevel] = useState(1);
	const [torchSupported, setTorchSupported] = useState(false);
	const [torchOn, setTorchOn] = useState(false);

	const hintRef = useRef(fallbackHint);
	hintRef.current = fallbackHint;

	const dropStream = useCallback(() => {
		streamRef.current?.getTracks().forEach((t) => t.stop());
		streamRef.current = null;
		trackRef.current = null;
		if (videoRef.current) videoRef.current.srcObject = null;
	}, []);

	const fail = useCallback(
		(message: string) => {
			dropStream();
			setStatus("error");
			setErrorMessage(
				hintRef.current ? `${message} ${hintRef.current}` : message
			);
		},
		[dropStream]
	);

	const wanted = RESOLUTIONS[resolution];

	useEffect(() => {
		if (!active) {
			// Nothing to tear down here — the previous run's own cleanup did it when
			// this dep changed. Returning early is what keeps it down.
			setStatus("starting");
			return;
		}
		const videoEl = videoRef.current;
		let cancelled = false;
		let stream: MediaStream | null = null;

		const hint = hintRef.current;
		const withHint = (message: string) => (hint ? `${message} ${hint}` : message);
		const bail = (message: string) => {
			if (cancelled) return;
			setStatus("error");
			setErrorMessage(withHint(message));
		};

		const start = async () => {
			if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
				bail(
					window.isSecureContext
						? "Camera not supported on this device."
						: "Camera requires a secure (HTTPS) connection."
				);
				return;
			}

			try {
				stream = await navigator.mediaDevices.getUserMedia({
					video: {
						facingMode: { ideal: "environment" },
						width: { ideal: wanted.width },
						height: { ideal: wanted.height },
						focusMode: "continuous",
					},
				});
			} catch (e) {
				bail(
					e instanceof Error && e.name === "NotAllowedError"
						? "Camera permission denied."
						: "Could not start camera."
				);
				return;
			}

			if (cancelled) {
				stream.getTracks().forEach((t) => t.stop());
				return;
			}
			streamRef.current = stream;

			const track = stream.getVideoTracks()[0] ?? null;
			trackRef.current = track;
			if (track) {
				track.addEventListener("ended", () => {
					bail("Camera stopped.");
				});

				if ("getCapabilities" in track) {
					const caps = track.getCapabilities();
					if (caps.zoom) {
						setZoomCaps({
							min: caps.zoom.min,
							max: caps.zoom.max,
							step: caps.zoom.step,
						});
						setZoomLevel(
							track.getSettings().zoom ?? caps.zoom.min
						);
					}
					setTorchSupported(Boolean(caps.torch));
				}
			}

			const video = videoRef.current;
			if (!video) {
				bail("Could not start camera.");
				return;
			}
			video.srcObject = stream;
			try {
				await video.play();
			} catch (e) {
				if (e instanceof Error && e.name !== "AbortError") {
					bail("Could not start camera.");
					return;
				}
			}

			if (cancelled) return;
			setStatus("live");
		};

		start().catch(() => {
			stream?.getTracks().forEach((t) => t.stop());
			bail("Could not start camera.");
		});

		return () => {
			cancelled = true;
			stream?.getTracks().forEach((t) => t.stop());
			streamRef.current = null;
			trackRef.current = null;
			if (videoEl) videoEl.srcObject = null;
		};
	}, [wanted.width, wanted.height, active]);

	const setZoom = (level: number) => {
		const track = trackRef.current;
		if (!track || !zoomCaps) return;
		const clamped = Math.min(zoomCaps.max, Math.max(zoomCaps.min, level));
		setZoomLevel(clamped);
		track.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(() => {
			// constraint rejected by device — ignore, UI stays optimistic
		});
	};

	const setTorch = (on: boolean) => {
		const track = trackRef.current;
		if (!track || !torchSupported) return;
		track.applyConstraints({ advanced: [{ torch: on }] })
			.then(() => setTorchOn(on))
			.catch(() => {
				// torch constraint rejected — leave state unchanged
			});
	};

	return {
		videoRef,
		trackRef,
		status,
		errorMessage,
		zoomCaps,
		zoomLevel,
		setZoom,
		torchSupported,
		torchOn,
		setTorch,
		fail,
	};
}
