import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildVisitModel } from "../visitMessageModel.js";
import { renderTemplate } from "../templateRenderer.js";
import { DEFAULT_NOTIFICATION_TEMPLATES } from "../customerComms/templateDefaults.js";

interface Arrival {
	tech_id: string;
	basis: string;
	eta_at: Date | null;
	computed_at: Date;
}

const NOW = new Date("2026-11-18T14:30:00Z");
const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00Z`);

const visit = (names: string[]) => ({
	id: "v1",
	scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
	arrival_constraint: "between",
	arrival_time: null,
	arrival_window_start: "08:00",
	arrival_window_end: "10:00",
	job: { name: "Furnace tune-up", address: "1 Main St" },
	visit_techs: names.map((name, i) => ({
		tech_id: `t${i}`,
		tech_status: "Assigned",
		tech: { name, title: "Lead Technician" },
	})),
	arrivals: [] as Arrival[],
	drives: [] as { tech_id: string; started_at: Date }[],
});

const sdbWith = (row: unknown) =>
	({ job_visit: { findFirst: vi.fn().mockResolvedValue(row) } }) as never;

describe("buildVisitModel", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("returns null for a visit in another org", async () => {
		expect(
			await buildVisitModel(sdbWith(null), "v1", "America/Chicago"),
		).toBeNull();
	});

	it("builds date, window, address, job title and tech names", async () => {
		const m = await buildVisitModel(
			sdbWith(visit(["Ann Lee", "Bob Ray", "Cy Doe"])),
			"v1",
			"America/Chicago",
		);
		expect(m?.visit).toEqual({
			date: "Wednesday, November 18",
			window: "between 8:00 AM and 10:00 AM",
			address: "1 Main St",
			job_title: "Furnace tune-up",
			name: "",
			description: "",
			tech_names: "Ann, Bob and Cy",
			tech_first_name: "Ann",
			eta: "",
		});
	});

	it("joins two techs with and, and is empty with none", async () => {
		const two = await buildVisitModel(
			sdbWith(visit(["Ann Lee", "Bob Ray"])),
			"v1",
			"UTC",
		);
		expect(two?.visit.tech_names).toBe("Ann and Bob");
		const none = await buildVisitModel(sdbWith(visit([])), "v1", "UTC");
		expect(none?.visit.tech_names).toBe("");
		expect(none?.visit.tech_first_name).toBe("");
	});

	it("the message omits the ETA sentence when there is no arrival row", async () => {
		const m = await buildVisitModel(
			sdbWith(visit(["Ann Lee"])),
			"v1",
			"UTC",
		);
		expect(m?.visit.eta).toBe("");
		const html = renderTemplate(
			DEFAULT_NOTIFICATION_TEMPLATES.tech_on_the_way.html,
			{ client_name: "Pat", brand: { name: "Acme" }, ...m },
		);
		expect(html).toContain("Ann is on the way");
		expect(html).not.toContain("Estimated arrival");
	});

	it("names the driving tech and formats their ETA unless basis is no_location", async () => {
		const row = visit(["Ann Lee", "Bob Ray"]);
		row.visit_techs[1].tech_status = "EnRoute";
		row.arrivals = [
			{
				tech_id: "t1",
				basis: "traffic",
				eta_at: at("15:30"),
				computed_at: at("14:20"),
			},
		];
		const m = await buildVisitModel(sdbWith(row), "v1", "UTC");
		expect(m?.tech).toEqual({ name: "Bob Ray", title: "Lead Technician" });
		expect(m?.visit.eta).toBe("3:30 PM");
		row.arrivals[0].basis = "no_location";
		const n = await buildVisitModel(sdbWith(row), "v1", "UTC");
		expect(n?.visit.eta).toBe("");
	});

	it("names the tech who drove first even if another is Assigned and the driver is now Completed", async () => {
		const row = visit(["Ann Lee", "Bob Ray"]);
		row.visit_techs[1].tech_status = "Completed";
		row.drives = [{ tech_id: "t1", started_at: at("13:00") }];
		const m = await buildVisitModel(sdbWith(row), "v1", "UTC");
		expect(m?.tech.name).toBe("Bob Ray");
	});

	it("with two techs en route, the earliest drive today wins", async () => {
		const row = visit(["Ann Lee", "Bob Ray"]);
		row.visit_techs.forEach((t) => (t.tech_status = "EnRoute"));
		row.drives = [
			{ tech_id: "t1", started_at: at("13:00") },
			{ tech_id: "t0", started_at: at("13:10") },
		];
		const m = await buildVisitModel(sdbWith(row), "v1", "UTC");
		expect(m?.tech.name).toBe("Bob Ray");
	});

	it("omits the ETA when it has passed or was computed before the drive began", async () => {
		const row = visit(["Ann Lee"]);
		row.drives = [{ tech_id: "t0", started_at: at("14:00") }];
		const arrival = (eta: Date | null, computed: Date): Arrival => ({
			tech_id: "t0",
			basis: "traffic",
			eta_at: eta,
			computed_at: computed,
		});
		row.arrivals = [arrival(at("15:00"), at("14:10"))];
		expect(
			(await buildVisitModel(sdbWith(row), "v1", "UTC"))?.visit.eta,
		).toBe("3:00 PM");
		row.arrivals = [arrival(at("14:20"), at("14:10"))];
		expect(
			(await buildVisitModel(sdbWith(row), "v1", "UTC"))?.visit.eta,
		).toBe("");
		row.arrivals = [arrival(at("15:00"), at("13:50"))];
		expect(
			(await buildVisitModel(sdbWith(row), "v1", "UTC"))?.visit.eta,
		).toBe("");
	});

	it("omits the ETA when the arrival row has no eta_at", async () => {
		const row = visit(["Ann Lee"]);
		row.arrivals = [
			{
				tech_id: "t0",
				basis: "elapsed",
				eta_at: null,
				computed_at: at("14:10"),
			},
		];
		expect(
			(await buildVisitModel(sdbWith(row), "v1", "UTC"))?.visit.eta,
		).toBe("");
	});
});
