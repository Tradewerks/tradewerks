import { test, expect } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * Phase 2 close-out for customer auto-comms: a customer unsubscribes from a
 * public link and the dispatcher sees it on the client's contact card.
 *
 * The seed does not create public links, so the run supplies one: issue an
 * unsubscribe link for a seeded contact and pass its token and client id.
 *   E2E_UNSUBSCRIBE_TOKEN      the link token (the part after /app/c/)
 *   E2E_UNSUBSCRIBE_CLIENT_ID  the client the contact is linked to
 */
const TOKEN = process.env.E2E_UNSUBSCRIBE_TOKEN;
const CLIENT_ID = process.env.E2E_UNSUBSCRIBE_CLIENT_ID;

test.skip(
	!TOKEN || !CLIENT_ID,
	"set E2E_UNSUBSCRIBE_TOKEN and E2E_UNSUBSCRIBE_CLIENT_ID",
);

test("an unsubscribe link unsubscribes the contact and the client page shows it", async ({
	page,
}) => {
	await page.goto(`/app/c/${TOKEN}`);

	// Start from a known state so the run can be repeated.
	const resubscribe = page.getByRole("button", { name: "Resubscribe" });
	if (await resubscribe.isVisible().catch(() => false)) {
		await resubscribe.click();
	}

	await page.getByRole("button", { name: "Unsubscribe" }).click();
	await expect(page.getByRole("status")).toContainText("You are unsubscribed");

	await loginAsDispatcher(page);
	await page.goto(`/app/dispatch/clients/${CLIENT_ID}`);
	await expect(page.getByText("Unsubscribed (unsubscribe link)")).toBeVisible({
		timeout: 15000,
	});

	// Leave the contact subscribed for the next run.
	await page.goto(`/app/c/${TOKEN}`);
	await page.getByRole("button", { name: "Resubscribe" }).click();
	await expect(page.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
});
