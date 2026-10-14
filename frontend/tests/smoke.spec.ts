import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * Route walk: every dispatch route in src/AppRoutes.tsx must render a non-empty
 * <main> with no uncaught page errors and no console errors. Detail routes use
 * the first row the corresponding list page links to, so the walk works against
 * any seeded database.
 *
 * Not executed in the PR #19 remediation pass (no backend available); written
 * from the route table and page markup.
 */

const LIST_ROUTES = [
	"/app/dispatch",
	"/app/dispatch/schedule",
	"/app/dispatch/clients",
	"/app/dispatch/jobs",
	"/app/dispatch/jobs?view=templates",
	"/app/dispatch/projects",
	"/app/dispatch/technicians",
	"/app/dispatch/map",
	"/app/dispatch/reporting",
	"/app/dispatch/reporting/builder",
	"/app/dispatch/reporting/aged-receivables",
	"/app/dispatch/reporting/job-backlog",
	"/app/dispatch/reporting/client-retention",
	"/app/dispatch/reporting/client-lifetime-value",
	"/app/dispatch/reporting/client-discounts",
	"/app/dispatch/reporting/profit-and-loss",
	"/app/dispatch/reporting/tax-liability",
	"/app/dispatch/reporting/payments",
	"/app/dispatch/reporting/quote-funnel",
	"/app/dispatch/reporting/revenue-by-line-item-type",
	"/app/dispatch/reporting/revenue-by-line-item-type/labor",
	"/app/dispatch/reporting/first-time-fix",
	"/app/dispatch/reporting/technician-scorecard",
	"/app/dispatch/reporting/field-added-revenue",
	"/app/dispatch/reporting/recurring-revenue",
	"/app/dispatch/kpi",
	"/app/dispatch/mileage",
	"/app/dispatch/timesheets",
	"/app/dispatch/inventory",
	"/app/dispatch/inventory/reorder-forecast",
	"/app/dispatch/quotes",
	"/app/dispatch/requests",
	"/app/dispatch/invoices",
	"/app/dispatch/profile",
	"/app/dispatch/admin",
	"/app/dispatch/followups",
	"/app/dispatch/vehicles",
];

/** List page → href prefix of its detail links. */
const DETAIL_FROM_LIST: Array<{ list: string; hrefPrefix: string }> = [
	{ list: "/app/dispatch/clients", hrefPrefix: "/app/dispatch/clients/" },
	{ list: "/app/dispatch/jobs", hrefPrefix: "/app/dispatch/jobs/" },
	{ list: "/app/dispatch/projects", hrefPrefix: "/app/dispatch/projects/" },
	{ list: "/app/dispatch/technicians", hrefPrefix: "/app/dispatch/technicians/" },
	{ list: "/app/dispatch/quotes", hrefPrefix: "/app/dispatch/quotes/" },
	{ list: "/app/dispatch/requests", hrefPrefix: "/app/dispatch/requests/" },
	{ list: "/app/dispatch/invoices", hrefPrefix: "/app/dispatch/invoices/" },
	{ list: "/app/dispatch/inventory", hrefPrefix: "/app/dispatch/inventory/items/" },
	{ list: "/app/dispatch/vehicles", hrefPrefix: "/app/dispatch/vehicles/" },
];

// Noise that is not an application error (third-party tiles, dev-only warnings).
const IGNORED_CONSOLE = [
	/mapbox/i,
	/Download the React DevTools/,
	/WebSocket connection/i,
	/net::ERR_/,
	/favicon/i,
];

function collectErrors(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg: ConsoleMessage) => {
		if (msg.type() !== "error") return;
		const text = msg.text();
		if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
		errors.push(`console.error: ${text}`);
	});
	return errors;
}

async function expectRouteRenders(page: Page, url: string, errors: string[]) {
	await page.goto(url);
	// Guards redirect to /dispatch or /login; the walk is run as a full-permission
	// admin, so the URL must stick.
	await expect(page).toHaveURL(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const main = page.locator("main");
	await expect(main).toBeVisible({ timeout: 15000 });
	// Let lazy chunks + first queries settle, then require real content.
	await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
	await expect
		.poll(async () => ((await main.textContent()) ?? "").trim().length, { timeout: 15000 })
		.toBeGreaterThan(0);
	expect(errors, `errors on ${url}:\n${errors.join("\n")}`).toEqual([]);
}

test.describe("dispatch route smoke walk", () => {
	test.describe.configure({ mode: "serial" });

	let page: Page;
	let errors: string[];

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		errors = collectErrors(page);
		await loginAsDispatcher(page);
	});

	test.afterAll(async () => {
		await page.close();
	});

	test.beforeEach(() => {
		errors.length = 0;
	});

	for (const url of LIST_ROUTES) {
		test(`renders ${url}`, async () => {
			await expectRouteRenders(page, url, errors);
		});
	}

	for (const { list, hrefPrefix } of DETAIL_FROM_LIST) {
		test(`renders first detail page linked from ${list}`, async () => {
			await page.goto(list);
			await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
			const link = page.locator(`main a[href^="${hrefPrefix}"]`).first();
			const row = page.locator("main table tbody tr").first();
			let target: string | null = null;
			if (await link.count()) {
				target = await link.getAttribute("href");
			} else if (await row.count()) {
				// AdaptableTable rows navigate on click rather than via <a>.
				await row.click();
				await page.waitForURL(new RegExp(`${hrefPrefix.replace(/\//g, "\\/")}[^/]+`), { timeout: 15000 });
				target = new URL(page.url()).pathname;
			}
			test.skip(!target, `no rows on ${list} in this database`);
			errors.length = 0;
			await expectRouteRenders(page, target!, errors);
		});
	}

	test("legacy inventory tracking URL redirects to the item detail page", async () => {
		await page.goto("/app/dispatch/inventory");
		await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
		const row = page.locator("main table tbody tr").first();
		test.skip(!(await row.count()), "no inventory rows in this database");
		await row.click();
		await page.waitForURL(/\/dispatch\/inventory\/items\/[^/]+/, { timeout: 15000 });
		const itemUrl = new URL(page.url()).pathname;
		await page.goto(`${itemUrl}/tracking`);
		await expect(page).toHaveURL(new RegExp(`${itemUrl.replace(/\//g, "\\/")}(\\?|$)`));
	});
});
