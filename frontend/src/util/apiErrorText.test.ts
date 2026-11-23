import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { apiErrorText } from "./util";

describe("apiErrorText", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("keeps the API's message in English", () => {
		expect(apiErrorText({ code: "FORBIDDEN", message: "Only dispatchers can review corrections" })).toBe(
			"Only dispatchers can review corrections",
		);
	});

	it("translates fixed-meaning codes in Spanish", async () => {
		await i18n.changeLanguage("es");
		expect(apiErrorText({ code: "FORBIDDEN", message: "No" })).toBe("No tienes acceso a esto");
	});

	it("keeps the specific English message for codes without a key", async () => {
		await i18n.changeLanguage("es");
		expect(apiErrorText({ code: "VALIDATION_ERROR", message: "Quantity must be positive" })).toBe(
			"Quantity must be positive",
		);
	});
});
