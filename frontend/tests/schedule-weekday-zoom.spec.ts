import { test, expect, type Page } from "@playwright/test";
import {
	dayKeys,
	headerGeometry,
	interceptJobs,
	nonPointerButtons,
	openSchedule,
	settle,
	todayKey,
} from "./fixtures/scheduleGeometry";

// Geometry, not pixels: visits churn between runs, column boxes don't.
async function box(page: Page, selector: string) {
	const b = await page.locator(selector).first().boundingBox();
	if (!b) throw new Error(`no box for ${selector}`);
	return b;
}

function firstDay(page: Page) {
	return page.locator("[data-day-header]").first().getAttribute("data-day-header");
}

async function zoom(page: Page, index: number) {
	const header = page.locator("[data-day-header]").nth(index);
	await header.hover();
	await header.locator("button").click();
}

test.describe("schedule weekday zoom", () => {
	test.beforeEach(async ({ page }) => {
		await openSchedule(page);
		await expect(page.locator("[data-day-header]")).toHaveCount(7);
	});

	test("header and body columns stay aligned when a day zooms", async ({ page }) => {
		const days = await dayKeys(page);
		await zoom(page, 2);
		await settle(page);

		for (const d of days) {
			const h = await box(page, `[data-day-header="${d}"]`);
			const c = await box(page, `[data-day="${d}"]`);
			expect(Math.abs(h.x - c.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(h.width - c.width)).toBeLessThanOrEqual(1);
		}
		const zoomed = await box(page, `[data-day="${days[2]}"]`);
		const normal = await box(page, `[data-day="${days[0]}"]`);
		expect(zoomed.width / normal.width).toBeGreaterThan(1.8);
		await expect(page.locator(`[data-day-header="${days[2]}"] button`)).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await page.screenshot({ path: "test-results/zoom-wed.png" });
	});

	test("zooming another day swaps, clicking again collapses", async ({ page }) => {
		const headers = page.locator("[data-day-header]");
		await zoom(page, 0);
		await zoom(page, 3);
		await expect(headers.nth(0).locator("button")).toHaveAttribute("aria-pressed", "false");
		await expect(headers.nth(3).locator("button")).toHaveAttribute("aria-pressed", "true");
		await headers.nth(3).locator("button").click();
		await expect(page.locator('[data-day-header] button[aria-pressed="true"]')).toHaveCount(0);
	});

	test("next week clears zoom", async ({ page }) => {
		const before = await firstDay(page);
		await zoom(page, 6);
		await page.getByRole("button", { name: "Next week" }).click();
		await expect.poll(() => firstDay(page)).not.toBe(before);
		await expect(page.locator('[data-day-header] button[aria-pressed="true"]')).toHaveCount(0);
	});

	test("zoom button is keyboard reachable and visible on focus", async ({ page }) => {
		const btn = page.locator("[data-day-header] button").first();
		await btn.focus();
		await expect.poll(() => btn.evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
		await page.keyboard.press("Enter");
		await expect(btn).toHaveAttribute("aria-pressed", "true");
	});

	test("1024px viewport still widens the zoomed day", async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		const d = await page.locator("[data-day-header]").nth(1).getAttribute("data-day-header");
		await zoom(page, 1);
		await settle(page);
		expect((await box(page, `[data-day="${d}"]`)).width).toBeGreaterThanOrEqual(299);
		await page.screenshot({ path: "test-results/zoom-1024.png" });
	});

	test("week change snaps instead of animating the old zoom into the new week", async ({ page }) => {
		await zoom(page, 2);
		await settle(page);
		const spread = await page.evaluate(async () => {
			(document.querySelector('[aria-label="Next week"]') as HTMLElement).click();
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const ws = [...document.querySelectorAll("[data-day-header]")].map(
				(e) => e.getBoundingClientRect().width
			);
			return Math.max(...ws) - Math.min(...ws);
		});
		expect(spread).toBeLessThanOrEqual(1);
	});

	test("Today on the current week keeps the zoom", async ({ page }) => {
		await zoom(page, 2);
		await page.getByRole("button", { name: "Today", exact: true }).click();
		await expect(page.locator("[data-day-header]").nth(2).locator("button")).toHaveAttribute(
			"aria-pressed",
			"true"
		);
	});

	// Cards size off the measured column width; a stale (previously zoomed) width on
	// the first painted frame of a week spills cards into the neighbouring day.
	test("cards never paint wider than their column after a week change", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await zoom(page, 2);
		await settle(page);
		await page.getByRole("button", { name: "Previous week" }).click();
		await settle(page);
		const overflow = await page.evaluate(async () => {
			(document.querySelector('[aria-label="Next week"]') as HTMLElement).click();
			await new Promise((r) => requestAnimationFrame(r));
			let worst = 0;
			for (const col of document.querySelectorAll<HTMLElement>("[data-day]")) {
				const right = col.getBoundingClientRect().right;
				for (const card of col.querySelectorAll('[draggable="true"]')) {
					worst = Math.max(worst, card.getBoundingClientRect().right - right);
				}
			}
			return worst;
		});
		expect(overflow).toBeLessThanOrEqual(1);
	});

	test("drag scroll zones stay inside the visible board when zoom overflows it", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await zoom(page, 1);
		await settle(page);
		const board = await page.locator("[data-day-header]").first().evaluate((e) => {
			let el: HTMLElement | null = e as HTMLElement;
			while (el && getComputedStyle(el).overflow !== "auto") el = el.parentElement;
			const r = el!.getBoundingClientRect();
			return { left: r.left, right: r.left + el!.clientWidth, overflows: el!.scrollWidth > el!.clientWidth };
		});
		expect(board.overflows).toBe(true);
		const zone = await box(page, '[data-scroll-zone="right"]');
		expect(zone.x + zone.width).toBeLessThanOrEqual(board.right + 1);
		expect(zone.x).toBeGreaterThanOrEqual(board.left);
	});

	test("toolbar controls show a border at rest", async ({ page }) => {
		const hasBorder = (name: string) =>
			page
				.getByRole("button", { name, exact: true })
				.evaluate((e) => getComputedStyle(e).borderTopColor !== "rgba(0, 0, 0, 0)");

		for (const name of ["Today", "Previous week", "Next week"]) {
			expect(await hasBorder(name), name).toBe(true);
		}
		// Visits/Recurring default on; switch off to check the idle state, then restore.
		for (const name of ["Visits", "Recurring"]) {
			const btn = page.getByRole("button", { name, exact: true });
			await btn.click();
			expect(await hasBorder(name), name).toBe(true);
			await btn.click();
		}
		await page.screenshot({
			path: "test-results/toolbar-rest.png",
			clip: { x: 0, y: 0, width: 1440, height: 120 },
		});
	});

	test("every enabled button shows a pointer", async ({ page }) => {
		expect(await nonPointerButtons(page, "main")).toEqual([]);
	});

	test("toolbar controls are bordered at rest and expose state", async ({ page }) => {
		const tb = page.locator("[data-schedule-toolbar]");
		await expect(tb).toBeVisible();
		const visits = tb.getByRole("button", { name: "Visits" });
		const recurring = tb.getByRole("button", { name: "Recurring" });
		await visits.click();
		await recurring.click();
		await expect(visits).toHaveAttribute("aria-pressed", "false");
		await expect(tb.getByRole("button", { name: "Week", exact: true })).toHaveAttribute("aria-pressed", "true");
		// Segments sit inside a bordered container; every other control carries its own border.
		const borders = await tb.evaluate((el) =>
			[...el.querySelectorAll("button")]
				.filter((b) => !b.closest("[data-segmented]"))
				.map((b) => {
					const cs = getComputedStyle(b);
					return `${cs.borderTopWidth} ${cs.borderTopStyle}`;
				})
		);
		expect(borders.length).toBeGreaterThan(4);
		expect(borders.every((b) => b === "1px solid")).toBe(true);
	});

	test("day header geometry follows the shared spec", async ({ page }) => {
		expect(await headerGeometry(page, "main")).toEqual({
			gap: 8,
			inset: 6,
			align: "baseline",
			weekday: "10px/600/uppercase",
			num: "15px/700",
		});
	});

	test("anytime: the whole gutter cell toggles, by mouse and keyboard", async ({ page }) => {
		const cell = page.locator('button[aria-controls="anytime-row"]');
		await expect(cell).toHaveAttribute("aria-expanded", "false");
		const b = (await cell.boundingBox())!;
		expect(b.width).toBeGreaterThanOrEqual(63);

		// Collapsed: label vertically centred; right inset = hour-label inset (6px) + 1px border.
		const geo = await cell.evaluate((el) => {
			const c = el.getBoundingClientRect();
			const l = el.querySelector("span")!.getBoundingClientRect();
			return {
				dy: Math.abs((l.top + l.bottom) / 2 - (c.top + c.bottom) / 2),
				inset: Math.round(c.right - l.right),
			};
		});
		expect(geo.dy).toBeLessThanOrEqual(1);
		expect(geo.inset).toBe(7);

		await page.mouse.click(b.x + 3, b.y + b.height - 3);
		await expect(cell).toHaveAttribute("aria-expanded", "true");
		await cell.focus();
		await page.keyboard.press("Enter");
		await expect(cell).toHaveAttribute("aria-expanded", "false");
		await page.keyboard.press("Space");
		await expect(cell).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator("#anytime-row")).toHaveAttribute("role", "group");
	});

	test("?week= opens the week containing that date", async ({ page }) => {
		await page.goto("/dispatch/schedule?week=2026-10-07");
		await expect(page.locator("main [data-day-header]").first()).toHaveAttribute(
			"data-day-header",
			"2026-10-05"
		);
		await expect(page.locator("[data-schedule-toolbar]")).toContainText("Oct 5 – 11, 2026");
	});

	test("?week=&zoom=1 opens that week with the linked day enlarged", async ({ page }) => {
		await page.goto("/dispatch/schedule?week=2026-10-07&zoom=1");
		const pressed = page.locator('main [data-day-header] button[aria-pressed="true"]');
		await expect(pressed).toHaveCount(1);
		await expect(
			page.locator('main [data-day-header="2026-10-07"] button[aria-pressed]')
		).toHaveAttribute("aria-pressed", "true");
	});

	test("?week= without zoom leaves every day at normal width", async ({ page }) => {
		await page.goto("/dispatch/schedule?week=2026-10-07");
		await expect(page.locator("main [data-day-header]").first()).toBeVisible();
		await expect(page.locator('main [data-day-header] button[aria-pressed="true"]')).toHaveCount(0);
	});

	test("?week= also seeds Month view with the linked week's month", async ({ page }) => {
		await page.goto("/dispatch/schedule?week=2026-11-18");
		await expect(page.locator("[data-schedule-toolbar]")).toContainText("Nov 16 – 22, 2026");
		await page.locator("[data-schedule-toolbar]").getByRole("button", { name: "Month" }).click();
		await expect(page.locator("[data-schedule-toolbar]")).toContainText("November 2026");
	});

	test("an invalid ?week= falls back to the current week", async ({ page }) => {
		await page.goto("/dispatch/schedule?week=2026-02-31");
		await expect(page.locator("main [data-day-header]").first()).toBeVisible();
		expect(await dayKeys(page, "main")).toContain(todayKey());
	});

	test("hovering anywhere in a day's column reveals that day's zoom button", async ({ page }) => {
		const headers = page.locator("[data-day-header]");
		const btn = (i: number) => headers.nth(i).locator("button[aria-pressed]");
		const opacity = (i: number) => btn(i).evaluate((e) => getComputedStyle(e).opacity);
		const headerBox = async (i: number) => (await headers.nth(i).boundingBox())!;
		// Deep in the time grid, well below the header and anytime rows.
		const h3 = await headerBox(3);
		await page.mouse.move(h3.x + h3.width / 2, 600);
		await expect.poll(() => opacity(3)).toBe("1");
		expect(await opacity(0)).toBe("0");
		const h0 = await headerBox(0);
		await page.mouse.move(h0.x + h0.width / 2, 600);
		await expect.poll(() => opacity(0)).toBe("1");
		await expect.poll(() => opacity(3)).toBe("0");
		// The time gutter belongs to no day.
		await page.mouse.move(h0.x - 20, 600);
		await expect.poll(() => opacity(0)).toBe("0");
	});
});

/**
 * Replace GET /jobs with deterministic week cards today: a `by` visit, four same-time visits
 * (forced into narrow lanes), a long unbroken title, and one planned occurrence.
 */
async function seedWeekCards(page: Page) {
	await interceptJobs(page, (base, template) => {
		const now = new Date();
		const at = (h: number, m = 0) =>
			new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).toISOString();
		const visit = (id: string, fields: Record<string, unknown>) => ({
			...template,
			id,
			name: "",
			status: "Scheduled",
			arrival_time: null,
			arrival_window_start: null,
			arrival_window_end: null,
			finish_time: null,
			...fields,
		});
		const visits = [
			visit("synthetic-by", {
				arrival_constraint: "by",
				arrival_window_end: "12:00",
				finish_constraint: "when_done",
				scheduled_start_at: at(8),
				scheduled_end_at: at(10),
			}),
			...[0, 1, 2, 3].map((i) =>
				visit(`synthetic-lane-${i}`, {
					arrival_constraint: "at",
					arrival_time: "14:00",
					finish_constraint: "at",
					finish_time: "15:00",
					scheduled_start_at: at(14),
					scheduled_end_at: at(15),
				})
			),
			visit("synthetic-long", {
				name: `Condenser${"X".repeat(110)}`,
				arrival_constraint: "at",
				arrival_time: "19:00",
				finish_constraint: "at",
				finish_time: "21:00",
				scheduled_start_at: at(19),
				scheduled_end_at: at(21),
			}),
		];
		const plan = {
			id: "synthetic-plan",
			name: "Quarterly PM",
			status: "Active",
			address: "400 Oak Ave",
			description: "",
			priority: "Low",
			client: base.client ?? null,
			occurrences: [
				{
					id: "synthetic-occ",
					recurring_plan_id: "synthetic-plan",
					status: "planned",
					job_visit_id: null,
					arrival_constraint: "at",
					arrival_time: "17:00",
					arrival_window_start: null,
					arrival_window_end: null,
					finish_constraint: "at",
					finish_time: "18:00",
					occurrence_start_at: at(17),
					occurrence_end_at: at(18),
					template_version: 1,
					created_at: at(0),
				},
			],
		};
		return [
			{ ...base, id: "synthetic-job", visits, recurring_plan: null },
			{ ...base, id: "synthetic-plan-job", visits: [], recurring_plan: plan },
		];
	});
}

const card = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`);

test.describe("week card evolution", () => {
	test.beforeEach(async ({ page }) => {
		await seedWeekCards(page);
		await openSchedule(page);
		await expect(card(page, "synthetic-by")).toHaveCount(1);
	});

	test("a by visit sits at its scheduled start, not its deadline", async ({ page }) => {
		expect(await card(page, "synthetic-by").evaluate((e) => (e as HTMLElement).style.top)).toBe(
			`${8 * 56}px`
		);
		await expect(card(page, "synthetic-by").locator("[data-card-chip]")).toHaveText(
			"by 12:00 · open end"
		);
	});

	test("an occurrence card shows a constraint chip", async ({ page }) => {
		const occ = card(page, "synthetic-occ");
		await expect(occ).toHaveAttribute("data-card-kind", "occurrence");
		await expect(occ.locator("[data-card-chip]")).toHaveText("5:00–6:00");
		await expect(occ.locator("[data-card-unassigned]")).toHaveText("Unassigned");
	});

	test("overlap lanes under 56px of content render slivers", async ({ page }) => {
		const lanes = await page
			.locator(`[data-day="${todayKey()}"] [data-card-id^="synthetic-lane-"]`)
			.evaluateAll((els) =>
				els.map((e) => ({
					mode: (e as HTMLElement).dataset.cardMode,
					content: e.getBoundingClientRect().width - 14,
				}))
			);
		expect(lanes).toHaveLength(4);
		for (const l of lanes) expect(l.mode === "sliver").toBe(l.content < 56);
		expect(lanes.some((l) => l.mode === "sliver")).toBe(true);
	});

	test("a long unbroken title never overflows its card", async ({ page }) => {
		const overflow = await card(page, "synthetic-long")
			.locator("[data-card-title]")
			.evaluate((e) => e.scrollWidth - e.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});

	for (const scheme of ["light", "dark"] as const) {
		for (const width of [1440, 1920]) {
			test(`screenshot ${scheme} ${width}`, async ({ page }) => {
				await page.emulateMedia({ colorScheme: scheme });
				await page.setViewportSize({ width, height: 1000 });
				await page.reload();
				await expect(card(page, "synthetic-by")).toHaveCount(1);
				await card(page, "synthetic-by").evaluate((e) => e.scrollIntoView({ block: "center" }));
				await page.waitForTimeout(260);
				await page.screenshot({ path: `test-results/week-cards-${scheme}-${width}.png` });
			});
		}
	}
});
