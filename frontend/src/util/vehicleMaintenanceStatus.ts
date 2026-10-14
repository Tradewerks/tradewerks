import type { VehicleMaintenanceRecord, VehicleMaintenanceReminder } from "../types/vehicles";
import { formatDateOnly, addInterval, daysUntil } from "./util";

export function latestOf(records: VehicleMaintenanceRecord[]): VehicleMaintenanceRecord | undefined {
	return [...records].sort((a, b) => b.performed_at.localeCompare(a.performed_at) || b.created_at.localeCompare(a.created_at))[0];
}

export type ReminderStatus = "overdue" | "duesoon" | "upcoming" | "none";

export const STATUS_LABEL: Record<Exclude<ReminderStatus, "none">, string> = {
	overdue: "Overdue",
	duesoon: "Due soon",
	upcoming: "Upcoming",
};

export const STATUS_CLASSNAME: Record<Exclude<ReminderStatus, "none">, string> = {
	overdue: "bg-error/15 text-error-text",
	duesoon: "bg-warning/15 text-warning-text",
	upcoming: "bg-surface-raised text-text-muted",
};

export const STATUS_RANK: Record<ReminderStatus, number> = { overdue: 0, duesoon: 1, upcoming: 2, none: 3 };

// No agreed threshold yet — 7 days / 500 mi is a first cut, easy to tune later.
export const DUE_SOON_DAYS = 7;
export const DUE_SOON_MILES = 500;

export interface ReminderDue {
	status: ReminderStatus;
	dueLines: string[];
	urgency: number;
}

// Repeating reminders compute their due date from baseline_* (moved when a record covers them) + interval.
export function dueFor(
	reminder: VehicleMaintenanceReminder,
	currentOdometerMi: number | null,
): ReminderDue {
	if (!reminder.repeats && reminder.completed_at != null) {
		return { status: "none", dueLines: ["Completed"], urgency: Infinity };
	}

	let dueDate: string | null = null;
	let dueMiles: number | null = null;

	if (reminder.repeats) {
		const anchorAt = reminder.baseline_at;
		const anchorOdometerMi = reminder.baseline_odometer_mi;

		if (anchorOdometerMi != null && reminder.interval_miles != null) {
			dueMiles = anchorOdometerMi + reminder.interval_miles;
		}
		if (anchorAt != null && reminder.interval_unit != null && reminder.interval_count != null) {
			dueDate = addInterval(anchorAt, reminder.interval_unit, reminder.interval_count);
		}
	} else {
		dueDate = reminder.due_at;
		dueMiles = reminder.due_odometer_mi;
	}

	const daysLeft = dueDate != null ? daysUntil(dueDate) : null;
	const milesLeft = dueMiles != null && currentOdometerMi != null ? dueMiles - currentOdometerMi : null;

	if (daysLeft == null && milesLeft == null) {
		return {
			status: "none",
			dueLines: [reminder.repeats ? "No service logged yet" : "—"],
			urgency: Infinity,
		};
	}

	const urgency = Math.min(daysLeft ?? Infinity, milesLeft ?? Infinity);
	const status: ReminderStatus =
		urgency < 0 ? "overdue"
		: (daysLeft != null && daysLeft <= DUE_SOON_DAYS) || (milesLeft != null && milesLeft <= DUE_SOON_MILES) ? "duesoon"
		: "upcoming";

	const parts: string[] = [];
	if (dueDate != null) parts.push(daysLeft! < 0 ? `was due ${formatDateOnly(dueDate)}` : `due ${formatDateOnly(dueDate)}`);
	if (dueMiles != null) {
		parts.push(
			milesLeft != null
				? `${dueMiles.toLocaleString()} mi (${milesLeft < 0 ? "past" : `${milesLeft.toLocaleString()} left`})`
				: `${dueMiles.toLocaleString()} mi`
		);
	}
	return { status, dueLines: parts, urgency };
}

export function scheduleText(reminder: VehicleMaintenanceReminder): string {
	if (!reminder.repeats) return "one-time";
	const parts: string[] = [];
	if (reminder.interval_miles != null) parts.push(`every ${reminder.interval_miles.toLocaleString()} mi`);
	if (reminder.interval_unit != null && reminder.interval_count != null) {
		const unit = reminder.interval_count === 1 ? reminder.interval_unit.slice(0, -1) : reminder.interval_unit;
		parts.push(`every ${reminder.interval_count} ${unit}`);
	}
	return parts.join(" or ") || "repeating";
}
