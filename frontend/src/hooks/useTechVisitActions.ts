import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
	useClockInMutation,
	useClockOutMutation,
	useVisitTransitionMutation,
	useCompleteJobVisitMutation,
} from "./useJobs";
import { useGoAvailableMutation, useMarkDoneMutation, useTechnicianByIdQuery } from "./useTechnicians";
import type { JobVisit, VisitTechTimeEntry, VisitStatus } from "../types/jobs";
import { getActionConstraints, type VisitActionConstraints } from "../lib/visitActionConstraints";
import { useTechnicianStatus } from "./useTechnicianStatus";
import type { TechnicianStatus } from "../types/technicians";
import { getDeviceCoords } from "../lib/geolocation";

export type TechVisitUiState =
	| "idle"
	| "pause-warning"
	| "pause-reason"
	| "force-complete"
	| "prompt-complete"
	| "paused-info"
	| "switch-confirm"
	| "departure-prompt";

export type TechVisitConfirmingAction = "drive" | "arrive" | "complete" | null;

export interface UseTechVisitActionsReturn {
	isClockedIn: boolean;
	myOpenEntry: VisitTechTimeEntry | undefined;
	openEntries: VisitTechTimeEntry[];
	uiState: TechVisitUiState;
	confirmingAction: TechVisitConfirmingAction;
	isLoading: boolean;
	clockError: string | null;
	myTechVisitStatus: string;
	pendingPauseAction: "clock-out" | "pause" | null;
	handleDrive: () => Promise<void>;
	handleArrive: () => Promise<void>;
	handleClockIn: () => Promise<void>;
	handleClockOut: () => Promise<void>;
	handlePause: () => void;
	handleConfirmPause: () => Promise<void>;
	handleComplete: () => void;
	handleConfirmComplete: () => Promise<void>;
	handleDeclineComplete: () => void;
	handleReasonSelected: (reason: string) => Promise<void>;
	handleHeadingOut: () => Promise<void>;
	handleAvailable: () => Promise<void>;
	dismiss: () => void;
	constraints: VisitActionConstraints;
	handleConfirmSwitch: () => Promise<void>;
	optimisticStatus: string | null; 
}

const CONFIRM_TIMEOUT_MS = 4000;

export function useTechVisitActions(
	visit: JobVisit | undefined,
	techId: string,
): UseTechVisitActionsReturn {
	const [uiState, setUiState] = useState<TechVisitUiState>("idle");
	const [confirmingAction, setConfirmingAction] = useState<TechVisitConfirmingAction>(null);
	const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
	const [clockError, setClockError] = useState<string | null>(null);
	const [pendingPauseAction, setPendingPauseAction] = useState<"clock-out" | "pause" | null>(null);
	const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clockInMutation = useClockInMutation();
	const clockOutMutation = useClockOutMutation();
	const transitionMutation = useVisitTransitionMutation();
	const completeMutation = useCompleteJobVisitMutation();
	const goAvailableMutation = useGoAvailableMutation();
	const markDoneMutation = useMarkDoneMutation();
	const { data: technician } = useTechnicianByIdQuery(techId);

	const visitId = visit?.id ?? "";

	const myTechVisitStatus = optimisticStatus ?? 
		visit?.visit_techs?.find((vt) => vt.tech_id === techId)?.tech_status ?? "Assigned";

	const myOpenEntry = visit?.time_entries?.find(
		(e) => e.tech_id === techId && e.clocked_out_at === null,
	);
	const isClockedIn = myOpenEntry != null;
	const techStatus = useTechnicianStatus(techId);
	const constraints = getActionConstraints(
		{ id: visitId, status: (visit?.status ?? "Scheduled") as VisitStatus },
		techStatus,
		myTechVisitStatus,
	);
	const openEntries: VisitTechTimeEntry[] = useMemo(
		() => visit?.time_entries?.filter((e) => e.clocked_out_at === null) ?? [],
		[visit?.time_entries],
	);

	const isLoading =
		clockInMutation.isPending ||
		clockOutMutation.isPending ||
		transitionMutation.isPending ||
		completeMutation.isPending ||
		goAvailableMutation.isPending ||
		markDoneMutation.isPending;

	// Reset on status change — another tech may have advanced the visit
	useEffect(() => {
		setConfirmingAction(null);
		setUiState("idle");
		setClockError(null);
	}, [visit?.status]);

	const clearConfirmTimer = useCallback(() => {
		if (confirmTimerRef.current) {
			clearTimeout(confirmTimerRef.current);
			confirmTimerRef.current = null;
		}
	}, []);

	const startConfirmTimer = useCallback(() => {
		clearConfirmTimer();
		confirmTimerRef.current = setTimeout(() => {
			setConfirmingAction(null);
		}, CONFIRM_TIMEOUT_MS);
	}, [clearConfirmTimer]);

	const dismiss = useCallback(() => {
		setUiState("idle");
		setConfirmingAction(null);
		setClockError(null);
		setPendingPauseAction(null);
		clearConfirmTimer();
	}, [clearConfirmTimer]);

	const handleDrive = useCallback(async () => {
		if (isLoading || !visitId) return;
		if (constraints.drive.requiresSwitchConfirm) {
			setUiState("switch-confirm");
			return;
		}
		if (confirmingAction !== "drive") {
			setConfirmingAction("drive");
			startConfirmTimer();
			return;
		}
		setOptimisticStatus("EnRoute");
		clearConfirmTimer();
		setConfirmingAction(null);
		setClockError(null);
		try {
			const techCoords = await getDeviceCoords();
			await transitionMutation.mutateAsync({ visitId, action: "drive", techCoords: techCoords ?? undefined });
			setOptimisticStatus(null);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.includes("CLOCKED_IN")) {
				setClockError("Clock out of your current job first.");
			} else {
				setClockError("Failed to update status — try again.");
			}
			setOptimisticStatus(null);
		}
	}, [isLoading, constraints.drive.requiresSwitchConfirm, confirmingAction, visitId, transitionMutation, startConfirmTimer, clearConfirmTimer]);

	const handleConfirmSwitch = useCallback(async () => {
		if (!visitId) return;
		if (techStatus.isClockedIn) {
			setClockError("Clock out of your current job first.");
			setUiState("idle");
			return;
		}
		try {
			const techCoords = await getDeviceCoords();
			await transitionMutation.mutateAsync({ visitId, action: "drive", techCoords: techCoords ?? undefined });
			setUiState("idle");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "";
			setClockError(msg.includes("CLOCKED_IN") ? "Clock out of your current job first." : "Failed to update status — try again.");
			setUiState("idle");
		}
	}, [visitId, techStatus.isClockedIn, transitionMutation]);

	const handleArrive = useCallback(async () => {
		if (isLoading || !visitId) return;
		if (confirmingAction !== "arrive") {
			setConfirmingAction("arrive");
			startConfirmTimer();
			return;
		}
		clearConfirmTimer();
		setConfirmingAction(null);
		setClockError(null);
		try {
			await transitionMutation.mutateAsync({ visitId, action: "arrive" });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.includes("CLOCKED_IN")) {
				setClockError("Clock out of your current job first.");
			} else {
				setClockError("Failed to update status — try again.");
			}
		}
	}, [isLoading, confirmingAction, visitId, transitionMutation, startConfirmTimer, clearConfirmTimer]);

	const handleClockIn = useCallback(async () => {
		if (!visitId) return;
		setClockError(null);
		try {
			await clockInMutation.mutateAsync({ visitId, techId });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "";
			if (msg.startsWith("ALREADY_CLOCKED_IN:")) {
				setClockError("You're already clocked in to another visit — clock out there first.");
			} else if (msg.startsWith("TIMESHEET_LOCKED")) {
				setClockError(msg.replace(/^TIMESHEET_LOCKED: /, ""));
			} else {
				setClockError("Failed to clock in — try again.");
			}
		}
	}, [visitId, techId, clockInMutation]);

	const handleClockOut = useCallback(async () => {
		if (!visitId) return;
		setClockError(null);
		const willBeLastTech = openEntries.length === 1 && openEntries[0].tech_id === techId;
		if (willBeLastTech) {
			setPendingPauseAction("clock-out");
			setUiState("pause-reason");
			return;
		}
		try {
			await clockOutMutation.mutateAsync({ visitId, techId });
			setUiState("departure-prompt");
		} catch {
			setClockError("Failed to clock out — try again.");
		}
	}, [visitId, techId, openEntries, clockOutMutation]);

	const handlePause = useCallback(() => {
		if (!visitId) return;
		const othersClocked = openEntries.filter((e) => e.tech_id !== techId);
		if (othersClocked.length > 0) {
			setUiState("pause-warning");
			return;
		}
		// No others clocked in — collect reason before pausing
		setPendingPauseAction("pause");
		setUiState("pause-reason");
	}, [openEntries, techId, visitId]);

	const handleConfirmPause = useCallback(async () => {
		if (!visitId) return;
		// Reached from pause-warning (others clocked in) — collect reason then pause
		setPendingPauseAction("pause");
		setUiState("pause-reason");
	}, [visitId]);

	const handleReasonSelected = useCallback(async (reason: string) => {
		if (!visitId) return;
		try {
			if (pendingPauseAction === "pause") {
				await transitionMutation.mutateAsync({ visitId, action: "pause", pauseReason: reason });
				setUiState("idle");
			} else if (pendingPauseAction === "clock-out") {
				// Clock-out with reason — backend stores it on the auto-pause triggered by last tech out
				const result = await clockOutMutation.mutateAsync({ visitId, techId, pauseReason: reason });
				setUiState(result.is_last_tech ? "paused-info" : "departure-prompt");
			}
			setPendingPauseAction(null);
		} catch {
			setUiState("idle");
			setPendingPauseAction(null);
		}
	}, [visitId, techId, pendingPauseAction, transitionMutation, clockOutMutation]);

	const handleComplete = useCallback(() => {
		if (isLoading || !visitId) return;
		if (confirmingAction !== "complete") {
			setConfirmingAction("complete");
			startConfirmTimer();
			return;
		}
		clearConfirmTimer();
		setConfirmingAction(null);
		if (openEntries.filter((e) => e.tech_id !== techId).length > 0) {
			setUiState("force-complete");
			return;
		}
		completeMutation.mutate(visitId);
	}, [isLoading, confirmingAction, openEntries, visitId, completeMutation, startConfirmTimer, clearConfirmTimer]);

	const handleConfirmComplete = useCallback(async () => {
		if (!visitId) return;
		try {
			await completeMutation.mutateAsync(visitId);
		} catch {
			// ignore — visit status update will come via query invalidation
		}
		setUiState("idle");
		setPendingPauseAction(null);
	}, [visitId, completeMutation]);

	const handleDeclineComplete = useCallback(() => {
		if (pendingPauseAction === "clock-out") {
			setUiState("pause-reason");
		} else {
			setUiState("paused-info");
		}
	}, [pendingPauseAction]);

	const handleHeadingOut = useCallback(async () => {
		if (!techId) return;
		try {
			await goAvailableMutation.mutateAsync(techId);
		} catch {
			// Silently fail — tech's status will sync on next ping
		}
		setUiState("idle");
	}, [techId, goAvailableMutation]);

	const handleAvailable = useCallback(async () => {
		if (!techId) return;
		const globalStatus: TechnicianStatus | undefined = technician?.status;
		try {
			if (globalStatus === "WrappingUp") {
				await markDoneMutation.mutateAsync(techId);
			} else {
				await goAvailableMutation.mutateAsync(techId);
			}
		} catch {
			// ignore
		}
		setUiState("idle");
	}, [techId, technician?.status, markDoneMutation, goAvailableMutation]);

	return {
		isClockedIn,
		myOpenEntry,
		openEntries,
		uiState,
		confirmingAction,
		isLoading,
		clockError,
		myTechVisitStatus,
		pendingPauseAction,
		handleDrive,
		handleArrive,
		handleClockIn,
		handleClockOut,
		handlePause,
		handleConfirmPause,
		handleComplete,
		handleConfirmComplete,
		handleDeclineComplete,
		handleReasonSelected,
		handleHeadingOut,
		handleAvailable,
		dismiss,
		constraints,
		handleConfirmSwitch,
		optimisticStatus,
	};
}
