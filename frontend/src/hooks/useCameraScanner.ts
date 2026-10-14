import { useEffect, useRef, useState } from "react";
import { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { useCameraStream, type CameraZoomCaps } from "./useCameraStream";

// Self-hosted WASM — avoids a jsDelivr dependency on job sites with poor signal.
prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });

const SCAN_FORMATS = ["qr_code", "code_128", "code_39", "ean_13", "upc_a", "upc_e"] as const;
const DETECT_INTERVAL_MS = 100;
const SAME_CODE_COOLDOWN_MS = 2000;
const ANY_CODE_COOLDOWN_MS = 800;
const FOUND_RESET_MS = 1200;
const MANUAL_HINT = "Enter the code manually below.";

export type CameraScannerStatus = "starting" | "scanning" | "found" | "error";

export type CameraScannerZoomCaps = CameraZoomCaps;

interface UseCameraScannerOptions {
	onScan: (code: string) => void;
	continuous?: boolean;
}

interface UseCameraScannerResult {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	status: CameraScannerStatus;
	errorMessage: string | null;
	zoomCaps: CameraScannerZoomCaps | null;
	zoomLevel: number;
	setZoom: (level: number) => void;
	torchSupported: boolean;
	torchOn: boolean;
	setTorch: (on: boolean) => void;
}

export function useCameraScanner({
	onScan,
	continuous = false,
}: UseCameraScannerOptions): UseCameraScannerResult {
	const onScanRef = useRef(onScan);
	onScanRef.current = onScan;
	const continuousRef = useRef(continuous);
	continuousRef.current = continuous;

	const camera = useCameraStream({ resolution: "scan", fallbackHint: MANUAL_HINT });
	const { videoRef, status: cameraStatus, fail } = camera;
	const [found, setFound] = useState(false);

	useEffect(() => {
		if (cameraStatus !== "live") return;

		let cancelled = false;
		let intervalId: ReturnType<typeof setInterval> | null = null;
		let foundTimeout: ReturnType<typeof setTimeout> | null = null;
		let busy = false;
		let lastCode: string | null = null;
		let lastHitTime = 0;

		const handleHit = (rawValue: string) => {
			const now = performance.now();
			const gap = now - lastHitTime;
			if (rawValue === lastCode && gap < SAME_CODE_COOLDOWN_MS) return;
			if (gap < ANY_CODE_COOLDOWN_MS) return;
			lastCode = rawValue;
			lastHitTime = now;

			setFound(true);
			try {
				navigator.vibrate?.(80);
			} catch {
				// no-op — vibration unsupported (iOS Safari)
			}
			onScanRef.current(rawValue.trim());

			if (continuousRef.current) {
				if (foundTimeout) clearTimeout(foundTimeout);
				foundTimeout = setTimeout(() => {
					if (!cancelled) setFound(false);
				}, FOUND_RESET_MS);
			} else {
				if (intervalId) clearInterval(intervalId);
			}
		};

		let detector: BarcodeDetector;
		try {
			detector = new BarcodeDetector({ formats: [...SCAN_FORMATS] });
		} catch {
			// zxing WASM failed to load/instantiate — don't strand the spinner with a
			// live camera; surface the manual-entry fallback instead.
			fail("Scanner failed to load.");
			return;
		}

		intervalId = setInterval(async () => {
			if (busy || cancelled || !videoRef.current) return;
			busy = true;
			try {
				const codes = await detector.detect(videoRef.current);
				if (codes.length > 0 && !cancelled) {
					handleHit(codes[0].rawValue);
				}
			} catch {
				// frame not ready — normal during warmup, ignore
			} finally {
				busy = false;
			}
		}, DETECT_INTERVAL_MS);

		return () => {
			cancelled = true;
			if (intervalId) clearInterval(intervalId);
			if (foundTimeout) clearTimeout(foundTimeout);
		};
	}, [cameraStatus, fail, videoRef]);

	const status: CameraScannerStatus =
		cameraStatus === "error"
			? "error"
			: cameraStatus === "starting"
				? "starting"
				: found
					? "found"
					: "scanning";

	return {
		videoRef,
		status,
		errorMessage: camera.errorMessage,
		zoomCaps: camera.zoomCaps,
		zoomLevel: camera.zoomLevel,
		setZoom: camera.setZoom,
		torchSupported: camera.torchSupported,
		torchOn: camera.torchOn,
		setTorch: camera.setTorch,
	};
}
