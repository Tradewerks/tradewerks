import { test, expect, Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

function attachGuards(page: Page) {
	page.on("pageerror", (err) => {
		throw err;
	});
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			console.error(`[browser console error] ${msg.text()}`);
		}
	});
}

async function navigateToJobsPage(page: Page) {
	await page.click('a[href="/app/dispatch/jobs"]');
	await page.waitForURL("/app/dispatch/jobs", { timeout: 10000 });
	await expect(page.locator('h2:has-text("Jobs")')).toBeVisible({ timeout: 10000 });
}

async function switchToRecurringPlansView(page: Page) {
	const recurringPlansButton = page.locator('button:has-text("Recurring Plans")');
	await expect(recurringPlansButton).toBeVisible({ timeout: 10000 });
	await recurringPlansButton.click();
	await page.waitForURL(/view=templates/, { timeout: 10000 });
}

async function openCreateRecurringPlanModal(page: Page) {
	const newPlanButton = page.locator('button:has-text("New Recurring Plan")');
	await expect(newPlanButton).toBeVisible({ timeout: 10000 });
	await newPlanButton.click();
	await expect(page.locator("text=Create New Recurring Plan")).toBeVisible({
		timeout: 10000,
	});
}

async function openActionsMenu(page: Page) {
	const actionsButton = page.locator('[data-testid="recurring-plan-actions-menu"]');
	await expect(actionsButton).toBeVisible({ timeout: 10000 });
	await actionsButton.click();
	await expect(page.locator('button:has-text("Edit Plan")')).toBeVisible({ timeout: 5000 });
}

test.describe.configure({ mode: "serial" });

test.describe("Recurring Plans E2E - Navigation Flow", () => {
	let sharedPage: Page;

	test.beforeAll(async ({ browser }) => {
		const context = await browser.newContext();
		sharedPage = await context.newPage();
		attachGuards(sharedPage);
		await loginAsDispatcher(sharedPage);
	});

	test.afterAll(async () => {
		await sharedPage.close();
	});

	test.beforeEach(async () => {
		// Close any open modals
		const cancelButton = sharedPage.locator('button:has-text("Cancel")');
		if (await cancelButton.isVisible()) {
			await cancelButton.click();
			await sharedPage.waitForTimeout(500);
		}

		// Re-login if needed
		if (sharedPage.url().includes("/login")) {
			await loginAsDispatcher(sharedPage);
		}

		// Navigate to dispatch if not there
		if (!sharedPage.url().includes("/app/dispatch")) {
			await sharedPage.goto("/app/dispatch", { waitUntil: "domcontentloaded" });
		}

		// Verify dispatch shell is loaded
		await expect(sharedPage.locator("text=Dispatch Demo")).toBeVisible({
			timeout: 10000,
		});
	});

	test("should complete login flow and navigate to dashboard", async () => {
		await expect(sharedPage.locator("text=Dispatch Demo")).toBeVisible();
		await expect(sharedPage.locator('a[href="/app/dispatch/jobs"]')).toBeVisible();
		await expect(sharedPage.locator('a[href="/app/dispatch"]')).toBeVisible();
		await expect(sharedPage.locator("text=Online Now")).toBeVisible();
	});

	test("should navigate from dashboard to jobs page", async () => {
		await navigateToJobsPage(sharedPage);

		await expect(sharedPage).toHaveURL("/app/dispatch/jobs");
		await expect(sharedPage.locator('h2:has-text("Jobs")')).toBeVisible();
		await expect(sharedPage.locator('button:has-text("Jobs")')).toBeVisible();
		await expect(
			sharedPage.locator('button:has-text("Recurring Plans")')
		).toBeVisible();
	});

	test("should switch to recurring plans view on jobs page", async () => {
		await navigateToJobsPage(sharedPage);
		await switchToRecurringPlansView(sharedPage);

		expect(sharedPage.url()).toContain("view=templates");

		const recurringPlansButton = sharedPage.locator(
			'button:has-text("Recurring Plans")'
		);
		await expect(recurringPlansButton).toHaveClass(/bg-blue-600/);
	});

	test("should open create recurring plan modal from jobs page", async () => {
		await navigateToJobsPage(sharedPage);
		await openCreateRecurringPlanModal(sharedPage);

		await expect(sharedPage.locator("text=Plan Name")).toBeVisible();
		await expect(sharedPage.locator("text=Schedule Configuration")).toBeVisible();
		await expect(sharedPage.locator("text=Recurring Schedule")).toBeVisible();
		await expect(sharedPage.locator("text=Line Items")).toBeVisible();
		await expect(sharedPage.locator("text=Billing Configuration")).toBeVisible();
	});

	test("should show validation errors when submitting empty create form", async () => {
		await navigateToJobsPage(sharedPage);
		await openCreateRecurringPlanModal(sharedPage);

		await sharedPage.click('button:has-text("Create Recurring Plan")');

		await expect(sharedPage.locator("text=/required/i").first()).toBeVisible({
			timeout: 5000,
		});
	});

	test("should navigate to recurring plan detail page by clicking on a plan", async () => {
		await navigateToJobsPage(sharedPage);
		await switchToRecurringPlansView(sharedPage);

		const firstPlanRow = sharedPage.locator("table tbody tr").first();

		if ((await firstPlanRow.count()) > 0) {
			await firstPlanRow.click();

			await sharedPage.waitForURL(/\/dispatch\/recurring-plans\/[^/]+$/, {
				timeout: 10000,
			});

			await expect(sharedPage.locator("text=Plan Information")).toBeVisible();
			await expect(sharedPage.locator("text=Client Details")).toBeVisible();
			await expect(sharedPage.locator("text=Template Pricing")).toBeVisible();
			await expect(sharedPage.locator("text=Upcoming Occurrences")).toBeVisible();
		} else {
			test.skip(true, "No recurring plans exist");
		}
	});

	test("should open actions menu on recurring plan detail page", async () => {
		await navigateToJobsPage(sharedPage);
		await switchToRecurringPlansView(sharedPage);

		const firstPlanRow = sharedPage.locator("table tbody tr").first();

		if ((await firstPlanRow.count()) > 0) {
			await firstPlanRow.click();
			await sharedPage.waitForURL(/\/dispatch\/recurring-plans\/[^/]+$/, {
				timeout: 10000,
			});

			await openActionsMenu(sharedPage);

			await expect(
				sharedPage.locator('button:has-text("Edit Plan")')
			).toBeVisible();

			// Check for action buttons based on plan status
			const generateButton = sharedPage.locator(
				'button:has-text("Generate Occurrences")'
			);
			const pauseButton = sharedPage.locator('button:has-text("Pause Plan")');
			const resumeButton = sharedPage.locator('button:has-text("Resume Plan")');

			const hasAction =
				(await generateButton.count()) > 0 ||
				(await pauseButton.count()) > 0 ||
				(await resumeButton.count()) > 0;

			expect(hasAction).toBeTruthy();
		} else {
			test.skip(true, "No recurring plans exist");
		}
	});
});
