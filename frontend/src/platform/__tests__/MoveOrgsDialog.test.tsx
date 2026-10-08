import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { MovePreview, TierRow } from "../types";

const h = vi.hoisted(() => ({
	mutate: vi.fn(),
	reset: vi.fn(),
	preview: {
		from: { id: "v2", version: 2 },
		to: { id: "v3", version: 3 },
		truncated: false,
		rows: [
			{
				orgId: "o1",
				name: "Acme",
				diff: {
					gained: ["ai_assistant"],
					lost: [],
					raised: [],
					lowered: [{ key: "technicians", from: 25, to: 10 }],
				},
				blockers: [],
				overCap: [],
				trialDefers: null,
			},
			{
				orgId: "o2",
				name: "Bolt",
				diff: { gained: [], lost: ["quickbooks"], raised: [], lowered: [] },
				blockers: [
					{
						module: "quickbooks",
						label: "QuickBooks",
						count: 2,
						message: "2 invoices waiting to sync",
					},
				],
				overCap: [],
				trialDefers: null,
			},
			{
				orgId: "o3",
				name: "Core",
				diff: { gained: [], lost: [], raised: [], lowered: [] },
				blockers: [],
				overCap: [],
				trialDefers: {
					tierLabel: "Enterprise",
					endsAt: "2026-10-21T00:00:00Z",
				},
			},
		],
	} as MovePreview,
	result: null as unknown,
}));
vi.mock("../hooks", () => ({
	useMovePreview: () => ({ data: h.preview, isLoading: false, error: null }),
	useMoveOrgs: () => ({
		mutate: h.mutate,
		isPending: false,
		error: null,
		data: h.result,
		reset: h.reset,
	}),
	useModuleLabel: () => (key: string) =>
		({ ai_assistant: "AI assistant", quickbooks: "QuickBooks" })[key] ?? key,
}));

import MoveOrgsDialog from "../components/MoveOrgsDialog";

const tier = {
	key: "pro",
	label: "Pro",
	assignable: true,
	archived_at: null,
	is_signup_default: false,
	is_trial_default: false,
	versions: [
		{
			id: "v3",
			version: 3,
			modules: [],
			limits: {},
			note: null,
			created_at: "",
			org_count: 0,
			trial_org_count: 0,
		},
		{
			id: "v2",
			version: 2,
			modules: [],
			limits: {},
			note: null,
			created_at: "",
			org_count: 3,
			trial_org_count: 0,
		},
	],
} as TierRow;

describe("MoveOrgsDialog", () => {
	it("previews every org with gains, losses, blockers and trial deferral", () => {
		render(
			<MemoryRouter>
				<MoveOrgsDialog tier={tier} fromVersionId="v2" onClose={vi.fn()} />
			</MemoryRouter>
		);
		expect(screen.getByText("Gains AI assistant")).toBeInTheDocument();
		expect(screen.getByText("Loses QuickBooks")).toBeInTheDocument();
		expect(screen.getByText("Technicians limit 25 → 10")).toBeInTheDocument();
		expect(screen.getByText("2 invoices waiting to sync")).toBeInTheDocument();
		expect(screen.getByText(/Enterprise trial until/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Move 3 orgs" })).toBeInTheDocument();
	});

	it("moves only the ticked orgs with the reason", () => {
		render(
			<MemoryRouter>
				<MoveOrgsDialog tier={tier} fromVersionId="v2" onClose={vi.fn()} />
			</MemoryRouter>
		);
		fireEvent.click(
			within(screen.getByText("Bolt").closest("li")!).getByRole("checkbox")
		);
		fireEvent.change(screen.getByLabelText(/Reason/), {
			target: { value: "Roll out v3" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Move 2 orgs" }));
		expect(h.mutate).toHaveBeenCalledWith({
			fromVersionId: "v2",
			orgIds: ["o1", "o3"],
			reason: "Roll out v3",
		});
	});

	it("shows the result with skipped causes", () => {
		h.result = {
			toVersion: 3,
			moved: [{ orgId: "o1", name: "Acme" }],
			skipped: [{ orgId: "o2", name: "Bolt", cause: "conflict" }],
		};
		render(
			<MemoryRouter>
				<MoveOrgsDialog tier={tier} fromVersionId="v2" onClose={vi.fn()} />
			</MemoryRouter>
		);
		expect(screen.getByText("1 org moved to v3")).toBeInTheDocument();
		expect(screen.getByText(/changed by someone else/)).toBeInTheDocument();
		h.result = null;
	});
});
