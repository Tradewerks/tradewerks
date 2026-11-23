import { describe, it, expect, vi } from "vitest";

const { rootDb } = vi.hoisted(() => ({
    rootDb: { organization: { findUnique: vi.fn() } },
}));

vi.mock("../../db.js", () => ({ db: rootDb }));
vi.mock("../wasabiService.js", () => ({
    signImageUrl: vi.fn(async () => null),
}));

import { getOrgBrand } from "../emailBranding.js";
import { DEFAULT_TEMPLATES } from "../followupTemplateDefaults.js";
import { renderTemplate } from "../templateRenderer.js";
import { DEFAULT_NOTIFICATION_TEMPLATES } from "../customerComms/templateDefaults.js";

const org = (email: string | null) => ({
    name: "Acme",
    logo_url: null,
    brand_color: null,
    address: null,
    phone: "555-0100",
    website: null,
    email,
});

describe("getOrgBrand", () => {
    it("getOrgBrand returns reply_to from a valid org email and null from a malformed one", async () => {
        rootDb.organization.findUnique.mockResolvedValueOnce(
            org("office@acme.com"),
        );
        expect((await getOrgBrand("o1")).reply_to).toBe("office@acme.com");

        rootDb.organization.findUnique.mockResolvedValueOnce(org("not-an-email"));
        expect((await getOrgBrand("o1")).reply_to).toBeNull();

        rootDb.organization.findUnique.mockResolvedValueOnce(org(null));
        expect((await getOrgBrand("o1")).reply_to).toBeNull();
    });
});

describe("review link", () => {
    it("the review request's default email and text carry the org's review link", async () => {
        rootDb.organization.findUnique.mockResolvedValueOnce({
            ...org(null),
            review_url: "https://g.page/r/acme/review",
        });
        const brand = await getOrgBrand("o1");
        expect(brand.review_url).toBe("https://g.page/r/acme/review");
        const t = DEFAULT_NOTIFICATION_TEMPLATES.review_request;
        const model = { brand, client_name: "Bo" };
        for (const body of [t.html, t.text, t.sms])
            expect(renderTemplate(body, model, { escape: false })).toContain(
                "https://g.page/r/acme/review",
            );
    });
});

describe("default templates", () => {
    it('default templates say "reply to this email" only when brand.reply_to is set, otherwise show brand.phone', () => {
        const withReply = {
            brand: { name: "Acme", phone: "555-0100", reply_to: "a@acme.com" },
            client_name: "Bo",
        };
        const noReply = {
            brand: { name: "Acme", phone: "555-0100", reply_to: null },
            client_name: "Bo",
        };
        for (const [cat, t] of Object.entries(DEFAULT_TEMPLATES)) {
            if (cat === "custom") continue;
            for (const body of [t.html, t.text ?? ""]) {
                if (!/reply/i.test(body)) continue;
                expect(renderTemplate(body, withReply), cat).toMatch(
                    /reply to this email/i,
                );
                const without = renderTemplate(body, noReply);
                expect(without, cat).not.toMatch(/reply to this email/i);
                expect(without, cat).toContain("555-0100");
            }
        }
    });

    it("default templates have no dangling stems when neither reply_to nor phone is set", () => {
        const model = {
            brand: { name: "Acme", phone: null, reply_to: null },
            client_name: "Bo",
        };
        for (const [cat, t] of Object.entries(DEFAULT_TEMPLATES)) {
            if (cat === "custom") continue;
            const bodies = [
                renderTemplate(t.text ?? "", model),
                renderTemplate(t.html, model).replace(/<[^>]*>/g, "\n"),
            ];
            for (const raw of bodies) {
                const out = raw.replace(/^(Hi .*|Thanks),$/gm, "");
                expect(out, cat).not.toMatch(/,[ \t]*(\n|$)/);
                expect(out, cat).not.toMatch(/,[ \t]*\u2014/);
                expect(out, cat).not.toMatch(/,[ \t]*\./);
            }
        }
    });
});
