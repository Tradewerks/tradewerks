import { useEffect, useState } from "react";

// Drives the landing page's interactive visit: the phone in the hero and the
// Johnson row on the dispatch board both read from this one state, so tapping
// through the phone visibly moves the board — the same thing the real app does
// over the socket.

export type VisitStatus = "Driving" | "OnSite" | "InProgress" | "Paused" | "Completed";
export type BoardStatus = VisitStatus | "Scheduled" | "Delayed" | "Unassigned";
export type PauseReason = "Awaiting Materials" | "Equipment Issue" | "Other";

export type StepState = "current" | "done" | "upcoming";

export const PAUSE_REASONS: PauseReason[] = ["Awaiting Materials", "Equipment Issue", "Other"];

export const STATUS_PILLS: Record<BoardStatus, { label: string; className: string }> = {
	Scheduled: { label: "Scheduled", className: "bg-paper-2 text-ink-2" },
	Driving: { label: "Driving", className: "bg-ink text-paper" },
	OnSite: {
		label: "On Site",
		className: "bg-white text-brand-deep ring-[1.5px] ring-inset ring-brand",
	},
	InProgress: { label: "In Progress", className: "bg-brand text-white" },
	Paused: { label: "Paused", className: "bg-amber-tint text-amber-ink" },
	Delayed: { label: "Delayed", className: "bg-red-tint text-red-ink" },
	Completed: { label: "Completed", className: "bg-brand-tint text-brand-deep" },
	Unassigned: { label: "Unassigned", className: "bg-amber-tint text-amber-ink" },
};

// Paused is a detour off InProgress, not its own step.
const STEPS: VisitStatus[] = ["Driving", "OnSite", "InProgress", "Completed"];

interface DemoState {
	status: VisitStatus;
	/** The primary button asks once before Arrived and Complete, like the real app. */
	confirming: boolean;
	pauseSheetOpen: boolean;
	pauseReason: PauseReason | null;
	/** When the current clocked-in stretch began. */
	startedAt: number;
	/** Clocked time from earlier stretches (before a pause). */
	workedMs: number;
}

const INITIAL: DemoState = {
	status: "Driving",
	confirming: false,
	pauseSheetOpen: false,
	pauseReason: null,
	startedAt: 0,
	workedMs: 0,
};

function formatElapsed(ms: number) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** The visit's clocked time, ticking each second while in progress. Kept out of
 *  useVisitDemo so the tick re-renders only the component showing the clock. */
export function useElapsed({ status, startedAt, workedMs }: VisitDemo) {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (status !== "InProgress") return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [status]);

	return formatElapsed(
		status === "InProgress" ? workedMs + Math.max(0, now - startedAt) : workedMs
	);
}

export function useVisitDemo() {
	const [state, setState] = useState<DemoState>(INITIAL);

	const advance = () => {
		const t = Date.now();
		setState((st) => {
			switch (st.status) {
				case "Driving":
					return st.confirming
						? { ...st, status: "OnSite", confirming: false }
						: { ...st, confirming: true };
				case "OnSite":
				case "Paused":
					return { ...st, status: "InProgress", startedAt: t };
				case "InProgress":
					return st.confirming
						? {
								...st,
								status: "Completed",
								confirming: false,
								workedMs:
									st.workedMs +
									(t - st.startedAt),
							}
						: { ...st, confirming: true };
				case "Completed":
					return INITIAL;
			}
		});
	};

	const pause = (reason: PauseReason) =>
		setState((st) => ({
			...st,
			status: "Paused",
			pauseSheetOpen: false,
			confirming: false,
			pauseReason: reason,
			workedMs: st.workedMs + (Date.now() - st.startedAt),
		}));

	const { status, confirming } = state;

	const primaryLabel: Record<VisitStatus, string> = {
		Driving: confirming ? "Confirm Arrived" : "I've Arrived",
		OnSite: "Clock In & Begin",
		Paused: "Clock In & Resume",
		InProgress: confirming ? "Confirm Complete" : "Complete",
		Completed: "I'm Available",
	};

	const current = STEPS.indexOf(status === "Paused" ? "InProgress" : status);
	const steps = STEPS.map((step, i) => ({
		label:
			step === "InProgress" && status === "Paused"
				? "Paused"
				: STATUS_PILLS[step].label,
		state: (i === current ? "current" : i < current ? "done" : "upcoming") as StepState,
	}));

	return {
		status,
		steps,
		pauseSheetOpen: state.pauseSheetOpen,
		pauseReason: state.pauseReason,
		startedAt: state.startedAt,
		workedMs: state.workedMs,
		/** Only read once Completed, when workedMs holds the whole visit. */
		laborMinutes: Math.max(1, Math.round(state.workedMs / 60000)),
		primaryLabel: primaryLabel[status],
		advance,
		pause,
		openPauseSheet: () =>
			setState((st) => ({ ...st, pauseSheetOpen: true, confirming: false })),
		closePauseSheet: () => setState((st) => ({ ...st, pauseSheetOpen: false })),
		reset: () => setState(INITIAL),
	};
}

export type VisitDemo = ReturnType<typeof useVisitDemo>;
