import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import UsageMeters from "../UsageMeters";
import type { EntitlementsData, UsageSummary } from "../../../../lib/permissionAccess";

const meters = {
	dispatchers: { used: 1, limit: 10 },
	technicians: { used: 2, limit: 25 },
	ai_calls_month: { used: 0, limit: 500 },
	tax_lookups_month: { used: 0, limit: 2000 },
	receipt_scans_month: { used: 12, limit: 300 },
};

const mod = (key: string, state: "on" | "off_by_org" | "not_in_plan") =>
	({ key, label: key, description: "", kind: "plan_gated", requires: [], state }) as
		EntitlementsData["modules"][number];
const allOn = [mod("field_purchases", "on"), mod("ai_assistant", "on"), mod("tax_auto", "on")];

describe("UsageMeters", () => {
	it("shows the receipt scan meter", () => {
		render(<UsageMeters usage={{ period_start: "2026-10-01", meters }} modules={allOn} />);
		expect(screen.getByRole("progressbar", { name: "Receipt scans" })).toHaveAttribute(
			"aria-valuenow",
			"12"
		);
	});

	it("skips a meter an older backend does not send", () => {
		const { receipt_scans_month: _, ...older } = meters;
		render(
			<UsageMeters
				usage={
					{
						period_start: "2026-10-01",
						meters: older,
					} as unknown as UsageSummary
				}
				modules={allOn}
			/>
		);
		expect(screen.queryByText("Receipt scans")).toBeNull();
		expect(screen.getByText("Tax lookups")).toBeInTheDocument();
	});

	it("hides a monthly meter while its module is off", () => {
		render(
			<UsageMeters
				usage={{ period_start: "2026-10-01", meters }}
				modules={[
					mod("field_purchases", "off_by_org"),
					mod("ai_assistant", "not_in_plan"),
					mod("tax_auto", "not_in_plan"),
				]}
			/>
		);
		expect(screen.queryByText("Receipt scans")).toBeNull();
		expect(screen.queryByText("AI assistant requests")).toBeNull();
		expect(screen.queryByText("Tax lookups")).toBeNull();
		expect(screen.getByText("Dispatchers")).toBeInTheDocument();
		expect(screen.getByText("Technicians")).toBeInTheDocument();
	});

	it("keeps a meter whose module the payload does not list", () => {
		render(<UsageMeters usage={{ period_start: "2026-10-01", meters }} modules={[]} />);
		expect(screen.getByText("Receipt scans")).toBeInTheDocument();
	});
});
