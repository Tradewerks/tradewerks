import { describe, expect, test } from "vitest";
import { formatChange } from "../changeFormat";
import type { ActivityLog } from "../../../types/logs";

const log = (changes: ActivityLog["changes"]): ActivityLog => ({
	id: "l1",
	event_type: "organization.settings_updated",
	action: "updated",
	entity_type: "organization",
	entity_id: "org-1",
	actor_type: "dispatcher",
	actor_id: "d1",
	actor_name: "Dana",
	changes,
	timestamp: "2026-10-13T12:00:00Z",
	ip_address: null,
	user_agent: null,
	reason: null,
	organization_id: "org-1",
});

describe("organization settings log formatting", () => {
	test("headline names the settings, not a raw entity key", () => {
		expect(formatChange(log({ name: { old: "A", new: "B" } }), "UTC").headline).toBe(
			"Organization settings updated"
		);
	});

	test("restock_mode and measurement_system render labels and readable values", () => {
		const { rows } = formatChange(
			log({
				restock_mode: { old: "tech_self_serve", new: "dispatch_prepared" },
				measurement_system: { old: "imperial", new: "metric" },
			}),
			"UTC"
		);
		expect(rows).toEqual([
			expect.objectContaining({
				label: "Vehicle restock workflow",
				from: "Technician self-serve",
				to: "Dispatch prepared",
			}),
			expect.objectContaining({
				label: "Measurement system",
				from: "Imperial",
				to: "Metric",
			}),
		]);
	});

	test("the sign-off threshold renders as money", () => {
		const { rows } = formatChange(
			log({ field_purchase_second_signoff_threshold: { old: null, new: "500" } }),
			"UTC"
		);
		expect(rows[0]).toEqual(
			expect.objectContaining({
				label: "Second sign-off threshold",
				from: "—",
				to: "$500.00",
			})
		);
	});

	test("the sign-off threshold renders as money when stored as a Decimal string or a number", () => {
		const { rows } = formatChange(
			log({ field_purchase_second_signoff_threshold: { old: "500", new: 750 } }),
			"UTC"
		);
		expect(rows[0]).toEqual(
			expect.objectContaining({ from: "$500.00", to: "$750.00" })
		);
	});
});

describe("document status log formatting", () => {
	test("a quote status change reads Issued as Created", () => {
		const { rows } = formatChange(
			{ ...log({ status: { old: "Draft", new: "Issued" } }), entity_type: "quote" },
			"UTC"
		);
		expect(rows).toEqual([expect.objectContaining({ from: "Draft", to: "Created" })]);
	});

	test("an invoice status change reads Paid as Fully Paid", () => {
		const { rows } = formatChange(
			{ ...log({ status: { old: "Issued", new: "Paid" } }), entity_type: "invoice" },
			"UTC"
		);
		expect(rows).toEqual([expect.objectContaining({ from: "Created", to: "Fully Paid" })]);
	});

	test("other entities keep their stored status text", () => {
		const { rows } = formatChange(
			{ ...log({ status: { old: "Scheduled", new: "Issued" } }), entity_type: "job" },
			"UTC"
		);
		expect(rows).toEqual([expect.objectContaining({ from: "Scheduled", to: "Issued" })]);
	});
});
