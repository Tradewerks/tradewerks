import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RequestStatus from "../RequestStatus";
import { latestRequestState } from "../latestRequestState";
import type { UpgradeRequest } from "../../../../api/upgradeRequests";

const r = (over: Partial<UpgradeRequest>): UpgradeRequest => ({
	id: "r1",
	organization_id: "org-1",
	requested_by_id: "d-1",
	requested_by_name: "Dana",
	requested_plan_key: "pro",
	requested_plan_label: "Pro",
	requested_modules: [{ key: "ai_assistant", label: "AI assistant" }],
	note: null,
	status: "open",
	resolution_note: null,
	resolved_at: null,
	created_at: "2026-10-07T12:00:00Z",
	...over,
});
const NOW = new Date("2026-10-10T12:00:00Z");

describe("latestRequestState", () => {
	it("prefers the open request", () => {
		expect(
			latestRequestState([r({ status: "declined", id: "r0" }), r({})], NOW)?.kind
		).toBe("open");
	});
	it("shows the latest closed request for 30 days, never a withdrawn one", () => {
		expect(
			latestRequestState(
				[r({ status: "approved", resolved_at: "2026-10-08T00:00:00Z" })],
				NOW
			)?.kind
		).toBe("approved");
		expect(
			latestRequestState(
				[r({ status: "declined", resolved_at: "2026-09-01T00:00:00Z" })],
				NOW
			)
		).toBeNull();
		expect(
			latestRequestState(
				[r({ status: "withdrawn", resolved_at: "2026-10-09T00:00:00Z" })],
				NOW
			)
		).toBeNull();
	});
});

describe("RequestStatus", () => {
	it("shows what was asked and a Withdraw button while open", () => {
		render(
			<RequestStatus
				requests={[r({})]}
				onWithdraw={vi.fn()}
				withdrawing={false}
			/>
		);
		expect(screen.getByText(/Pro, AI assistant/)).toBeInTheDocument();
		expect(screen.getByText(/Waiting for TradeWerks/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
	});
	it("shows the decline note", () => {
		render(
			<RequestStatus
				requests={[
					r({
						status: "declined",
						resolution_note: "Not this quarter",
						resolved_at: new Date().toISOString(),
					}),
				]}
				onWithdraw={vi.fn()}
				withdrawing={false}
			/>
		);
		expect(screen.getByText(/Declined: Not this quarter/)).toBeInTheDocument();
	});
});
