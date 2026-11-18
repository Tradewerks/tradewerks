import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
    process.env.POSTMARK_FROM_EMAIL ??= "test@t.test";
    process.env.POSTMARK_API_KEY ??= "test-key";
});
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../wasabiService.js", () => ({ signImageUrl: vi.fn() }));

import { contactLine } from "../emailService.js";
import type { OrgBrand } from "../emailBranding.js";

const brand = (over: Partial<OrgBrand>): OrgBrand => ({
    name: "Acme",
    logo_url: null,
    color: "#111111",
    address: null,
    phone: null,
    website: null,
    reply_to: null,
    ...over,
});
const args = ["reply.", "call at", "contact us."] as const;

describe("contactLine", () => {
    it("escapes HTML in the phone", () => {
        const out = contactLine(brand({ phone: "<b>1</b>" }), ...args);
        expect(out).toBe("call at &lt;b&gt;1&lt;/b&gt;.");
    });

    it("prefers reply text, then phone, then a complete fallback sentence", () => {
        expect(contactLine(brand({ reply_to: "a@b.com", phone: "5" }), ...args)).toBe("reply.");
        expect(contactLine(brand({ phone: "5" }), ...args)).toBe("call at 5.");
        expect(contactLine(brand({}), ...args)).toBe("contact us.");
    });
});
