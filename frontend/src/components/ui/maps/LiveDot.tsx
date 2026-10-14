import type { CSSProperties } from "react";
import type { TechnicianStatus } from "../../../types/technicians";
import { useNow } from "../../../hooks/useNow";
import { formatPulseAge, isPingLive } from "../../../lib/livePulse";

interface LiveDotProps {
	status: TechnicianStatus;
	lastPingAt: string | null | undefined;
	/** Fill class for the dot, e.g. a TechnicianStatusDotColors entry. */
	dotClassName: string;
	/** Inline fill override (route color); wins over dotClassName. */
	style?: CSSProperties;
	/** Size classes for the dot; the ring matches it. */
	sizeClassName?: string;
}

/**
 * Status dot that pulses while the tech's device is pinging. Lists only — never on
 * the map itself. Re-checks liveness every 10s so a dot goes still once pings stop.
 */
export default function LiveDot({
	status,
	lastPingAt,
	dotClassName,
	style,
	sizeClassName = "h-2 w-2",
}: LiveDotProps) {
	const now = useNow(10_000);
	const live = isPingLive(status, lastPingAt, now);
	const age = formatPulseAge(lastPingAt, now);
	const title = live
		? `Live · last ping ${age}`
		: age
			? `Last ping ${age}`
			: "No location pings yet";

	return (
		<span title={title} className={`relative inline-flex flex-shrink-0 ${sizeClassName}`}>
			{live && (
				<span
					aria-hidden="true"
					className={`absolute inset-0 rounded-full motion-safe:animate-[livePulse_2s_ease-out_infinite] motion-reduce:scale-[1.9] motion-reduce:opacity-30 ${dotClassName}`}
					style={style}
				/>
			)}
			<span
				aria-hidden="true"
				className={`relative rounded-full ${sizeClassName} ${dotClassName}`}
				style={style}
			/>
			{live && <span className="sr-only">, live</span>}
		</span>
	);
}
