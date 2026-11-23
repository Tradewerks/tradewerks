import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { purchaseFlagText } from "./purchaseFlagText";

describe("purchaseFlagText", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("shows flags without vars as saved", async () => {
		await i18n.changeLanguage("es");
		expect(purchaseFlagText({ code: "geo_missing", message: "Old text" })).toBe("Old text");
	});

	it("picks the variant and formats money", async () => {
		await i18n.changeLanguage("es");
		expect(
			purchaseFlagText({
				code: "limit_breach",
				message: "x",
				vars: { variant: "daily", limit: 500, would_be: 640 },
			}),
		).toBe("Supera el límite diario de $500.00 ($640.00)");
	});

	it("adds who it was, and matches the saved English", () => {
		const message = "Closely matches an existing 120.00 purchase from Ferguson by Maria Lopez";
		expect(
			purchaseFlagText({
				code: "duplicate_suspected",
				message,
				vars: { variant: "near", total: 120, vendor: "Ferguson", by: "Maria Lopez" },
			}),
		).toBe("Closely matches an existing $120.00 purchase from Ferguson by Maria Lopez");
	});
});
