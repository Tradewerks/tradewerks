import { test, expect } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * Phase 6: a customer approves a quote from its public link on a phone, and the
 * dispatcher sees it Approved.
 *
 * The seed does not create public links, so the run supplies one: send a seeded
 * quote to a client (Quote page > Send) with the customer_comms module on, and
 * pass the link token and the quote id. Approval is one-way, so each run needs a
 * freshly sent quote.
 *   E2E_QUOTE_TOKEN     the link token (the part after /app/c/)
 *   E2E_QUOTE_ID        the quote the link belongs to
 */
const TOKEN = process.env.E2E_QUOTE_TOKEN;
const QUOTE_ID = process.env.E2E_QUOTE_ID;

test.skip(!TOKEN || !QUOTE_ID, "set E2E_QUOTE_TOKEN and E2E_QUOTE_ID");

test.use({ viewport: { width: 390, height: 844 } });

test("a customer approves a quote from its link on a phone and the dispatcher sees it Approved", async ({
	page,
}) => {
	await page.goto(`/app/c/${TOKEN}`);

	const approve = page.getByRole("button", { name: "Approve quote" });
	await expect(approve).toBeVisible();
	await expect(approve).toBeDisabled();
	// Phone layout: the page never scrolls sideways.
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
	).toBe(true);

	await page.getByLabel("Your full name").fill("Pat Playwright");
	await approve.click();
	await expect(page.getByRole("status")).toContainText("Approved by Pat Playwright on");
	await expect(page.getByRole("button", { name: "Approve quote" })).toHaveCount(0);

	await loginAsDispatcher(page);
	await page.goto(`/app/dispatch/quotes/${QUOTE_ID}`);
	await expect(page.locator("main").getByText("Approved").first()).toBeVisible({
		timeout: 15000,
	});
});
