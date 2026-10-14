import { describe, expect, it } from "vitest";
import { canSeeWidget, DISPUTE_VIEW_PERMISSIONS, hasAnyPermission } from "../permissionGates";

const user = (role: string, permissions: string[]) => ({ role, permissions });

describe("hasAnyPermission", () => {
	it("is false with no user", () => {
		expect(hasAnyPermission(null, ["view_quotes"])).toBe(false);
	});
	it("admin passes regardless of permissions", () => {
		expect(hasAnyPermission(user("admin", []), ["view_quotes"])).toBe(true);
	});
	it("passes when any listed permission is held", () => {
		expect(hasAnyPermission(user("dispatcher", ["view_invoices"]), DISPUTE_VIEW_PERMISSIONS)).toBe(true);
	});
	it("fails when none is held", () => {
		expect(hasAnyPermission(user("dispatcher", ["view_jobs"]), DISPUTE_VIEW_PERMISSIONS)).toBe(false);
	});
});

describe("canSeeWidget", () => {
	const dispatcher = (permissions: string[]) => ({ role: "dispatcher", permissions });

	it("an ungated widget is visible to anyone, even with no user", () => {
		expect(canSeeWidget(null, {})).toBe(true);
	});
	it("an unknown widget id is not visible", () => {
		expect(canSeeWidget(dispatcher([]), undefined)).toBe(false);
	});
	it("requiredPermission needs that exact grant", () => {
		expect(canSeeWidget(dispatcher(["view_reports"]), { requiredPermission: "view_reports" })).toBe(true);
		expect(canSeeWidget(dispatcher([]), { requiredPermission: "view_reports" })).toBe(false);
	});
	it("requiredAnyPermission needs one of the grants", () => {
		const entry = { requiredAnyPermission: ["view_quotes", "view_invoices"] };
		expect(canSeeWidget(dispatcher(["view_invoices"]), entry)).toBe(true);
		expect(canSeeWidget(dispatcher(["view_jobs"]), entry)).toBe(false);
	});
	it("admin sees every gated widget", () => {
		expect(canSeeWidget({ role: "admin", permissions: [] }, { requiredAnyPermission: ["view_quotes"] })).toBe(true);
	});
});
