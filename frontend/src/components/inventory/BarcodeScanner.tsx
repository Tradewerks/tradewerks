import { useEffect, useRef, useState } from "react";
import { X, Camera, Keyboard, Loader2, CircleCheck, Flashlight, FlashlightOff } from "lucide-react";
import { useCameraScanner } from "../../hooks/useCameraScanner";
import { usePinchZoom } from "../../hooks/usePinchZoom";

interface BarcodeScannerProps {
	onScan: (code: string) => void;
	onClose: () => void;
	continuous?: boolean;
}

export function BarcodeScanner({ onScan, onClose, continuous = false }: BarcodeScannerProps) {
	const [manualCode, setManualCode] = useState("");
	const closeButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		closeButtonRef.current?.focus();
	}, []);

	const handleScan = (code: string) => {
		onScan(code);
		if (!continuous) onClose();
	};

	const {
		videoRef,
		status,
		errorMessage,
		zoomCaps,
		zoomLevel,
		setZoom,
		torchSupported,
		torchOn,
		setTorch,
	} = useCameraScanner({ onScan: handleScan, continuous });

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	const { containerRef, zoomIndicator, pinchHint, pinchHandlers } = usePinchZoom({
		zoomCaps,
		zoomLevel,
		setZoom,
		enabled: status !== "error",
	});

	const handleManualSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = manualCode.trim();
		if (trimmed) handleScan(trimmed);
	};

	const caption =
		status === "starting"
			? "Starting camera…"
			: status === "scanning"
				? "Point camera at a barcode"
				: null;

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Scan barcode"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
		>
			<div className="bg-canvas border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
				<div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
					<span className="flex items-center gap-2 text-sm font-bold text-text-primary">
						<Camera size={16} className="text-primary" />
						Scan Barcode
					</span>
					<button
						ref={closeButtonRef}
						onClick={onClose}
						aria-label="Close scanner"
						className="text-text-faint hover:text-text-secondary transition-colors"
					>
						<X size={16} />
					</button>
				</div>

				<div
					ref={containerRef}
					{...pinchHandlers}
					className="relative bg-black aspect-square flex items-center justify-center touch-none overflow-hidden"
				>
					{status !== "error" ? (
						<>
							<video
								ref={videoRef}
								className="w-full h-full object-cover"
								muted
								playsInline
							/>

							<div
								className={`pointer-events-none absolute inset-8 rounded-lg border-2 transition-colors ${
									status === "found"
										? "border-success-border"
										: "border-primary/70"
								}`}
							>
								{status === "scanning" && (
									<div className="relative w-full h-full overflow-hidden rounded-lg">
										<div className="motion-safe:animate-[scanSweep_2s_ease-in-out_infinite] absolute left-0 right-0 h-0.5 bg-primary/60" />
									</div>
								)}
							</div>

							{status === "starting" && (
								<div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
									<Loader2
										size={28}
										className="text-text-faint motion-safe:animate-spin"
									/>
								</div>
							)}

							{status === "found" && (
								<div className="pointer-events-none absolute inset-0 flex items-center justify-center motion-safe:animate-[scanFoundFlash_200ms_ease-out]">
									<CircleCheck
										size={40}
										className="text-success-bright-text"
									/>
								</div>
							)}

							{zoomIndicator && (
								<div className="pointer-events-none absolute top-3 left-3 px-2 py-1 rounded-md bg-black/60 text-xs font-semibold text-white">
									{zoomIndicator}
								</div>
							)}

							{pinchHint && (
								<div className="pointer-events-none absolute top-3 left-3 right-3 px-2 py-1 rounded-md bg-black/60 text-center text-xs font-medium text-white">
									{pinchHint}
								</div>
							)}

							{torchSupported && (
								<button
									type="button"
									onClick={() =>
										setTorch(!torchOn)
									}
									className={`absolute bottom-3 right-3 w-11 h-11 flex items-center justify-center rounded-full bg-black/50 transition-colors ${
										torchOn
											? "text-primary"
											: "text-white"
									}`}
									aria-label={
										torchOn
											? "Turn torch off"
											: "Turn torch on"
									}
								>
									{torchOn ? (
										<FlashlightOff
											size={18}
										/>
									) : (
										<Flashlight
											size={18}
										/>
									)}
								</button>
							)}

							<div
								aria-live="polite"
								className="pointer-events-none absolute bottom-3 left-3 right-16 text-xs font-medium text-white/90 h-4"
							>
								{caption}
							</div>
						</>
					) : (
						<div className="px-6 py-10 text-center text-sm text-text-muted">
							{errorMessage}
						</div>
					)}
				</div>

				<form
					onSubmit={handleManualSubmit}
					className="flex items-center gap-2 px-5 py-3.5 border-t border-border flex-shrink-0"
				>
					<Keyboard
						size={14}
						className="text-text-faint flex-shrink-0"
					/>
					<input
						type="text"
						value={manualCode}
						onChange={(e) => setManualCode(e.target.value)}
						placeholder="Or type barcode manually…"
						aria-label="Barcode"
						className={`flex-1 text-sm bg-surface border rounded-md px-3 py-1.5 text-text-primary placeholder:text-faint outline-none focus:border-primary transition-colors ${
							status === "error"
								? "border-primary/40"
								: "border-border-input"
						}`}
					/>
					<button
						type="submit"
						disabled={!manualCode.trim()}
						className="px-3 py-1.5 text-xs font-semibold bg-primary text-on-primary rounded-md disabled:opacity-40 transition-colors"
					>
						Go
					</button>
				</form>
			</div>
		</div>
	);
}
