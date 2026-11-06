import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditJobVisit from "../EditJobVisit";
import type { Job, JobVisit } from "../../../types/jobs";
import type { TaxSnapshot } from "../../../types/tax";

const quoteSnapshot = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs-1",
	rounding: "jurisdiction_half_up",
	client_exempt: false,
	groups: [
		{
			id: "rs-1",
			name: "La Crosse, WI (auto)",
			rates: [{ id: "r1", name: "WI", rate: 0.055 }],
			taxable_amount_cents: 0,
			tax_amount_cents: 0,
		},
	],
	non_taxable_amount_cents: 0,
	total_tax_cents: 0,
	subtotal_cents: 0,
	discount_cents: 0,
	total_cents: 0,
	effective_rate: 0.055,
} as TaxSnapshot;

let job: Job;
vi.mock("../../../hooks/useJobs", () => ({
	useUpdateJobVisitMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useAssignTechniciansToVisitMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useJobByIdQuery: () => ({ data: job }),
}));
vi.mock("../../../hooks/useTechnicians", () => ({ useActiveTechniciansQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useVehicles", () => ({ useVehiclesQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useInventory", () => ({ useAllInventoryQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => false }));
vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [] }) }));
vi.mock("../../ui/DatePicker", () => ({ default: () => null }));
vi.mock("../../ui/forms/TimeConstraints", () => ({ default: () => null }));
vi.mock("../../ui/forms/LineItemsSection", () => ({
	default: ({ keptRateLabel }: { keptRateLabel?: string | null }) => (
		<div>{keptRateLabel ?? "no kept option"}</div>
	),
}));

const visit = {
	id: "v-1",
	job_id: "job-1",
	name: "Install",
	description: "Install furnace",
	scheduled_start_at: "2026-10-22T09:00:00.000Z",
	scheduled_end_at: "2026-10-22T17:00:00.000Z",
	visit_techs: [],
	line_items: [],
	tax_snapshot: null,
} as unknown as JobVisit;

const toLineItems = async () => {
	await userEvent.click(screen.getByRole("button", { name: /Next/ }));
	await userEvent.click(screen.getByRole("button", { name: /Next/ }));
};

describe("EditJobVisit kept rate inherited through the job's quote", () => {
	it("offers the quote's kept rate when neither visit nor job has a snapshot", async () => {
		job = { id: "job-1", tax_snapshot: null, quote: { tax_snapshot: quoteSnapshot } } as Job;
		render(
			<EditJobVisit
				isModalOpen
				setIsModalOpen={vi.fn()}
				visit={visit}
				jobId="job-1"
				clientExempt={false}
			/>
		);
		await toLineItems();
		expect(screen.getByText("Address rate · La Crosse, WI 5.5%")).toBeTruthy();
	});

	it("offers nothing when no ancestor holds a kept rate", async () => {
		job = { id: "job-1", tax_snapshot: null, quote: null } as Job;
		render(
			<EditJobVisit
				isModalOpen
				setIsModalOpen={vi.fn()}
				visit={visit}
				jobId="job-1"
				clientExempt={false}
			/>
		);
		await toLineItems();
		expect(screen.getByText("no kept option")).toBeTruthy();
	});
});
