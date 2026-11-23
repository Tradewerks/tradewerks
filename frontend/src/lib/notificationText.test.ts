import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { notificationText } from "./notificationText";
import type { TechnicianNotification } from "../types/notifications";

const base: TechnicianNotification = {
	id: "n1",
	technician_id: "t1",
	type: "visit_cancelled",
	title: "Visit cancelled: Acme",
	body: "A visit at Acme has been cancelled.",
	vars: null,
	action_url: null,
	read_at: null,
	created_at: "2026-11-23T15:00:00Z",
};
const tz = "America/Chicago";

describe("notificationText", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("shows rows without vars as saved", async () => {
		await i18n.changeLanguage("es");
		expect(notificationText(base, tz)).toEqual({ title: base.title, body: base.body });
	});

	it("picks the variant and translates", async () => {
		await i18n.changeLanguage("es");
		const n = { ...base, vars: { client: "Acme", reason: "Lluvia", variant: "reason" } };
		expect(notificationText(n, tz)).toEqual({
			title: "Visita cancelada: Acme",
			body: "Se canceló una visita en Acme. Motivo: Lluvia",
		});
	});

	it("keeps someone's own words as the body", async () => {
		await i18n.changeLanguage("es");
		const n = { ...base, type: "note_added" as const, body: "Gate code 1234", vars: { job: "J-7", keep_body: true } };
		expect(notificationText(n, tz)).toEqual({ title: "Nota agregada: Trabajo #J-7", body: "Gate code 1234" });
	});

	it("formats times in the org timezone and adds traffic", () => {
		const n = {
			...base,
			type: "tech_running_late" as const,
			vars: { client: "Acme", variant: "en_route", eta: "2026-11-23T21:40:00Z", due: "2026-11-23T21:30:00Z", late_min: 10, traffic_min: 6 },
		};
		expect(notificationText(n, tz).body).toBe("ETA 3:40 PM, due by 3:30 PM (~10 min late). Traffic is adding ~6 min.");
	});
});
