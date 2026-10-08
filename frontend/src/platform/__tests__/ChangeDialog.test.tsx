import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OrgDetail, StaffChangePreview, TierRow } from "../types";

const { mutateAsync, stable, preview, detail, tiers } = vi.hoisted(() => {
	const tiers: TierRow[] = [
		{
			key: "pro",
			label: "Pro",
			assignable: true,
			archived_at: null,
			is_signup_default: false,
			is_trial_default: false,
			versions: [
				{
					id: "pv-3",
					version: 3,
					modules: ["inventory", "quickbooks"],
					limits: { dispatchers: 10 },
					note: null,
					created_at: "",
					org_count: 0,
					trial_org_count: 0,
				},
				{
					id: "pv-2",
					version: 2,
					modules: ["quickbooks"],
					limits: { dispatchers: 5 },
					note: null,
					created_at: "",
					org_count: 1,
					trial_org_count: 0,
				},
			],
		},
	];
	const detail = {
		org: { id: "org-1", name: "Acme" },
		entitlement: { plan_version_id: "pv-2", updated_at: "t" },
		catalog: [{ key: "inventory", label: "Inventory", kind: "optional" }],
		breakdown: {
			baseTier: { key: "pro", label: "Pro", version: 2 },
			trialTier: {
				key: "max",
				label: "Max",
				version: 1,
				endsAt: "2026-10-21T12:00:00Z",
			},
		},
	} as unknown as OrgDetail;
	const preview: StaffChangePreview = {
		before: {} as never,
		after: {} as never,
		diff: { gained: [], lost: [], raised: [], lowered: [] },
		blockers: [],
		overCap: [],
	};
	// Stable fns: ChangeDialog re-runs its open effect (which clears the reason) when they change.
	const stable = { mutate: vi.fn(), reset: vi.fn(), refetch: vi.fn() };
	return { mutateAsync: vi.fn().mockResolvedValue({}), stable, preview, detail, tiers };
});

vi.mock("../hooks", () => ({
	useOrg: () => ({ data: detail, refetch: stable.refetch }),
	useTiers: () => ({ data: tiers }),
	usePreviewChange: () => ({
		mutate: stable.mutate,
		reset: stable.reset,
		data: preview,
		isPending: false,
		isError: false,
		error: null,
	}),
	useApplyChange: () => ({ mutateAsync, reset: stable.reset, isPending: false, error: null }),
}));

import ChangeDialog from "../components/ChangeDialog";

const planChange = { kind: "plan", planVersionId: "pv-3" } as const;
const grantChange = { kind: "grant", module: "inventory", grant: "on" } as const;

describe("ChangeDialog", () => {
	it("explains a tier change that waits for the trial to end", () => {
		render(
			<ChangeDialog
				orgId="org-1"
				change={planChange}
				title="Change tier"
				onClose={vi.fn()}
			/>
		);
		expect(
			screen.getByText(/Max trial applies until .*, so nothing changes today\./)
		).toBeInTheDocument();
		expect(screen.getByText("After the trial ends")).toBeInTheDocument();
		expect(screen.getByText("Inventory on")).toBeInTheDocument();
		expect(screen.getByText("Dispatchers 5→10")).toBeInTheDocument();
	});

	it("calls onApplied with the preview before closing", async () => {
		const onApplied = vi.fn();
		const onClose = vi.fn();
		render(
			<ChangeDialog
				orgId="org-1"
				change={grantChange}
				title="Inventory: force on"
				onApplied={onApplied}
				onClose={onClose}
			/>
		);
		expect(screen.queryByText("After the trial ends")).toBeNull();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ticket 123" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
		await waitFor(() => expect(onApplied).toHaveBeenCalledWith(preview));
		expect(onClose).toHaveBeenCalled();
	});

	it("applies after a too-short reason is corrected", async () => {
		const onClose = vi.fn();
		render(
			<ChangeDialog
				orgId="org-1"
				change={grantChange}
				title="Inventory: force on"
				onClose={onClose}
			/>
		);
		const apply = screen.getByRole("button", { name: "Apply change" });
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "ab" } });
		fireEvent.click(apply);
		expect(await screen.findByText(/Give a reason/)).toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "asdftwer" } });
		fireEvent.click(apply);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});
});

describe("request checkbox", () => {
	it("is hidden without a request", () => {
		render(
			<ChangeDialog
				orgId="org-1"
				change={planChange}
				title="Change tier"
				onClose={vi.fn()}
			/>
		);
		expect(
			screen.queryByRole("checkbox", { name: /Mark request approved/ })
		).toBeNull();
	});

	it("sends the request id when ticked", async () => {
		render(
			<ChangeDialog
				orgId="org-1"
				change={planChange}
				title="Change tier"
				requestId="r1"
				markApprovedByDefault
				onClose={vi.fn()}
			/>
		);
		expect(
			screen.getByRole("checkbox", { name: /Mark request approved/ })
		).toBeChecked();
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "As requested" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
		await waitFor(() =>
			expect(mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({ upgradeRequestId: "r1" })
			)
		);
	});

	it("starts unticked when opened outside the request banner, and sends no id", async () => {
		render(
			<ChangeDialog
				orgId="org-1"
				change={planChange}
				title="Change tier"
				requestId="r1"
				onClose={vi.fn()}
			/>
		);
		expect(
			screen.getByRole("checkbox", { name: /Mark request approved/ })
		).not.toBeChecked();
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "Seats raised" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
		await waitFor(() =>
			expect(mutateAsync).toHaveBeenLastCalledWith(
				expect.objectContaining({ upgradeRequestId: undefined })
			)
		);
	});

	it("unticks and explains when the request was already closed", async () => {
		mutateAsync.mockRejectedValueOnce(
			Object.assign(new Error("closed"), {
				isAxiosError: true,
				response: {
					status: 409,
					data: {
						error: {
							code: "REQUEST_CLOSED",
							message: "This request was already closed",
						},
					},
				},
			})
		);
		render(
			<ChangeDialog
				orgId="org-1"
				change={planChange}
				title="Change tier"
				requestId="r1"
				markApprovedByDefault
				onClose={vi.fn()}
			/>
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "As requested" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
		expect(await screen.findByText(/already closed/)).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: /Mark request approved/ })
		).not.toBeChecked();
	});
});

describe("request reason visibility", () => {
	it("warns that the requester sees the reason only while the box is ticked", () => {
		render(
			<ChangeDialog
				orgId="org-1"
				change={planChange}
				title="Change tier"
				requestId="r1"
				markApprovedByDefault
				onClose={vi.fn()}
			/>
		);
		expect(screen.getByText(/requester sees this reason/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("checkbox", { name: /Mark request approved/ }));
		expect(screen.queryByText(/requester sees this reason/)).toBeNull();
	});
});
