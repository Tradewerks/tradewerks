import { act, renderHook } from "@testing-library/react";
import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgDetail } from "../types";

// Hoisted and stable: a fresh fn per render would look like a new dependency every time.
const h = vi.hoisted(() => ({
	mutateAsync: vi.fn(),
	refetchOrg: vi.fn(),
	refetchPreview: vi.fn(),
}));
vi.mock("../hooks", () => ({
	useOrg: () => ({ refetch: h.refetchOrg }),
	useApplyChanges: () => ({ mutateAsync: h.mutateAsync, isPending: false, error: null }),
	usePreviewChanges: () => ({
		data: undefined,
		isFetching: false,
		error: null,
		refetch: h.refetchPreview,
	}),
}));

import { usePlanDraft } from "../usePlanDraft";

const detail = {
	org: { id: "org-1", name: "Acme" },
	entitlement: {
		plan_version_id: "pv-2",
		plan_source: "operator",
		template_key: "hvac",
		trial_plan_version_id: null,
		trial_ends_at: null,
		module_choices: {},
		module_grants: { quickbooks: "off" },
		limit_overrides: {},
		updated_at: "2026-10-08T00:00:00.000Z",
	},
} as unknown as OrgDetail;

const conflict = (code: string) =>
	new AxiosError("409", "ERR", undefined, undefined, {
		status: 409,
		data: { error: { code, message: "x" } },
		statusText: "",
		headers: {},
		config: { headers: new AxiosHeaders() },
	});

const setup = () => renderHook(() => usePlanDraft("org-1", detail));

beforeEach(() => {
	h.mutateAsync.mockReset();
	h.refetchOrg.mockReset();
	h.refetchPreview.mockReset();
});

describe("usePlanDraft", () => {
	it("drops draft entries the stored row now already has (another save landed)", () => {
		const { result, rerender } = renderHook(({ d }) => usePlanDraft("org-1", d), {
			initialProps: { d: detail },
		});
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.setTier("pv-3"));
		const moved = {
			...detail,
			entitlement: {
				...detail.entitlement!,
				module_grants: { quickbooks: "off", inventory: "on" },
				updated_at: "2026-10-08T01:00:00.000Z",
			},
		} as OrgDetail;
		rerender({ d: moved });
		expect(result.current.changes).toEqual([{ kind: "plan", planVersionId: "pv-3" }]);
		rerender({
			d: {
				...moved,
				entitlement: { ...moved.entitlement!, plan_version_id: "pv-3" },
			} as OrgDetail,
		});
		expect(result.current.state).toBeNull();
		expect(result.current.changes).toEqual([]);
	});

	it("a later save clears the conflict flag", async () => {
		h.mutateAsync.mockRejectedValueOnce(conflict("CONFLICT"));
		h.refetchOrg.mockResolvedValue({ data: { entitlement: { updated_at: "x" } } });
		const { result } = setup();
		act(() => result.current.setTier("pv-3"));
		await act(async () => {
			await result.current.save("Customer asked");
		});
		expect(result.current.conflict).toBe(true);
		h.mutateAsync.mockRejectedValueOnce(new Error("boom"));
		await act(async () => {
			await result.current.save("Customer asked");
		});
		expect(result.current.conflict).toBe(false);
	});

	it("starts with no draft", () => {
		const { result } = setup();
		expect(result.current.state).toBeNull();
		expect(result.current.changes).toEqual([]);
	});

	it("a tier pick creates a draft stamped with the page's version", () => {
		const { result } = setup();
		act(() => result.current.setTier("pv-3"));
		expect(result.current.state).toMatchObject({
			planVersionId: "pv-3",
			stamp: "2026-10-08T00:00:00.000Z",
		});
		expect(result.current.changes).toEqual([{ kind: "plan", planVersionId: "pv-3" }]);
	});

	it("picking the current tier again is no draft", () => {
		const { result } = setup();
		act(() => result.current.setTier("pv-2"));
		expect(result.current.state).toBeNull();
	});

	it("toggling back to the stored value drops the module; an empty draft is null", () => {
		const { result } = setup();
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.setGrant("quickbooks", null));
		expect(result.current.changes).toHaveLength(2);
		act(() => result.current.setGrant("quickbooks", "off"));
		expect(result.current.changes).toEqual([
			{ kind: "grant", module: "inventory", grant: "on" },
		]);
		act(() => result.current.setGrant("inventory", null));
		expect(result.current.state).toBeNull();
	});

	it("lists the tier change first, then grants in the order they were made", () => {
		const { result } = setup();
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.setTier("pv-3"));
		act(() => result.current.setGrant("fleet", "off"));
		expect(result.current.changes).toEqual([
			{ kind: "plan", planVersionId: "pv-3" },
			{ kind: "grant", module: "inventory", grant: "on" },
			{ kind: "grant", module: "fleet", grant: "off" },
		]);
	});

	it("seed merges a request part into the draft and remembers the request", () => {
		const { result } = setup();
		act(() => result.current.setGrant("inventory", "on"));
		act(() =>
			result.current.seed(
				{ kind: "plan", planVersionId: "pv-3" },
				{ requestId: "r-1" }
			)
		);
		expect(result.current.state).toMatchObject({
			planVersionId: "pv-3",
			requestId: "r-1",
		});
		expect(result.current.changes).toHaveLength(2);
	});

	it("discard clears the draft", () => {
		const { result } = setup();
		act(() => result.current.setTier("pv-3"));
		act(() => result.current.discard());
		expect(result.current.state).toBeNull();
	});

	it("save sends the changes, the reason, the stamp and the request id, then clears", async () => {
		h.mutateAsync.mockResolvedValue({});
		const { result } = setup();
		act(() => result.current.setTier("pv-3"));
		let out: unknown;
		await act(async () => {
			out = await result.current.save("Customer asked", "r-1");
		});
		expect(h.mutateAsync).toHaveBeenCalledWith({
			changes: [{ kind: "plan", planVersionId: "pv-3" }],
			reason: "Customer asked",
			expectedUpdatedAt: "2026-10-08T00:00:00.000Z",
			upgradeRequestId: "r-1",
		});
		expect(out).toMatchObject({ status: "saved" });
		expect(result.current.state).toBeNull();
	});

	it("a 409 keeps the draft, takes the fresh stamp, re-previews and flags the conflict", async () => {
		h.mutateAsync.mockRejectedValue(conflict("CONFLICT"));
		h.refetchOrg.mockResolvedValue({
			data: { entitlement: { updated_at: "2026-10-08T01:00:00.000Z" } },
		});
		const { result } = setup();
		act(() => result.current.setTier("pv-3"));
		let out: unknown;
		await act(async () => {
			out = await result.current.save("Customer asked");
		});
		expect(out).toEqual({ status: "conflict" });
		expect(result.current.conflict).toBe(true);
		expect(result.current.state).toMatchObject({
			planVersionId: "pv-3",
			stamp: "2026-10-08T01:00:00.000Z",
		});
		expect(h.refetchPreview).toHaveBeenCalled();
	});

	it("a closed request is reported apart from a stale page", async () => {
		h.mutateAsync.mockRejectedValue(conflict("REQUEST_CLOSED"));
		const { result } = setup();
		act(() => result.current.setTier("pv-3"));
		let out: unknown;
		await act(async () => {
			out = await result.current.save("Customer asked", "r-1");
		});
		expect(out).toEqual({ status: "request_closed" });
		expect(result.current.conflict).toBe(false);
		expect(result.current.state).not.toBeNull();
	});

	const at = (d: OrgDetail, updated_at: string) =>
		({ ...d, entitlement: { ...d.entitlement!, updated_at } }) as OrgDetail;

	it("adopts the version a change-dialog save on this page produced", async () => {
		const { result, rerender } = renderHook(({ d }) => usePlanDraft("org-1", d), {
			initialProps: { d: detail },
		});
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.rebase(detail.entitlement!.updated_at));
		rerender({ d: at(detail, "2026-10-08T02:00:00.000Z") });
		h.mutateAsync.mockResolvedValue(undefined);
		await act(async () => {
			await result.current.save("Customer asked");
		});
		expect(h.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ expectedUpdatedAt: "2026-10-08T02:00:00.000Z" })
		);
	});

	it("keeps its old stamp when it was already behind before the dialog save", async () => {
		const { result, rerender } = renderHook(({ d }) => usePlanDraft("org-1", d), {
			initialProps: { d: detail },
		});
		act(() => result.current.setGrant("inventory", "on"));
		rerender({ d: at(detail, "2026-10-08T01:00:00.000Z") });
		act(() => result.current.rebase("2026-10-08T01:00:00.000Z"));
		rerender({ d: at(detail, "2026-10-08T02:00:00.000Z") });
		h.mutateAsync.mockResolvedValue(undefined);
		await act(async () => {
			await result.current.save("Customer asked");
		});
		expect(h.mutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({ expectedUpdatedAt: detail.entitlement!.updated_at })
		);
	});

	it("keeps the reason and the tick while the page re-renders", () => {
		const { result, rerender } = setup();
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.setReason("Customer asked"));
		act(() => result.current.setMarkApproved(true));
		rerender();
		expect(result.current.reason).toBe("Customer asked");
		expect(result.current.markApproved).toBe(true);
	});

	it("a request seeded into an open draft ticks the box", () => {
		const { result } = setup();
		act(() => result.current.setGrant("inventory", "on"));
		expect(result.current.markApproved).toBe(false);
		act(() =>
			result.current.seed({ kind: "plan", planVersionId: "pv-3" }, { requestId: "r-1" })
		);
		expect(result.current.markApproved).toBe(true);
	});

	it("a draft that vanished because the stored row caught up starts the next one clean", () => {
		const { result, rerender } = renderHook(({ d }) => usePlanDraft("org-1", d), {
			initialProps: { d: detail },
		});
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.setReason("Customer asked"));
		act(() => result.current.setMarkApproved(true));
		const caughtUp = {
			...detail,
			entitlement: {
				...detail.entitlement!,
				module_grants: { quickbooks: "off", inventory: "on" },
				updated_at: "2026-10-08T01:00:00.000Z",
			},
		} as OrgDetail;
		rerender({ d: caughtUp });
		expect(result.current.state).toBeNull();
		act(() => result.current.setTier("pv-3"));
		expect(result.current.reason).toBe("");
		expect(result.current.markApproved).toBe(false);
	});

	it("ending the draft clears the reason and the tick", () => {
		const { result } = setup();
		act(() => result.current.setGrant("inventory", "on"));
		act(() => result.current.setReason("Customer asked"));
		act(() => result.current.setMarkApproved(true));
		act(() => result.current.discard());
		act(() => result.current.setGrant("inventory", "on"));
		expect(result.current.reason).toBe("");
		expect(result.current.markApproved).toBe(false);
	});
});
