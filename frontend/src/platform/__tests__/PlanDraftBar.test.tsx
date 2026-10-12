import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlanDraftBar from "../components/PlanDraftBar";
import type { PlanDraft } from "../usePlanDraft";
import type { OrgDetail, StaffChangesPreview, TierRow } from "../types";

const version = (id: string, n: number, modules: string[]) => ({
	id,
	version: n,
	modules,
	limits: {},
	note: null,
	created_at: "",
	org_count: 0,
	trial_org_count: 0,
});
const tiers: TierRow[] = [
	{
		key: "pro",
		label: "Pro",
		assignable: true,
		archived_at: null,
		is_signup_default: false,
		versions: [version("pv-2", 2, ["quickbooks", "inventory"])],
	},
	{
		key: "starter",
		label: "Starter",
		assignable: true,
		archived_at: null,
		is_signup_default: false,
		versions: [version("pv-s1", 1, [])],
	},
];
const breakdown = (tier: { key: string; label: string; version: number }) => ({
	modules: {},
	limits: {} as never,
	baseTier: tier,
	trialTier: null,
});
const detail = (trial = false): OrgDetail =>
	({
		org: { id: "org-1", name: "Acme" },
		entitlement: {
			plan_version_id: "pv-2",
			module_grants: {},
			updated_at: "t",
		},
		catalog: [
			{ key: "quickbooks", label: "QuickBooks", kind: "plan_gated" },
			{ key: "inventory", label: "Inventory", kind: "optional" },
		],
		breakdown: {
			...breakdown({ key: "pro", label: "Pro", version: 2 }),
			trialTier: trial
				? {
						key: "max",
						label: "Max",
						version: 1,
						endsAt: "2026-10-21T12:00:00Z",
					}
				: null,
		},
	}) as unknown as OrgDetail;

const preview = (lost: string[] = []): StaffChangesPreview => ({
	before: {} as never,
	after: {} as never,
	diff: { lost, gained: [], lowered: [], raised: [] },
	blockers: [],
	overCap: [],
	breakdown: breakdown({ key: "starter", label: "Starter", version: 1 }),
});

const save = vi.fn();
const onSaved = vi.fn();
const draft = (over: Partial<PlanDraft> = {}): PlanDraft =>
	({
		state: { planVersionId: "pv-s1", grants: { inventory: "on" }, stamp: "t" },
		changes: [
			{ kind: "plan", planVersionId: "pv-s1" },
			{ kind: "grant", module: "inventory", grant: "on" },
		],
		preview: preview(),
		previewPending: false,
		previewError: null,
		save,
		saving: false,
		saveError: null,
		conflict: false,
		discard: vi.fn(),
		...over,
	}) as unknown as PlanDraft;

const renderBar = (d: PlanDraft, det = detail(), requestId?: string) =>
	render(
		<PlanDraftBar
			draft={d}
			detail={det}
			tiers={tiers}
			requestId={requestId}
			onSaved={onSaved}
		/>
	);
const reason = () => screen.getByLabelText(/Reason/);
const saveButton = () => screen.getByRole("button", { name: "Save changes" });

beforeEach(() => {
	save.mockReset();
	onSaved.mockReset();
	save.mockResolvedValue({ status: "saved", preview: undefined, changes: [] });
});

describe("PlanDraftBar", () => {
	it("summarises the tier move and the override count", () => {
		renderBar(draft());
		expect(
			screen.getByText("Tier Pro v2 → Starter v1 · 1 override")
		).toBeInTheDocument();
	});

	it("refuses a short reason, then saves once it is corrected", async () => {
		renderBar(draft());
		fireEvent.change(reason(), { target: { value: "ab" } });
		fireEvent.click(saveButton());
		expect(
			screen.getByText("Give a reason (3 characters or more)")
		).toBeInTheDocument();
		expect(save).not.toHaveBeenCalled();
		fireEvent.change(reason(), { target: { value: "Customer asked" } });
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenCalledWith("Customer asked", undefined));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
	});

	it("turns destructive when anything is lost, and names the loss", () => {
		renderBar(draft({ preview: preview(["quickbooks"]) }));
		expect(saveButton().className).toContain("bg-error");
		expect(screen.getByText("QuickBooks")).toBeInTheDocument();
	});

	it("stays primary when nothing is lost", () => {
		renderBar(draft());
		expect(saveButton().className).not.toContain("bg-error");
	});

	it("sends the request id only while the box is ticked", async () => {
		renderBar(draft(), detail(), "r-1");
		const box = screen.getByRole("checkbox", { name: "Mark request approved" });
		expect(box).not.toBeChecked();
		fireEvent.change(reason(), { target: { value: "Customer asked" } });
		fireEvent.click(saveButton());
		await waitFor(() =>
			expect(save).toHaveBeenLastCalledWith("Customer asked", undefined)
		);
		fireEvent.click(box);
		fireEvent.click(saveButton());
		await waitFor(() => expect(save).toHaveBeenLastCalledWith("Customer asked", "r-1"));
	});

	it("starts ticked when the draft was seeded from the request", () => {
		renderBar(
			draft({
				state: {
					planVersionId: "pv-s1",
					grants: {},
					stamp: "t",
					requestId: "r-1",
				},
			}),
			detail(),
			"r-1"
		);
		expect(
			screen.getByRole("checkbox", { name: "Mark request approved" })
		).toBeChecked();
	});

	it("unticks the box when the request was closed meanwhile", async () => {
		save.mockResolvedValue({ status: "request_closed" });
		renderBar(draft(), detail(), "r-1");
		fireEvent.click(screen.getByRole("checkbox", { name: "Mark request approved" }));
		fireEvent.change(reason(), { target: { value: "Customer asked" } });
		fireEvent.click(saveButton());
		await waitFor(() =>
			expect(
				screen.getByRole("checkbox", { name: "Mark request approved" })
			).not.toBeChecked()
		);
		expect(screen.getByText(/already closed by someone else/)).toBeInTheDocument();
	});

	it("explains that a trial defers the tier change, with the after-trial list", () => {
		renderBar(draft(), detail(true));
		expect(
			screen.getByText(
				/Max trial applies until .*; the tier change takes effect after\./
			)
		).toBeInTheDocument();
		expect(screen.getByText("QuickBooks off")).toBeInTheDocument();
	});

	it("tells the user when someone else saved first", () => {
		renderBar(draft({ conflict: true }));
		expect(
			screen.getByText(/Someone else changed this organization/)
		).toBeInTheDocument();
	});

	it("a preview refusal outranks the conflict notice", () => {
		renderBar(
			draft({
				conflict: true,
				previewError: Object.assign(new Error("x"), {
					isAxiosError: true,
					response: {
						data: { error: { message: "Nothing to change" } },
					},
				}),
			})
		);
		expect(screen.getByText("Nothing to change")).toBeInTheDocument();
		expect(screen.queryByText(/Someone else changed this organization/)).toBeNull();
	});

	it("disables saving while the preview is updating", () => {
		renderBar(draft({ previewPending: true }));
		expect(saveButton()).toBeDisabled();
	});
});
