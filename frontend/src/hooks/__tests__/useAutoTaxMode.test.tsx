import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAutoTaxMode } from "../useAutoTaxMode";

const org = vi.hoisted(() => ({ data: undefined as { tax_mode: string } | undefined }));
const mod = vi.hoisted(() => ({ on: true, loaded: true }));
vi.mock("../useOrg", () => ({ useOrgSettings: () => ({ data: org.data }) }));
vi.mock("../useEntitlements", () => ({
	useEntitlements: () => ({ data: mod.loaded ? {} : undefined }),
	useModuleOn: () => mod.on,
}));

describe("useAutoTaxMode", () => {
	it("is undefined while the org loads", () => {
		org.data = undefined;
		expect(renderHook(() => useAutoTaxMode()).result.current).toBeUndefined();
	});
	it("is undefined while entitlements load", () => {
		org.data = { tax_mode: "auto" };
		mod.loaded = false;
		expect(renderHook(() => useAutoTaxMode()).result.current).toBeUndefined();
		mod.loaded = true;
	});
	it("is true only when stored auto and the module is on", () => {
		org.data = { tax_mode: "auto" };
		mod.on = true;
		expect(renderHook(() => useAutoTaxMode()).result.current).toBe(true);
	});
	it("treats stored auto with the module off as manual (server taxes it as manual)", () => {
		org.data = { tax_mode: "auto" };
		mod.on = false;
		expect(renderHook(() => useAutoTaxMode()).result.current).toBe(false);
		mod.on = true;
	});
	it("is false in manual mode", () => {
		org.data = { tax_mode: "manual" };
		expect(renderHook(() => useAutoTaxMode()).result.current).toBe(false);
	});
});
