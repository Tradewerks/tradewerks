import { Page, expect } from "@playwright/test";

/**
 * Seed accounts (backend/prisma/seed.ts). Override with env vars when running
 * against a non-seeded database.
 */
export const DISPATCHER_CREDENTIALS = {
	email: process.env.E2E_DISPATCHER_EMAIL ?? "admin@epichvac.com",
	password: process.env.E2E_DISPATCHER_PASSWORD ?? "password123",
};

export const TECHNICIAN_CREDENTIALS = {
	email: process.env.E2E_TECHNICIAN_EMAIL ?? "john.smith@epichvac.com",
	password: process.env.E2E_TECHNICIAN_PASSWORD ?? "password123",
};

type Credentials = { email: string; password: string };

// LoginPage (src/auth/LoginPage.tsx) is an email + password form; there is no
// name/role picker any more. The app stores the session in localStorage, so a
// successful login is observable as the post-login redirect.
async function submitLogin(page: Page, { email, password }: Credentials) {
	await page.goto("/app/login");
	await expect(page.locator('button[type="submit"]')).toBeVisible();
	await page.fill('input[placeholder="Email"]', email);
	await page.fill('input[placeholder="Password"]', password);
	await page.click('button[type="submit"]');
}

export async function loginAsDispatcher(page: Page, credentials: Credentials = DISPATCHER_CREDENTIALS) {
	await submitLogin(page, credentials);
	await page.waitForURL(/\/dispatch(\/|\?|$)/, { timeout: 15000 });
	await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
}

export async function loginAsTechnician(page: Page, credentials: Credentials = TECHNICIAN_CREDENTIALS) {
	await submitLogin(page, credentials);
	await page.waitForURL(/\/technician(\/|\?|$)/, { timeout: 15000 });
	await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
}
