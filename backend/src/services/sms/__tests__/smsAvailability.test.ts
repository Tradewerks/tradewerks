import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirst = vi.hoisted(() => vi.fn());
const isModuleOn = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../entitlementService.js", () => ({ isModuleOn }));
vi.mock("../../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => ({ org_sms_account: { findFirst } })),
}));

import { isSmsActive, smsUnavailableReason } from "../smsAvailability.js";
import { getScopedDb } from "../../../lib/context.js";

beforeEach(() => findFirst.mockReset());

describe("isSmsActive", () => {
	it("is true only for an active account, read through the org's scoped db", async () => {
		findFirst.mockResolvedValueOnce({ status: "active" });
		expect(await isSmsActive("org-1")).toBe(true);
		expect(getScopedDb).toHaveBeenCalledWith("org-1");

		findFirst.mockResolvedValueOnce({ status: "campaign_pending" });
		expect(await isSmsActive("org-1")).toBe(false);
		findFirst.mockResolvedValueOnce(null);
		expect(await isSmsActive("org-1")).toBe(false);
	});
});

describe("smsUnavailableReason", () => {
	it("is sms_module_off while the module is off even with an active account, then sms_not_active, then null", async () => {
		findFirst.mockResolvedValue({ status: "active" });
		isModuleOn.mockResolvedValueOnce(false);
		expect(await smsUnavailableReason("org-1")).toBe("sms_module_off");
		expect(isModuleOn).toHaveBeenCalledWith("org-1", "sms");

		expect(await smsUnavailableReason("org-1")).toBeNull();
		findFirst.mockResolvedValue({ status: "suspended" });
		expect(await smsUnavailableReason("org-1")).toBe("sms_not_active");
	});
});
