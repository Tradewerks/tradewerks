import { describe, expect, it } from "vitest";
import { formatChange } from "../changeFormat";
import type { ActivityLog } from "../../../types/logs";

const log = (event_type: string, action: string, changes: ActivityLog["changes"]): ActivityLog => ({
	id: "l1",
	event_type,
	action,
	entity_type: "technician_shift",
	entity_id: "s1",
	actor_type: "technician",
	actor_id: "t1",
	actor_name: "Kevin Park",
	changes,
	timestamp: "2026-10-15T20:00:00.000Z",
	ip_address: null,
	user_agent: null,
	reason: null,
	organization_id: null,
});

const crumbs = { _day: { old: null, new: "Oct 15" }, _note: { old: null, new: "Left at 1:30" } };

describe("timesheet change formatting", () => {
	it("labels break and visit rows and puts day and note in the subtitle", () => {
		const entry = formatChange(
			log("timesheet.issue_reported", "reported", {
				"break.b1.started_at": { old: "2026-10-15T17:00:00.000Z", new: "2026-10-15T17:15:00.000Z" },
				"entry.e1.clocked_out_at": { old: "2026-10-15T18:00:00.000Z", new: "2026-10-15T18:30:00.000Z" },
				...crumbs,
			}),
			"America/Chicago",
		);
		expect(entry.headline).toBe("Time correction suggested");
		expect(entry.rows.map((r) => r.label)).toEqual(["Break start", "Visit clock-out"]);
		expect(entry.subtitle).toBe('Oct 15 · "Left at 1:30"');
	});

	it("names a message-only report and an approval", () => {
		expect(formatChange(log("timesheet.issue_reported", "reported", crumbs), "UTC").headline).toBe("Time issue reported");
		const approved = formatChange(log("timesheet.created", "approved", { _parent_id: { old: null, new: "t:2026-10-12" } }), "UTC");
		expect(approved.headline).toBe("Week approved");
		expect(approved.rows).toEqual([]);
	});
});
