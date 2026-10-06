import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
	ARM_GUARD_MS,
	armedAnnouncement,
	technicianMenuGroups,
	useArmedConfirm,
	type TechnicianActionContext,
} from "../technicianActions";
import { NO_PERMISSION } from "../../lifecycle/actionBuilder";

const ctx = (over: Partial<TechnicianActionContext> = {}): TechnicianActionContext => ({
	name: "Maria Rodriguez",
	canManage: true,
	mfaEnabled: true,
	activeVisitCount: 0,
	deactivated: false,
	armed: null,
	pending: { resetPassword: false, resetMfa: false, delete: false, toggleActive: false },
	on: {
		edit: vi.fn(),
		"reset-password": vi.fn(),
		"reset-mfa": vi.fn(),
		deactivate: vi.fn(),
		reactivate: vi.fn(),
		delete: vi.fn(),
	},
	...over,
});

const items = (c: TechnicianActionContext) => technicianMenuGroups(c).flatMap((g) => g.items);

describe("technicianMenuGroups", () => {
	const cases: Partial<TechnicianActionContext>[] = [
		{},
		{ canManage: false },
		{ mfaEnabled: false },
		{ activeVisitCount: 2 },
		{ armed: "delete" },
	];

	it.each(cases)("same five items in the same order for %o", (over) => {
		expect(items(ctx(over)).map((i) => i.id)).toEqual([
			"edit",
			"reset-password",
			"reset-mfa",
			"deactivate",
			"delete",
		]);
	});

	it("shows Reactivate in place of Deactivate for an inactive technician", () => {
		const ids = items(ctx({ deactivated: true })).map((i) => i.id);
		expect(ids).toContain("reactivate");
		expect(ids).not.toContain("deactivate");
	});

	it("deactivate is two-step and its armed label states the effect", () => {
		const item = items(ctx({ armed: "deactivate" })).find((i) => i.id === "deactivate")!;
		expect(item.label).toBe("Press again: signs out, removes from scheduling");
		expect(item.keepOpen).toBe(true);
	});

	it("deactivate is blocked by open visits with the same reason as delete", () => {
		const item = items(ctx({ activeVisitCount: 2 })).find((i) => i.id === "deactivate")!;
		expect(item.disabled).toBe(true);
		expect(item.disabledReason).toBe("Maria Rodriguez has 2 active visits. Complete or reassign them first.");
	});

	it.each(cases)("every disabled item carries a reason for %o", (over) => {
		for (const item of items(ctx(over))) {
			if (item.disabled) expect(item.disabledReason?.length).toBeGreaterThan(0);
		}
	});

	it("uses the shared permission string without manage_technicians", () => {
		for (const item of items(ctx({ canManage: false }))) {
			expect(item.disabled).toBe(true);
			expect(item.disabledReason).toBe(NO_PERMISSION);
		}
	});

	it("explains MFA reset when MFA is off", () => {
		const mfa = items(ctx({ mfaEnabled: false })).find((i) => i.id === "reset-mfa")!;
		expect(mfa.disabledReason).toBe("MFA isn't enabled for this technician.");
	});

	it("names the blocking visits on delete", () => {
		const del = items(ctx({ activeVisitCount: 2 })).find((i) => i.id === "delete")!;
		expect(del.disabled).toBe(true);
		expect(del.disabledReason).toBe(
			"Maria Rodriguez has 2 active visits. Complete or reassign them first."
		);
		const one = items(ctx({ activeVisitCount: 1 })).find((i) => i.id === "delete")!;
		expect(one.disabledReason).toContain("1 active visit.");
	});

	it("delete is destructive and two-step", () => {
		const del = items(ctx()).find((i) => i.id === "delete")!;
		expect(del.intent).toBe("destructive");
		expect(del.keepOpen).toBe(true);
		expect(del.label).toBe("Delete Technician");
		expect(items(ctx({ armed: "delete" })).find((i) => i.id === "delete")!.label).toBe(
			"Press again to delete"
		);
	});

	it("shows pending labels", () => {
		const c = ctx({
			pending: { resetPassword: true, resetMfa: false, delete: false, toggleActive: false },
		});
		const rp = items(c).find((i) => i.id === "reset-password")!;
		expect(rp.label).toBe("Sending…");
		expect(rp.disabled).toBe(true);
	});
});

describe("armedAnnouncement", () => {
	it("names the technician the armed action falls on", () => {
		expect(armedAnnouncement("delete", "Maria Rodriguez")).toBe(
			"Press again to delete Maria Rodriguez"
		);
		expect(armedAnnouncement(null, "Maria Rodriguez")).toBe("");
		expect(armedAnnouncement("deactivate", "Maria")).toBe("Press again to deactivate Maria");
	});
});

describe("useArmedConfirm", () => {
	afterEach(() => vi.useRealTimers());

	const press = (
		h: { current: ReturnType<typeof useArmedConfirm> },
		run: () => Promise<void>
	) => act(() => h.current.confirm("delete", run)());

	it("ignores a second press inside the guard window", () => {
		vi.useFakeTimers();
		const run = vi.fn(async () => {});
		const { result } = renderHook(() => useArmedConfirm());
		press(result, run);
		expect(result.current.armed).toBe("delete");
		vi.advanceTimersByTime(ARM_GUARD_MS - 50);
		press(result, run);
		expect(run).not.toHaveBeenCalled();
		expect(result.current.armed).toBe("delete");
	});

	it("fires on a second press after the guard window", () => {
		vi.useFakeTimers();
		const run = vi.fn(async () => {});
		const { result } = renderHook(() => useArmedConfirm());
		press(result, run);
		vi.advanceTimersByTime(ARM_GUARD_MS);
		press(result, run);
		expect(run).toHaveBeenCalledTimes(1);
		expect(result.current.armed).toBeNull();
	});
});
