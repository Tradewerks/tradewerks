import { test, expect, type Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

async function openTech(page: Page) {
	await page.goto("/dispatch/technicians");
	await page.getByRole("main").getByText(/Rodriguez/).first().click();
	await page.waitForURL(/\/dispatch\/technicians\/[^/?]+/);
}

const TABS = ["Overview", "Schedule", "Vehicle", "Access", "Activity"];

test.describe("technician detail", () => {
	test.beforeEach(async ({ page }) => loginAsDispatcher(page));

	test("frame, tabs and deep links", async ({ page }) => {
		await openTech(page);
		await expect(page.getByRole("button", { name: "Technician actions" })).toBeVisible();
		await expect(page.getByRole("tablist", { name: "Technician sections" })).toBeVisible();
		for (const tab of TABS.slice(1)) {
			await page.getByRole("tab", { name: tab }).click();
			await expect(page).toHaveURL(new RegExp(`tab=${tab.toLowerCase()}`));
			await expect(page.getByRole("tabpanel")).toBeVisible();
		}
		// useDetailTab switches tabs with history.replace (shared across detail
		// pages, deliberately), so the last tab survives a reload and back leaves
		// the page instead of unwinding tabs.
		await page.reload();
		await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute(
			"aria-selected",
			"true"
		);
		const detailUrl = page.url();
		await page.goBack();
		await expect(page).toHaveURL(/\/dispatch\/technicians$/);
		await page.goto(detailUrl.replace(/tab=\w+/, "tab=bogus"));
		await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
			"aria-selected",
			"true"
		);
	});

	test("keyboard through menu and tabs", async ({ page }) => {
		await openTech(page);
		const trigger = page.getByRole("button", { name: "Technician actions" });
		await trigger.focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(trigger).toBeFocused();
		await page.getByRole("tab", { name: "Overview" }).focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "Schedule" })).toBeFocused();
	});

	for (const width of [1440, 800]) {
		test(`no horizontal overflow at ${width}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await openTech(page);
			for (const tab of TABS) {
				await page.getByRole("tab", { name: tab }).click();
				await page.waitForLoadState("networkidle");
				// networkidle lands before skeletons swap out and the tab underline
				// settles; screenshots taken then show a half-rendered panel.
				await expect(page.getByRole("tab", { name: tab })).toHaveAttribute(
					"aria-selected",
					"true"
				);
				await expect(page.getByRole("tabpanel").locator(".animate-pulse")).toHaveCount(0);
				await page.waitForTimeout(250);
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth
				);
				expect(overflow, `${tab} at ${width}`).toBeLessThanOrEqual(0);
				// DispatchLayout scrolls inside `main > div`, so the document never
				// overflows; the scroller is where a too-wide row would show up.
				const inner = await page.evaluate(() => {
					const el = document.querySelector("main > div") as HTMLElement;
					return el.scrollWidth - el.clientWidth;
				});
				expect(inner, `${tab} scroller at ${width}`).toBeLessThanOrEqual(0);
				await page.screenshot({
					path: `test-results/tech-detail-${tab.toLowerCase()}-${width}.png`,
					fullPage: true,
				});
				// fullPage can't reach below the fold of an inner scroller.
				const scrolled = await page.evaluate(() => {
					const el = document.querySelector("main > div") as HTMLElement;
					if (el.scrollHeight <= el.clientHeight) return false;
					el.scrollTop = el.scrollHeight;
					return true;
				});
				if (scrolled)
					await page.screenshot({
						path: `test-results/tech-detail-${tab.toLowerCase()}-${width}-bottom.png`,
					});
				await page.evaluate(() => {
					(document.querySelector("main > div") as HTMLElement).scrollTop = 0;
				});
				// Upcoming is the default segment and is empty in the seed; the
				// Address/Job column rules only show on a segment with rows.
				if (tab === "Schedule") {
					for (const seg of ["Today", "Past"]) {
						await page.getByRole("radio", { name: new RegExp(seg) }).click();
						await page.waitForTimeout(150);
						const segInner = await page.evaluate(() => {
							const el = document.querySelector("main > div") as HTMLElement;
							return el.scrollWidth - el.clientWidth;
						});
						expect(segInner, `Schedule ${seg} at ${width}`).toBeLessThanOrEqual(0);
						await page.screenshot({
							path: `test-results/tech-detail-schedule-${seg.toLowerCase()}-${width}.png`,
						});
					}
				}
			}
		});
	}

	// Review evidence for two deferred findings: the hire date the header prints
	// against the API value, and the header status pill beside JobDetailPage's.
	test("hire date and status pill evidence", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const techResponse = page.waitForResponse(
			(r) =>
				/\/technicians\/[^/]+$/.test(new URL(r.url()).pathname) &&
				["xhr", "fetch"].includes(r.request().resourceType()) &&
				r.request().method() === "GET" &&
				r.status() === 200
		);
		await openTech(page);
		const body = await (await techResponse).json();
		const hireDate: string = body.data.hire_date;
		const meta = await page.getByText(/Hired /).first().innerText();
		const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
		console.log(`hire-date evidence: api=${hireDate} displayed="${meta}" tz=${tz}`);
		test.info().annotations.push({
			type: "hire-date",
			description: `api=${hireDate} displayed="${meta}" tz=${tz}`,
		});
		await page.screenshot({ path: "test-results/tech-detail-header-1440.png" });

		const jobsResponse = page.waitForResponse(
			(r) =>
				/\/jobs$/.test(new URL(r.url()).pathname) &&
				["xhr", "fetch"].includes(r.request().resourceType()) &&
				r.status() === 200
		);
		await page.goto("/dispatch/jobs");
		const jobs = await (await jobsResponse).json();
		const jobId: string | undefined = jobs.data?.[0]?.id;
		expect(jobId, "a seeded job to compare against").toBeTruthy();
		await page.goto(`/dispatch/jobs/${jobId}`);
		await page.waitForLoadState("networkidle");
		await page.screenshot({ path: "test-results/tech-detail-jobpill-1440.png" });
	});
});
