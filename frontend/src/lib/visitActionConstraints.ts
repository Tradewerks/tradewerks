import type { VisitStatus } from "../types/jobs";

export type TechnicianStatus = {
	isClockedIn: boolean;
	clockedInVisitId: string | null;
	isDriving: boolean;
	drivingVisitId: string | null;
};

const DISABLED_REASON = "visit.clockOutFirst";
export type ActionConstraint = { enabled: boolean; reason: typeof DISABLED_REASON | null };

export type VisitActionConstraints = {
	drive: ActionConstraint & { requiresSwitchConfirm: boolean };
	arrive: ActionConstraint;
	clockIn: ActionConstraint;
};

const ACTIVE_VISIT_STATUSES: VisitStatus[] = [
	"Scheduled", "Delayed", "Driving", "OnSite", "InProgress", "Paused",
];

export function getActionConstraints(
	visit: { id: string; status: VisitStatus },
	techStatus: TechnicianStatus,
	myTechVisitStatus: string = "Assigned",
): VisitActionConstraints {
	const visitIsActive = (ACTIVE_VISIT_STATUSES as string[]).includes(visit.status);

	const driveEnabled =
		myTechVisitStatus === "Assigned" &&
		!techStatus.isClockedIn &&
		visitIsActive &&
		!["Completed", "Cancelled"].includes(visit.status);

	const requiresSwitchConfirm =
		driveEnabled &&
		techStatus.isDriving &&
		techStatus.drivingVisitId !== visit.id;

	const arriveEnabled =
		myTechVisitStatus === "EnRoute" &&
		!techStatus.isClockedIn &&
		!["Completed", "Cancelled"].includes(visit.status);

	const clockInEnabled =
		myTechVisitStatus === "OnSite" &&
		!techStatus.isClockedIn &&
		(visit.status === "OnSite" || visit.status === "InProgress" || visit.status === "Paused");

	return {
		drive: {
			enabled: driveEnabled,
			reason: !driveEnabled && techStatus.isClockedIn ? DISABLED_REASON : null,
			requiresSwitchConfirm,
		},
		arrive: {
			enabled: arriveEnabled,
			reason: !arriveEnabled && techStatus.isClockedIn ? DISABLED_REASON : null,
		},
		clockIn: {
			enabled: clockInEnabled,
			reason: !clockInEnabled && techStatus.isClockedIn ? DISABLED_REASON : null,
		},
	};
}
