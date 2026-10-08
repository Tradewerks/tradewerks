import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import UsageMeters from "../UsageMeters";
import type { UsageSummary } from "../../../../lib/permissionAccess";

const meters = {
	dispatchers: { used: 1, limit: 10 },
	technicians: { used: 2, limit: 25 },
	ai_calls_month: { used: 0, limit: 500 },
	tax_lookups_month: { used: 0, limit: 2000 },
	receipt_scans_month: { used: 12, limit: 300 },
};

describe("UsageMeters", () => {
	it("shows the receipt scan meter", () => {
		render(<UsageMeters usage={{ period_start: "2026-10-01", meters }} />);
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
			/>
		);
		expect(screen.queryByText("Receipt scans")).toBeNull();
		expect(screen.getByText("Tax lookups")).toBeInTheDocument();
	});
});
