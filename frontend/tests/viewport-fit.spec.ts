import { test, expect, type Locator, type Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";
import { VIEWPORTS } from "./fixtures/viewports";

export const fieldReviewUrl = "/dispatch/purchases?tab=field_purchases";

// Seed data is light, so nothing here may depend on row counts.
async function settle(page: Page, path: string) {
	await page.goto(path);
	await page.waitForLoadState("networkidle");
	await page.addStyleTag({ content: "*{transition:none!important}" });
	await page.waitForTimeout(300);
}

export async function scrollerOverflow(page: Page): Promise<number> {
	return page.evaluate(() => {
		const scroller = document.querySelector("main > div") as HTMLElement;
		return scroller.scrollHeight - scroller.clientHeight;
	});
}

export async function isInView(locator: Locator): Promise<boolean> {
	return locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return (
			r.width > 0 &&
			r.height > 0 &&
			r.top >= 0 &&
			r.left >= 0 &&
			r.bottom <= window.innerHeight &&
			r.right <= window.innerWidth
		);
	});
}

// isInView only checks the window; this also catches clipping by an inner scroller
// or an overlay sitting on top of the element.
export async function isHitTestable(locator: Locator): Promise<boolean> {
	return locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return false;
		const x = r.left + Math.min(r.width / 2, 20);
		const y = r.top + r.height / 2;
		if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return false;
		const hit = document.elementFromPoint(x, y);
		return !!hit && (hit === el || el.contains(hit));
	});
}

const SHORT = VIEWPORTS[0];

for (const vp of VIEWPORTS) {
	test.describe(`nav @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("Admin link is reachable without scrolling", async ({ page }) => {
			await loginAsDispatcher(page);
			await settle(page, "/dispatch");
			expect(await isHitTestable(page.locator('aside a[href$="/dispatch/admin"]'))).toBe(
				true,
			);
		});

		test("More control reveals the last nav row", async ({ page }) => {
			await loginAsDispatcher(page);
			await settle(page, "/dispatch");
			const last = page.locator("aside nav a").last();
			const more = page.getByRole("button", { name: "More navigation" });
			for (let i = 0; i < 4 && (await more.isVisible()); i++) {
				await more.click();
				await page.waitForTimeout(150);
			}
			expect(await isHitTestable(last)).toBe(true);
		});
	});
}

test.describe(`nav active row @ ${SHORT.name}`, () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	test("active link is in view on load", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/followups");
		expect(
			await isHitTestable(page.locator('aside a[href$="/dispatch/followups"]')),
		).toBe(true);
	});

	test("Create panel Dispatcher row is in view", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch");
		await page.locator("aside button", { hasText: "Create" }).click();
		await page.waitForTimeout(250);
		const row = page.getByRole("button", { name: /^Dispatcher/ });
		expect(await isInView(row)).toBe(true);
	});
});

const COCKPITS = [
	{ path: fieldReviewUrl, box: '[role="tabpanel"]#tabpanel-field_purchases .rounded-lg.border-border' },
	{ path: "/dispatch/inventory/reconcile", box: "main .rounded-lg.border-border.overflow-hidden" },
];

for (const vp of VIEWPORTS) {
	test.describe(`cockpit fill @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		for (const cockpit of COCKPITS) {
			test(`${cockpit.path} fits without page scroll`, async ({ page }) => {
				await loginAsDispatcher(page);
				await settle(page, cockpit.path);
				expect(await scrollerOverflow(page)).toBeLessThanOrEqual(0);
				const bottom = await page
					.locator(cockpit.box)
					.first()
					.evaluate((el) => el.getBoundingClientRect().bottom);
				expect(bottom).toBeLessThanOrEqual(vp.height);
			});
		}
	});
}

const REVIEW_SCROLLER = "#fp-panel-queue header + div";

async function openFirstReview(page: Page, search?: string) {
	await loginAsDispatcher(page);
	await settle(page, fieldReviewUrl);
	await page.getByRole("button", { name: /^Awaiting review/ }).click();
	if (search) {
		await page.getByPlaceholder(/Technician, vendor or part/).fill(search);
		await page.waitForTimeout(600);
	}
	await page.locator("#fp-panel-queue > div:first-child button[type=button]").first().click();
	await page.locator(REVIEW_SCROLLER).waitFor();
	await page.waitForTimeout(300);
}

const approveButton = (page: Page) => page.getByRole("button", { name: "Approve", exact: true });

const REVIEW_MIN: Record<string, number> = { "1280x590": 170, "1366x638": 210 };

for (const vp of VIEWPORTS) {
	test.describe(`review panel @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("Approve is in view and the review scroller has room", async ({ page }) => {
			await openFirstReview(page);
			expect(await isInView(approveButton(page))).toBe(true);
			const min = REVIEW_MIN[vp.name];
			if (process.env.CHROME_LOG && min) {
				console.log(
					vp.name,
					JSON.stringify(
						await page.evaluate(() => {
							const h = (s: string) =>
								Math.round(document.querySelector(s)?.getBoundingClientRect().height ?? -1);
							return {
								pageHeader: h("main h2"),
								strip: h("main .grid.grid-cols-2"),
								fpTabs: h('[aria-label="Field purchase views"]'),
								queueHeader: h("#fp-panel-queue")
									? h('[aria-label="Field purchase views"] + div')
									: -1,
								reviewHeader: h("#fp-panel-queue header"),
								scroller: h("#fp-panel-queue header + div"),
								bar: h("#fp-panel-queue header + div + div"),
								box: h("#fp-panel-queue"),
							};
						}),
					),
				);
			}
			if (min) {
				const h = await page.locator(REVIEW_SCROLLER).evaluate((el) => el.clientHeight);
				expect(h).toBeGreaterThanOrEqual(min);
			}
		});
	});
}

test.describe(`review panel with filters @ ${SHORT.name}`, () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	test("Approve is reachable by one main scroll and panes never collapse", async ({ page }) => {
		await openFirstReview(page, "John");
		await page.evaluate(() => {
			const s = document.querySelector("main > div") as HTMLElement;
			s.scrollTop = s.scrollHeight;
		});
		await page.waitForTimeout(100);
		expect(await isInView(approveButton(page))).toBe(true);
		const h = await page.locator(REVIEW_SCROLLER).evaluate((el) => el.clientHeight);
		expect(h).toBeGreaterThan(0);
	});
});

// Seed ids change on every reseed, so look them up through the API.
async function apiData<T>(page: Page, path: string): Promise<T> {
	const token = await page.evaluate(() => localStorage.getItem("accessToken"));
	const res = await page.request.get(`http://localhost:3000${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return (await res.json()).data as T;
}

test.describe(`actions in reach @ ${SHORT.name}`, () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	// Drawers overlay the list by design. Opening one must not reflow the page,
	// and Esc puts the covered actions back in reach.
	test("vehicle alerts overlay the list and Esc gives Manage Stock back", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/vehicles");
		const scroller = page.locator("[data-layout-scroller] .overflow-y-auto").first();
		const before = await scroller.evaluate((el) => el.getBoundingClientRect().width);
		const toggle = page.locator("div.fixed.right-0 > button[aria-controls]");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await page.waitForTimeout(300);
		expect(await scroller.evaluate((el) => el.getBoundingClientRect().width)).toBe(before);

		// Focus is still on the toggle, inside the drawer.
		await page.keyboard.press("Escape");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(toggle).toBeFocused();
		await page.waitForTimeout(300);
		const buttons = page.getByRole("button", { name: "Manage Stock" });
		const n = await buttons.count();
		expect(n).toBeGreaterThan(0);
		for (let i = 0; i < n; i++) {
			const b = buttons.nth(i);
			if (await isInView(b)) expect(await isHitTestable(b), `Manage Stock #${i}`).toBe(true);
		}
	});

	test("Receive Stock Cancel is in view", async ({ page }) => {
		await loginAsDispatcher(page);
		const items = await apiData<{ id: string; is_serialized: boolean; name: string }[]>(
			page,
			"/inventory?limit=200",
		);
		const item = items.find((i) => i.is_serialized && !i.name.startsWith("MAXLEN"));
		expect(item).toBeTruthy();
		await settle(page, `/dispatch/inventory/items/${item!.id}`);
		await page.getByRole("button", { name: "More item actions" }).click();
		await page.getByRole("button", { name: "Receive Stock" }).first().click();
		await page.waitForTimeout(300);
		expect(await isInView(page.getByRole("button", { name: "Cancel", exact: true }))).toBe(true);
	});

	test("Restock Apply is in view", async ({ page }) => {
		await loginAsDispatcher(page);
		const vehicles = await apiData<{ id: string }[]>(page, "/vehicles");
		await settle(page, `/dispatch/vehicles/${vehicles[0].id}/stock?tab=restock`);
		const apply = page.getByRole("button", { name: /^(Apply (Restock|Prep)|Complete)/ });
		expect(await isInView(apply)).toBe(true);
	});

	test("subscription rail fits and scrolls", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/admin");
		await page.getByRole("tab", { name: "Subscription" }).click();
		await page.waitForTimeout(400);
		const rail = page.locator("#tabpanel-entitlements .rounded-xl.lg\\:sticky").first();
		const box = await rail.evaluate((el) => ({
			bottom: el.getBoundingClientRect().bottom,
			overflowY: getComputedStyle(el).overflowY,
		}));
		expect(box.bottom).toBeLessThanOrEqual(SHORT.height);
		expect(box.overflowY).toBe("auto");
	});
});

// Column prefs are stored per user: report-cols:<userId>:<table>.
async function reorderPrefKey(page: Page): Promise<string> {
	const userId = await page.evaluate(
		() => JSON.parse(localStorage.getItem("auth-storage") ?? "{}")?.state?.user?.userId ?? "anon",
	);
	return `report-cols:${userId}:reorder-forecast`;
}

test.describe(`tables @ ${SHORT.name}`, () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	test("Suppliers Edit is hit-testable without horizontal scroll", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/inventory/suppliers");
		const edit = page.locator("main table tbody tr").first().getByRole("button").last();
		expect(await isHitTestable(edit)).toBe(true);
	});

	test("Reorder Health and Buy from are in view on load", async ({ page }) => {
		await loginAsDispatcher(page);
		const key = await reorderPrefKey(page);
		await page.evaluate((k) => localStorage.removeItem(k), key);
		await settle(page, "/dispatch/inventory/reorder-forecast");
		if (process.env.CHROME_LOG)
			console.log(
				"reorder",
				await page.evaluate(() =>
					JSON.stringify(
						[...document.querySelectorAll("main .overflow-x-auto")].map((el) => ({
							over: el.scrollWidth - el.clientWidth,
							heads: [...el.querySelectorAll("thead th")].map((t) => t.textContent),
						})),
					),
				),
			);
		// The chart sits above the table at this height. Scroll the page vertically
		// only, so a column that needs a sideways scroll still fails the hit-test.
		await page.locator("main table").first().evaluate((table) => {
			const scroller = document.querySelector("[data-layout-scroller]");
			if (scroller) scroller.scrollTop += table.getBoundingClientRect().top - 120;
		});
		for (const name of [/^Health/, /^Buy from/i]) {
			const th = page.locator("main table th").filter({ hasText: name }).first();
			expect(await isHitTestable(th), String(name)).toBe(true);
		}
	});

	test("stored Reorder column prefs survive reload", async ({ page }) => {
		await loginAsDispatcher(page);
		const key = await reorderPrefKey(page);
		await page.evaluate((k) => localStorage.setItem(k, JSON.stringify(["health"])), key);
		await settle(page, "/dispatch/inventory/reorder-forecast");
		await page.reload();
		await page.waitForLoadState("networkidle");
		await expect(page.locator("main table th").filter({ hasText: /^Health/ })).toHaveCount(0);
		// The stored choice replaces the defaults, so the default-hidden columns show.
		for (const name of ["Sku", "Category", "Warehouse", "Vehicles"]) {
			await expect(page.getByRole("columnheader", { name, exact: true })).toHaveCount(1);
		}
		await page.evaluate((k) => localStorage.removeItem(k), key);
	});

	test("Jobs first row is one compact line", async ({ page }) => {
		await loginAsDispatcher(page);
		if (process.env.CHROME_LOG) {
			await settle(page, "/dispatch/jobs");
			console.log("jobs pages", await page.evaluate(() => {
				const s = document.querySelector("main > div") as HTMLElement;
				return (s.scrollHeight / s.clientHeight).toFixed(2);
			}));
		}
		await settle(page, "/dispatch/jobs");
		const h = await page
			.locator("main table tbody tr")
			.first()
			.evaluate((el) => el.getBoundingClientRect().height);
		expect(h).toBeLessThanOrEqual(76);
	});
});

// Inventory and Vehicles share one shell: a page-owned scroller beside an
// DockedPanel. Both must behave identically.
const DRAWER_PAGES = ["/dispatch/inventory", "/dispatch/vehicles"];

for (const vp of VIEWPORTS.filter((v) => ["1280x590", "1440x770", "2560x1310", "3440x1310"].includes(v.name))) {
	test.describe(`drawer pages @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("one page scrollbar, drawer open only where the gutter holds it", async ({ page }) => {
			await loginAsDispatcher(page);
			const expectOpen = vp.width >= 3440;
			for (const path of DRAWER_PAGES) {
				await settle(page, path);
				const shell = await page.evaluate(() => {
					const layout = document.querySelector("[data-layout-scroller]") as HTMLElement;
					const own = layout.querySelector(".overflow-y-auto") as HTMLElement;
					const drawer = document.querySelector("div.fixed.right-0") as HTMLElement;
					const ownRect = own.getBoundingClientRect();
					return {
						layoutOverflow: layout.scrollHeight - layout.clientHeight,
						ownTop: ownRect.top,
						ownBottom: ownRect.bottom,
						ownRight: ownRect.right,
						drawerLeft: drawer.getBoundingClientRect().left,
						innerHeight: window.innerHeight,
					};
				});
				// The layout never scrolls; the page's own scroller runs header to bottom edge.
				expect(shell.layoutOverflow, path).toBeLessThanOrEqual(0);
				expect(Math.round(shell.ownTop), path).toBe(56);
				expect(Math.round(shell.ownBottom), path).toBe(shell.innerHeight);
				await expect(page.locator("div.fixed.right-0 > button[aria-controls]"), path).toHaveAttribute(
					"aria-expanded",
					String(expectOpen),
				);
				// Open or collapsed, the drawer starts past the page's scrollbar.
				expect(shell.drawerLeft, path).toBeGreaterThanOrEqual(shell.ownRight);
			}
		});
	});
}

test.describe("admin settings @ 1536x734", () => {
	test.use({ viewport: { width: 1536, height: 734 } });

	test("Tax groups table has no inner horizontal scroll", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/admin");
		await page.getByRole("tab", { name: "Settings" }).click();
		await page.waitForTimeout(400);
		await page.getByRole("tab", { name: /^Groups/ }).click();
		await page.waitForTimeout(400);
		const over = await page.evaluate(() =>
			[...document.querySelectorAll("#tabpanel-settings .overflow-x-auto")]
				.map((el) => el.scrollWidth - el.clientWidth)
				.reduce((a, b) => Math.max(a, b), 0),
		);
		expect(over).toBeLessThanOrEqual(0);
	});
});

const MAP_BOX = "main .bg-surface.rounded-lg.border-border.overflow-hidden";

for (const vp of VIEWPORTS) {
	test.describe(`map fill @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("map fits the window with the pulse footer in view", async ({ page }) => {
			await loginAsDispatcher(page);
			await settle(page, "/dispatch/map");
			expect(await scrollerOverflow(page)).toBeLessThanOrEqual(0);
			const geo = await page.locator(MAP_BOX).first().evaluate((el) => {
				const footer = el.nextElementSibling!.getBoundingClientRect();
				return {
					footerBottom: footer.bottom,
					footerHeight: footer.height,
					map: el.getBoundingClientRect().height,
					main: document.querySelector("main")!.getBoundingClientRect().height,
				};
			});
			expect(geo.footerHeight).toBeGreaterThan(0);
			expect(geo.footerBottom).toBeLessThanOrEqual(vp.height);
			if (vp.name === "2560x1310") expect(geo.map / geo.main).toBeGreaterThanOrEqual(0.85);
		});
	});
}

test.describe(`tall pages @ ${SHORT.name}`, () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	test("Reorder chart is capped and its footer is not clipped", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/inventory/reorder-forecast");
		const chart = page.locator("main div:has(> .recharts-responsive-container), main .recharts-responsive-container").first();
		const geo = await chart.evaluate((el) => {
			let box = el as HTMLElement;
			while (box.parentElement && !box.className.includes("mb-4")) box = box.parentElement;
			const r = box.getBoundingClientRect();
			const lowest = [...box.querySelectorAll("*")].reduce(
				(m, c) => Math.max(m, c.getBoundingClientRect().bottom),
				0,
			);
			return { height: r.height, bottom: r.bottom, lowest };
		});
		if (process.env.CHROME_LOG)
			await chart.screenshot({ path: `test-results/reorder-chart-${SHORT.name}.png` });
		expect(geo.height).toBeLessThanOrEqual(320);
		expect(geo.lowest).toBeLessThanOrEqual(geo.bottom + 1);
	});

	test("Assign page timeline stays in view while the list scrolls", async ({ page }) => {
		await loginAsDispatcher(page);
		const techs = await apiData<{ id: string }[]>(page, "/technicians");
		await page.evaluate(() => localStorage.setItem("assignTech.showDay", "1"));
		await settle(page, `/dispatch/technicians/${techs[0].id}/assign`);
		await page.evaluate(() => {
			(document.querySelector("main > div") as HTMLElement).scrollTop = 600;
		});
		await page.waitForTimeout(150);
		const top = await page
			.locator('aside[aria-label="Day timeline"]')
			.evaluate((el) => el.getBoundingClientRect().top);
		expect(top).toBeGreaterThanOrEqual(0);
		expect(top).toBeLessThan(SHORT.height / 2);
	});
});

async function contentBox(page: Page) {
	return page.evaluate(() => {
		const scroller = document.querySelector("main > div") as HTMLElement;
		const s = getComputedStyle(scroller);
		const sr = scroller.getBoundingClientRect();
		const innerLeft = sr.left + parseFloat(s.paddingLeft);
		const innerRight = sr.left + scroller.clientWidth - parseFloat(s.paddingRight);
		const r = (scroller.firstElementChild as HTMLElement).getBoundingClientRect();
		return {
			width: r.width,
			available: innerRight - innerLeft,
			leftGap: r.left - innerLeft,
			rightGap: innerRight - r.right,
		};
	});
}

test.describe("width cap @ 3440x1310", () => {
	test.use({ viewport: { width: 3440, height: 1310 } });
	// Several routes per test at full size; networkidle per route outruns 30s.
	test.describe.configure({ timeout: 90_000 });

	test("list pages cap at 1920 and center", async ({ page }) => {
		await loginAsDispatcher(page);
		for (const path of ["/dispatch/jobs", "/dispatch/purchases?tab=purchasing"]) {
			await settle(page, path);
			const box = await contentBox(page);
			expect(box.width, path).toBeLessThanOrEqual(1920);
			expect(Math.abs(box.leftGap - box.rightGap), `${path} centered`).toBeLessThanOrEqual(1);
		}
	});

	test("full-bleed pages keep the whole width", async ({ page }) => {
		await loginAsDispatcher(page);
		for (const path of [
			"/dispatch",
			"/dispatch/schedule",
			"/dispatch/map",
			"/dispatch/kpi",
			fieldReviewUrl,
			"/dispatch/inventory/reconcile",
		]) {
			await settle(page, path);
			const box = await contentBox(page);
			expect(box.width, path).toBeGreaterThanOrEqual(box.available - 1);
		}
	});

	test("schedule board edge and dashboard grid are unchanged", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/schedule");
		// Schedule cancels the layout padding with a negative margin, so it starts
		// flush against the 64px sidebar.
		const left = await page.evaluate(
			() =>
				document
					.querySelector("main > div")!
					.querySelector('[class*="-m-6"]')!
					.getBoundingClientRect().left,
		);
		expect(left).toBe(64);
		await settle(page, "/dispatch");
		const grid = await page.evaluate(() => {
			const g = document.querySelector(".react-grid-layout") as HTMLElement;
			const scroller = document.querySelector("main > div") as HTMLElement;
			return { grid: g.getBoundingClientRect().width, avail: scroller.clientWidth - 48 };
		});
		expect(grid.grid).toBeGreaterThanOrEqual(grid.avail - 1);
	});
});

test.describe(`review fixes @ ${SHORT.name}`, () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	test("layout bottom padding survives on a scrolling page", async ({ page }) => {
		await loginAsDispatcher(page);
		// Jobs and other list pages already read 0 here at HEAD; Reorder reads the full 24px.
		await settle(page, "/dispatch/inventory/reorder-forecast");
		const gap = await page.evaluate(() => {
			const s = document.querySelector("main > div") as HTMLElement;
			s.scrollTop = s.scrollHeight;
			const bottom = s.getBoundingClientRect().bottom;
			const lowest = [...s.querySelectorAll("*")].reduce(
				(m, c) => Math.max(m, c.getBoundingClientRect().bottom),
				0,
			);
			return bottom - lowest;
		});
		expect(gap).toBeGreaterThanOrEqual(23);
	});

	test("Receive Stock error is visible after a failed submit", async ({ page }) => {
		await loginAsDispatcher(page);
		const items = await apiData<{ id: string; is_serialized: boolean; name: string }[]>(
			page,
			"/inventory?limit=200",
		);
		const item = items.find((i) => i.is_serialized && !i.name.startsWith("MAXLEN"));
		await settle(page, `/dispatch/inventory/items/${item!.id}`);
		await page.getByRole("button", { name: "More item actions" }).click();
		await page.getByRole("button", { name: "Receive Stock" }).first().click();
		await page.locator("#receive-qty").fill("20");
		await page.locator("form").getByRole("button", { name: "Receive Stock" }).click();
		const error = page.locator("form p.bg-error-bg");
		await error.waitFor();
		expect(await isInView(error)).toBe(true);
	});

	test("Reorder export keeps the default-hidden columns", async ({ page }) => {
		await loginAsDispatcher(page);
		const key = await reorderPrefKey(page);
		await page.evaluate((k) => localStorage.removeItem(k), key);
		await settle(page, "/dispatch/inventory/reorder-forecast");
		const req = page.waitForRequest((r) => (r.postData() ?? "").includes("reorder-forecast"));
		await page.getByRole("button", { name: /Export/ }).first().click();
		const body = (await req).postData() ?? "";
		for (const k of ["sku", "category", "warehouse", "vehicles"]) expect(body, k).toContain(`"${k}"`);
	});
});

test.describe("phone keeps its layout @ 375x667", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("stat strip hints still show below lg", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, fieldReviewUrl);
		await expect(page.getByText(/open receipts/).first()).toBeVisible();
	});
});

test.describe("orders tab", () => {
	test.use({ viewport: { width: SHORT.width, height: SHORT.height } });

	test("Orders tab keeps normal page scroll", async ({ page }) => {
		await loginAsDispatcher(page);
		await settle(page, "/dispatch/purchases?tab=purchasing");
		const overflowY = await page.evaluate(
			() => getComputedStyle(document.querySelector("main > div")!).overflowY,
		);
		expect(overflowY).toBe("auto");
		expect(
			await page.locator("#tabpanel-purchasing").evaluate((el) => el.scrollHeight > 0),
		).toBe(true);
	});
});

for (const vp of VIEWPORTS) {
	test.describe(`shell @ ${vp.name}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } });

		test("no page-level horizontal overflow", async ({ page }) => {
			await loginAsDispatcher(page);

			for (const path of [
				"/dispatch",
				"/dispatch/jobs",
				"/dispatch/purchases",
				"/dispatch/admin",
			]) {
				await settle(page, path);
				const overflow = await page.evaluate(
					() =>
						document.documentElement.scrollWidth -
						document.documentElement.clientWidth,
				);
				expect(overflow, `${path} @ ${vp.name}`).toBeLessThanOrEqual(0);
			}
		});
	});
}
