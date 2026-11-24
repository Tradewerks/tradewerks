import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateRecurringPlan from "../CreateRecurringPlan";
import EditRecurringPlan from "../EditRecurringPlan";
import { CreateRecurringPlanSchema, type RecurringPlan } from "../../../types/recurringPlans";

const TECH = "44444444-4444-4444-8444-444444444444";
const createMutate = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../../hooks/useRecurringPlans", () => ({
	useCreateRecurringPlanMutation: () => ({ mutateAsync: createMutate, isPending: false }),
	useUpdateRecurringPlanMutation: () => ({ mutateAsync: updateMutate, isPending: false }),
	useDebouncedRecurringTaxEstimate: () => ({ data: undefined }),
}));
vi.mock("../../../hooks/useClients", () => ({
	useAllClientsQuery: () => ({ data: [{ id: "11111111-1111-4111-8111-111111111111", name: "Acme" }] }),
}));
vi.mock("../../../hooks/forms/useDrafts", () => ({
	useDraftsByTypeQuery: () => ({ data: [] }),
	useCreateDraftMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateDraftMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteDraftMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useTechnicians", () => ({
	useActiveTechniciansQuery: () => ({ data: [{ id: TECH, name: "Tess Tech" }] }),
	useAllTechniciansQuery: () => ({ data: [{ id: TECH, name: "Tess Tech" }] }),
}));
vi.mock("../../../auth/authStore", () => ({
	useAuthStore: (sel: (s: unknown) => unknown) =>
		sel({ user: { orgTimezone: "America/Denver" } }),
}));
vi.mock("../../../hooks/useVehicles", () => ({ useVehiclesQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useInventory", () => ({ useAllInventoryQuery: () => ({ data: [] }) }));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => false }));
vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [] }) }));
vi.mock("../../ui/DatePicker", () => ({ default: () => null }));
vi.mock("../../ui/forms/TimeConstraints", () => ({ default: () => null }));
vi.mock("../../ui/forms/LineItemsSection", () => ({
	default: ({
		lineItems,
		onUpdate,
	}: {
		lineItems: { id: string }[];
		onUpdate: (id: string, f: string, v: number) => void;
	}) => (
		<button type="button" onClick={() => onUpdate(lineItems[0].id, "unit_price", 30)}>
			bump price
		</button>
	),
}));
vi.mock("../../ui/AddressForm", () => ({
	default: ({ handleChange }: { handleChange: (r: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				handleChange({ address: "1 Main St", coords: { lat: 1, lon: 2 } })
			}
		>
			pick address
		</button>
	),
}));

beforeEach(() => {
	createMutate.mockReset().mockResolvedValue({ id: "p-1" });
	updateMutate.mockReset().mockResolvedValue({ id: "p-1" });
});

describe("CreateRecurringPlan", () => {
	it("create payload has no timezone field", async () => {
		const user = userEvent.setup();
		render(<CreateRecurringPlan isModalOpen setIsModalOpen={vi.fn()} />);

		await user.type(screen.getByPlaceholderText(/plan name/i), "Quarterly PM");
		await user.selectOptions(screen.getAllByRole("combobox")[0], "11111111-1111-4111-8111-111111111111");
		await user.type(screen.getByPlaceholderText("Plan Description"), "Filter swap");
		await user.click(screen.getByText("pick address"));
		await user.click(screen.getByRole("button", { name: /next/i }));

		expect(screen.getByText(/times are in america\/denver/i)).toBeInTheDocument();
		await user.selectOptions(screen.getByLabelText(/default technician/i), TECH);

		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(screen.getByRole("button", { name: /create plan/i }));

		expect(createMutate).toHaveBeenCalledTimes(1);
		const payload = createMutate.mock.calls[0][0];
		expect(payload).not.toHaveProperty("timezone");
		expect(payload.default_technician_id).toBe(TECH);
	});

	it("yearly without a day shows the validation error", () => {
		const base = {
			name: "Yearly",
			client_id: "11111111-1111-4111-8111-111111111111",
			address: "1 Main St",
			description: "d",
			starts_at: new Date().toISOString(),
			rule: {
				frequency: "yearly" as const,
				interval: 1,
				by_month: 3,
				arrival_constraint: "anytime" as const,
				finish_constraint: "when_done" as const,
			},
		};
		const r = CreateRecurringPlanSchema.safeParse(base);
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(
				r.error.issues.some(
					(i) => i.path.join(".") === "rule.by_month_day" && /day/i.test(i.message)
				)
			).toBe(true);
		}
		expect(
			CreateRecurringPlanSchema.safeParse({
				...base,
				rule: { ...base.rule, by_month_day: 15 },
			}).success
		).toBe(true);
	});

	it("rejects a zero fixed amount", () => {
		const r = CreateRecurringPlanSchema.safeParse({
			name: "Fixed",
			client_id: "11111111-1111-4111-8111-111111111111",
			address: "1 Main St",
			description: "d",
			starts_at: new Date().toISOString(),
			rule: {
				frequency: "daily",
				interval: 1,
				arrival_constraint: "anytime",
				finish_constraint: "when_done",
			},
			invoice_schedule: {
				billing_basis: "fixed_amount",
				fixed_amount: 0,
				frequency: "monthly",
			},
		});
		expect(r.success).toBe(false);
		if (!r.success) {
			expect(r.error.issues.map((i) => i.path.join("."))).toContain(
				"invoice_schedule.fixed_amount"
			);
		}
	});
});

describe("EditRecurringPlan", () => {
	const plan = {
		id: "22222222-2222-4222-8222-222222222222",
		client_id: "c-1",
		name: "Quarterly PM",
		description: "Filter swap",
		address: "1 Main St",
		coords: { lat: 1, lon: 2 },
		priority: "Medium",
		status: "Active",
		starts_at: "2026-11-01T15:00:00.000Z",
		ends_at: null,
		timezone: "America/Denver",
		default_technician_id: TECH,
		generation_window_days: 30,
		min_advance_days: 1,
		billing_mode: "none",
		invoice_timing: "manual",
		auto_invoice: false,
		created_at: "2026-10-01T00:00:00.000Z",
		updated_at: "2026-10-01T00:00:00.000Z",
		rules: [
			{
				frequency: "daily",
				interval: 1,
				by_weekday: [],
				by_month_day: null,
				by_month: null,
			},
		],
		line_items: [
			{
				id: "33333333-3333-4333-8333-333333333333",
				name: "Filter",
				quantity: 1,
				unit_price: 25,
			},
		],
	} as unknown as RecurringPlan;

	const goToLinesStep = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click(screen.getByRole("button", { name: /next/i }));
		expect(screen.getByText(/times are in america\/denver/i)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(screen.getByRole("button", { name: /next/i }));
	};

	it("edit sends apply_to_scheduled_visits true by default when line items change", async () => {
		const user = userEvent.setup();
		render(<EditRecurringPlan isModalOpen setIsModalOpen={vi.fn()} plan={plan} />);
		await goToLinesStep(user);

		await user.click(screen.getByText("bump price"));
		const box = screen.getByLabelText(/also update scheduled visits that haven't started/i);
		expect(box).toBeChecked();

		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(updateMutate).toHaveBeenCalledTimes(1);
		const { updates } = updateMutate.mock.calls[0][0];
		expect(updates.apply_to_scheduled_visits).toBe(true);
		expect(updates.line_items[0].unit_price).toBe(30);
		expect(updates).not.toHaveProperty("timezone");
	});

	it("edit omits line_items and the apply flag when lines are unchanged", async () => {
		const user = userEvent.setup();
		render(<EditRecurringPlan isModalOpen setIsModalOpen={vi.fn()} plan={plan} />);
		await goToLinesStep(user);

		expect(
			screen.queryByLabelText(/also update scheduled visits that haven't started/i)
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /next/i }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		const { updates } = updateMutate.mock.calls[0][0];
		expect(updates).not.toHaveProperty("line_items");
		expect(updates).not.toHaveProperty("apply_to_scheduled_visits");
	});
});
