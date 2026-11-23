import { expect, test } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

// Needs a migrated dev stack where the org has the customer_comms module on.
test("an event toggled on and a template edit both survive a reload", async ({ page }) => {
	await loginAsDispatcher(page);
	await page.goto("/dispatch/admin?tab=customer_messages");

	const email = page.getByRole("switch", { name: "Email — Visit confirmed" });
	await expect(email).toBeVisible();
	// Start from a known state so the test is repeatable.
	if ((await email.getAttribute("aria-checked")) === "true") {
		await email.click();
		await expect(email).toHaveAttribute("aria-checked", "false");
	}
	await email.click();
	await expect(email).toHaveAttribute("aria-checked", "true");

	const row = page.locator("li", { hasText: "Visit confirmed" }).first();
	await row.getByRole("button", { name: "Edit message" }).click();
	const subject = `Confirmed ${Date.now()}`;
	await page.getByPlaceholder(/Following up/).fill(subject);
	await page.getByRole("button", { name: "Save Template" }).click();
	await expect(page.getByRole("button", { name: "Save Template" })).toBeHidden();

	await page.reload();
	await expect(page.getByRole("switch", { name: "Email — Visit confirmed" })).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await page
		.locator("li", { hasText: "Visit confirmed" })
		.first()
		.getByRole("button", { name: "Edit message" })
		.click();
	await expect(page.getByPlaceholder(/Following up/)).toHaveValue(subject);

	// Put the dev org back: reset the template and switch the event off.
	page.once("dialog", (d) => d.accept());
	await page.getByRole("button", { name: "Reset to default" }).click();
	await expect(page.getByRole("button", { name: "Reset to default" })).toBeHidden();
	await page.getByRole("switch", { name: "Email — Visit confirmed" }).click();
});
