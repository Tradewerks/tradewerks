import { describe, expect, test } from "vitest";
import {
	buildRecordMapModel,
	focusAssignment,
	isTechActiveOn,
	ORG_MARKER_ID,
	SITE_MARKER_ID,
	type RecordMapInput,
} from "../recordMap";
import type { Technician } from "../../types/technicians";
import type { TechRouteData } from "../../types/location";

function tech(
	id: string,
	name: string,
	assignments: Array<[visitId: string, techStatus: string]>,
	coords: { lat: number; lon: number } | null = { lat: 43.8, lon: -91.2 },
): Technician {
	return {
		id,
		name,
		coords,
		status: "Available",
		visit_techs: assignments.map(([visit_id, tech_status]) => ({
			visit_id,
			tech_id: id,
			tech_status,
			visit: { id: visit_id },
		})),
	} as unknown as Technician;
}

function route(techId: string, visitId: string): TechRouteData {
	return {
		techId,
		techName: techId,
		visitId,
		jobId: "j1",
		color: "var(--color-tech-1)",
		current: { lat: 43.85, lon: -91.25 },
		destination: { lat: 43.9, lon: -91.3 },
		destinationLabel: "Client",
		routeGeoJSON: null,
		etaSeconds: 300,
		distanceMeters: 3218,
	};
}

function input(over: Partial<RecordMapInput> = {}): RecordMapInput {
	return {
		technicians: [],
		routes: [],
		site: { coords: { lat: 43.9, lon: -91.3 }, label: "Acme" },
		org: { coords: { lat: 44.5, lon: -90.1 }, name: "HQ" },
		techIds: new Set(),
		focusVisitIds: new Set(["v1"]),
		hideTechs: false,
		...over,
	};
}

describe("buildRecordMapModel — site and office", () => {
	test("site frames the view; office is drawn but fit-ignored", () => {
		const m = buildRecordMapModel(input());
		const site = m.markers.find((x) => x.id === SITE_MARKER_ID)!;
		const org = m.markers.find((x) => x.id === ORG_MARKER_ID)!;
		expect(site).toMatchObject({ type: "SITE", label: "Acme" });
		expect(site.fitIgnore).toBeUndefined();
		expect(org).toMatchObject({ type: "WAREHOUSE", label: "HQ", fitIgnore: true });
		expect(m.orgCoords).toEqual({ lat: 44.5, lon: -90.1 });
	});

	test("org still loading is not reported missing", () => {
		const m = buildRecordMapModel(input({ org: null }));
		expect(m.orgMissing).toBe(false);
		expect(m.markers.some((x) => x.id === ORG_MARKER_ID)).toBe(false);
	});

	test("org without an address is missing", () => {
		const m = buildRecordMapModel(input({ org: { coords: null, name: "HQ" } }));
		expect(m.orgMissing).toBe(true);
		expect(m.markers.some((x) => x.id === ORG_MARKER_ID)).toBe(false);
	});

	test("site without coords is missing", () => {
		const m = buildRecordMapModel(input({ site: { coords: null, label: "Acme" } }));
		expect(m.siteMissing).toBe(true);
		expect(m.markers.some((x) => x.id === SITE_MARKER_ID)).toBe(false);
	});
});

describe("buildRecordMapModel — technicians", () => {
	test("driving to this visit: route drawn, ETA in label, frames the view, active", () => {
		const ana = tech("t1", "Ana", [["v1", "EnRoute"]]);
		const m = buildRecordMapModel(
			input({ technicians: [ana], routes: [route("t1", "v1")], techIds: new Set(["t1"]) }),
		);
		expect(m.routes.map((r) => r.techId)).toEqual(["t1"]);
		const marker = m.markers.find((x) => x.id === "tech-t1")!;
		expect(marker.label).toBe("Ana · ~5m");
		expect(marker.fitIgnore).toBeUndefined();
		expect(m.techRows[0]).toMatchObject({
			activeHere: true,
			drivingElsewhere: false,
			etaSeconds: 300,
			visitId: "v1",
			visitTechStatus: "EnRoute",
		});
		expect(m.activeCount).toBe(1);
	});

	test("driving to another visit: no line, dimmed 'En route elsewhere', fit-ignored", () => {
		const ana = tech("t1", "Ana", [["v1", "Assigned"]]);
		const m = buildRecordMapModel(
			input({ technicians: [ana], routes: [route("t1", "v9")], techIds: new Set(["t1"]) }),
		);
		expect(m.routes).toEqual([]);
		const marker = m.markers.find((x) => x.id === "tech-t1")!;
		expect(marker).toMatchObject({
			label: "Ana · En route elsewhere",
			variant: "dimmed",
			fitIgnore: true,
		});
		expect(m.techRows[0]).toMatchObject({
			drivingElsewhere: true,
			activeHere: false,
			etaSeconds: null,
		});
	});

	test("an idle assigned tech is drawn but does not frame the view", () => {
		const ana = tech("t1", "Ana", [["v1", "Assigned"]]);
		const m = buildRecordMapModel(input({ technicians: [ana], techIds: new Set(["t1"]) }));
		expect(m.markers.find((x) => x.id === "tech-t1")!.fitIgnore).toBe(true);
		expect(m.activeCount).toBe(0);
	});

	test("a tech that never reported a location is listed without a marker", () => {
		const ana = tech("t1", "Ana", [["v1", "Assigned"]], null);
		const m = buildRecordMapModel(input({ technicians: [ana], techIds: new Set(["t1"]) }));
		expect(m.markers.some((x) => x.id === "tech-t1")).toBe(false);
		expect(m.techRows[0].coords).toBeNull();
	});

	test("hideTechs keeps rows but drops tech markers and routes", () => {
		const ana = tech("t1", "Ana", [["v1", "Done"]]);
		const m = buildRecordMapModel(
			input({
				technicians: [ana],
				routes: [route("t1", "v1")],
				techIds: new Set(["t1"]),
				hideTechs: true,
			}),
		);
		expect(m.routes).toEqual([]);
		expect(m.markers.some((x) => x.type === "TECHNICIAN")).toBe(false);
		expect(m.techRows).toHaveLength(1);
	});

	test("hideTechs withholds row positions and route figures", () => {
		const ana = tech("t1", "Ana", [["v1", "OnSite"]]);
		const m = buildRecordMapModel(
			input({
				technicians: [ana],
				routes: [route("t1", "v1")],
				techIds: new Set(["t1"]),
				hideTechs: true,
			}),
		);
		expect(m.techRows[0]).toMatchObject({
			coords: null,
			etaSeconds: null,
			distanceMeters: null,
			positionHidden: true,
		});
	});

	test("rows are not position-hidden by default", () => {
		const ana = tech("t1", "Ana", [["v1", "OnSite"]]);
		const m = buildRecordMapModel(input({ technicians: [ana], techIds: new Set(["t1"]) }));
		expect(m.techRows[0].positionHidden).toBe(false);
	});

	test("techs outside the scope are ignored; rows sort by name", () => {
		const m = buildRecordMapModel(
			input({
				technicians: [tech("t2", "Zed", []), tech("t1", "Ana", []), tech("t3", "Out", [])],
				techIds: new Set(["t1", "t2"]),
			}),
		);
		expect(m.techRows.map((r) => r.name)).toEqual(["Ana", "Zed"]);
	});
});

describe("focusAssignment / isTechActiveOn", () => {
	test("prefers the active focus assignment over a merely assigned one", () => {
		const ana = tech("t1", "Ana", [
			["v1", "Assigned"],
			["v2", "OnSite"],
		]);
		expect(focusAssignment(ana, new Set(["v1", "v2"]))?.visit_id).toBe("v2");
	});

	test("only EnRoute and OnSite count as active", () => {
		const focus = new Set(["v1"]);
		expect(isTechActiveOn(tech("a", "A", [["v1", "EnRoute"]]), focus)).toBe(true);
		expect(isTechActiveOn(tech("b", "B", [["v1", "OnSite"]]), focus)).toBe(true);
		expect(isTechActiveOn(tech("c", "C", [["v1", "Assigned"]]), focus)).toBe(false);
		expect(isTechActiveOn(tech("d", "D", [["v1", "Done"]]), focus)).toBe(false);
		expect(isTechActiveOn(tech("e", "E", [["v9", "OnSite"]]), focus)).toBe(false);
	});
});

type Seg = [visitId: string, techStatus: string, start?: string, visitStatus?: string];

function techWithVisits(id: string, name: string, segs: Seg[]): Technician {
	return {
		id,
		name,
		coords: { lat: 43.8, lon: -91.2 },
		status: "Available",
		visit_techs: segs.map(([visit_id, tech_status, start, status]) => ({
			visit_id,
			tech_id: id,
			tech_status,
			visit: { id: visit_id, scheduled_start_at: start, status },
		})),
	} as unknown as Technician;
}

describe("focusAssignment — deterministic placement", () => {
	const focus = new Set(["v1", "v2"]);

	test("two idle selected visits: the earlier-scheduled one wins regardless of array order", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v2", "Assigned", "2026-10-03T09:00:00Z"],
			["v1", "Assigned", "2026-10-02T09:00:00Z"],
		]);
		expect(focusAssignment(ana, focus)?.visit_id).toBe("v1");
	});

	test("identical start times fall back to the lower visit id", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v2", "Assigned", "2026-10-02T09:00:00Z"],
			["v1", "Assigned", "2026-10-02T09:00:00Z"],
		]);
		expect(focusAssignment(ana, focus)?.visit_id).toBe("v1");
	});

	test("an assignment without visit data sorts last", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v1", "Assigned"],
			["v2", "Assigned", "2026-10-03T09:00:00Z"],
		]);
		expect(focusAssignment(ana, focus)?.visit_id).toBe("v2");
	});

	test("an open assignment beats an earlier closed one, and the row stays visible", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v1", "Done", "2026-10-02T09:00:00Z", "Completed"],
			["v2", "Assigned", "2026-10-03T09:00:00Z", "Scheduled"],
		]);
		expect(focusAssignment(ana, focus)?.visit_id).toBe("v2");
		const m = buildRecordMapModel(
			input({ technicians: [ana], techIds: new Set(["t1"]), focusVisitIds: focus }),
		);
		expect(m.techRows[0].visitId).toBe("v2");
		expect(m.techRows[0].positionHidden).toBe(false);
	});

	test("the visit the tech is routed to beats an OnSite flag elsewhere", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v1", "OnSite", "2026-10-02T09:00:00Z"],
			["v2", "Assigned", "2026-10-03T09:00:00Z"],
		]);
		expect(focusAssignment(ana, focus, "v2")?.visit_id).toBe("v2");
		expect(focusAssignment(ana, focus)?.visit_id).toBe("v1");
	});

	test("a route visit outside the tech's focus assignments is ignored", () => {
		const ana = techWithVisits("t1", "Ana", [["v1", "Assigned", "2026-10-02T09:00:00Z"]]);
		expect(focusAssignment(ana, focus, "v9")?.visit_id).toBe("v1");
	});

	test("buildRecordMapModel passes only a focus route to the placement", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v1", "OnSite", "2026-10-02T09:00:00Z"],
			["v2", "Assigned", "2026-10-03T09:00:00Z"],
		]);
		const m = buildRecordMapModel(
			input({
				technicians: [ana],
				routes: [route("t1", "v2")],
				techIds: new Set(["t1"]),
				focusVisitIds: focus,
			}),
		);
		expect(m.techRows[0].visitId).toBe("v2");
	});
});

describe("buildRecordMapModel — per-row closed visits", () => {
	const focus = new Set(["v1", "v2"]);

	test("a tech whose only selected visit is Completed is hidden, with no marker or route", () => {
		const ana = techWithVisits("t1", "Ana", [["v1", "Done", "2026-10-02T09:00:00Z", "Completed"]]);
		const m = buildRecordMapModel(
			input({
				technicians: [ana],
				routes: [route("t1", "v1")],
				techIds: new Set(["t1"]),
				focusVisitIds: focus,
			}),
		);
		expect(m.markers.some((x) => x.type === "TECHNICIAN")).toBe(false);
		expect(m.routes).toEqual([]);
		expect(m.techRows[0]).toMatchObject({
			positionHidden: true,
			coords: null,
			etaSeconds: null,
			distanceMeters: null,
		});
	});

	test("Cancelled counts as closed", () => {
		const ana = techWithVisits("t1", "Ana", [["v1", "Assigned", undefined, "Cancelled"]]);
		const m = buildRecordMapModel(
			input({ technicians: [ana], techIds: new Set(["t1"]), focusVisitIds: focus }),
		);
		expect(m.techRows[0].positionHidden).toBe(true);
	});

	test("a tech on a Completed and an open selected visit stays visible", () => {
		const ana = techWithVisits("t1", "Ana", [
			["v1", "Done", "2026-10-02T09:00:00Z", "Completed"],
			["v2", "OnSite", "2026-10-03T09:00:00Z", "InProgress"],
		]);
		const m = buildRecordMapModel(
			input({ technicians: [ana], techIds: new Set(["t1"]), focusVisitIds: focus }),
		);
		expect(m.techRows[0].positionHidden).toBe(false);
		expect(m.markers.some((x) => x.id === "tech-t1")).toBe(true);
		expect(m.techRows[0].coords).not.toBeNull();
	});

	test("an assignment without visit data is not closed; closed visits outside focus don't count", () => {
		const noVisit = techWithVisits("t1", "Ana", [["v1", "Assigned"]]);
		const closedElsewhere = techWithVisits("t2", "Bo", [
			["v1", "Assigned", undefined, "Scheduled"],
			["v9", "Done", undefined, "Completed"],
		]);
		const m = buildRecordMapModel(
			input({
				technicians: [noVisit, closedElsewhere],
				techIds: new Set(["t1", "t2"]),
				focusVisitIds: focus,
			}),
		);
		expect(m.techRows.map((r) => r.positionHidden)).toEqual([false, false]);
	});

	test("a tech with no focus assignment is not hidden", () => {
		const m = buildRecordMapModel(
			input({ technicians: [tech("t1", "Ana", [])], techIds: new Set(["t1"]) }),
		);
		expect(m.techRows[0].positionHidden).toBe(false);
	});
});
