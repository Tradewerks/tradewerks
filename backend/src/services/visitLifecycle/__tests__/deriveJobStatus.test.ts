import { describe, it, expect } from "vitest";
import type {
	visit_status,
	job_status,
} from "../../../../generated/prisma/client.js";
import { deriveJobStatus } from "../deriveJobStatus.js";

const at = new Date("2026-11-18T00:00:00Z");

describe("deriveJobStatus", () => {
	it.each<[visit_status[], Date | null, job_status]>([
		[[], null, "Unscheduled"],
		[[], at, "Cancelled"],
		[["Completed", "Cancelled"], null, "Completed"],
		[["Cancelled", "Cancelled"], null, "Cancelled"],
		[["Completed", "Scheduled"], null, "InProgress"],
		[["Scheduled", "Delayed"], null, "InProgress"],
		[["Scheduled"], null, "Scheduled"],
		[["Scheduled", "Cancelled"], null, "Scheduled"],
		[["Driving"], null, "InProgress"],
		[["Completed"], null, "Completed"],
		[["Completed"], at, "Cancelled"],
		[["Completed", "Scheduled"], at, "InProgress"],
		[["Scheduled"], at, "Scheduled"],
		[["Paused", "Completed"], at, "InProgress"],
	])("%j (cancelled_at=%s) → %s", (statuses, cancelled_at, expected) => {
		expect(
			deriveJobStatus(
				statuses.map((status) => ({ status })),
				{ cancelled_at },
			),
		).toBe(expected);
	});
});
