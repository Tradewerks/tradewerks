import { test, expect } from "@playwright/test";
import {
	STRIP,
	dayKeys,
	headerBtn,
	fitState,
	headerGeometry,
	nonPointerButtons,
	openDashboard,
	seedToday,
	setStripHeight,
	setStripWidth,
	settle,
	todayKey,
	toolbarStyles,
	unzoomToday,
	zoomDay,
} from "./fixtures/scheduleGeometry";

const LONG = "Rooftop Unit Replacement — Smith Commercial Building 2, North Annex Loading Dock";

test.describe("dashboard schedule widget", () => {
	test("every enabled button shows a pointer", async ({ page }) => {
		await openDashboard(page);
		expect(await nonPointerButtons(page, STRIP)).toEqual([]);
	});

	test("closed create panel is out of the tab order; open panel works", async ({ page }) => {
		await openDashboard(page);
		// Playwright's role engine ignores `inert`, so assert on the DOM state that removes tab stops.
		const closeBtn = page.getByRole("button", { name: "Close create panel" });
		const isInert = () => closeBtn.evaluate((el) => el.closest("[inert]") !== null);
		expect(await isInert()).toBe(true);
		await page.getByRole("button", { name: "Create", exact: true }).click();
		await expect(closeBtn).toBeVisible();
		expect(await isInert()).toBe(false);
	});

	test("schedule cards show a focus outline when tabbed to", async ({ page }) => {
		await seedToday(page, 3);
		await openDashboard(page);
		await page.locator(`${STRIP} [role="button"]`).first().focus();
		// Re-enter by keyboard so :focus-visible applies.
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		const focus = await page.evaluate(() => {
			const el = document.activeElement as Element;
			const cs = getComputedStyle(el);
			return {
				role: el.getAttribute("role"),
				style: cs.outlineStyle,
				width: cs.outlineWidth,
				offset: cs.outlineOffset,
			};
		});
		expect(focus.role).toBe("button");
		expect(focus.style).not.toBe("none");
		expect(focus.width).not.toBe("0px");
		expect(focus.offset).toBe("1px");
	});

	test("today is zoomed with its agenda on load", async ({ page }) => {
		await openDashboard(page);
		await expect(headerBtn(page, todayKey())).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(`${STRIP} [data-strip-day="${todayKey()}"] [data-day-agenda]`)).toBeVisible();
		await expect(page.locator(`${STRIP} [data-day-agenda]`)).toHaveCount(1);
		await page.locator(STRIP).screenshot({ path: "test-results/strip-1440.png" });
	});

	test("clicking a recurring occurrence opens its popup unclipped", async ({ page }) => {
		await openDashboard(page);
		const occ = page.locator(`${STRIP} [role="button"][style*="occurrence-border"]`).first();
		test.skip((await occ.count()) === 0, "no planned occurrence in the visible week");
		const viewPlan = page.getByRole("button", { name: "View Plan" });

		await occ.click();
		await expect(viewPlan).toBeVisible();
		// Grid-item transforms re-anchor `fixed` and the widget clips it; the popup must sit at <body>.
		const popup = viewPlan.locator("xpath=ancestor::div[contains(@style,'z-index: 1000')]");
		expect(await popup.evaluate((el) => el.parentElement === document.body)).toBe(true);
		await expect(viewPlan).toBeInViewport({ ratio: 1 });

		await occ.click();
		await expect(viewPlan).toHaveCount(0);

		await occ.click();
		await page.mouse.click(5, 5);
		await expect(viewPlan).toHaveCount(0);
	});

	test("shrink today, zoom another day, page away and back", async ({ page }) => {
		await openDashboard(page);
		const days = await dayKeys(page, STRIP);
		const other = days[3] === todayKey() ? days[4] : days[3];

		await headerBtn(page, todayKey()).click();
		await expect(page.locator(`${STRIP} [data-day-agenda]`)).toHaveCount(0);

		await zoomDay(page, other);
		await expect(page.locator(`${STRIP} [data-strip-day="${other}"] [data-day-agenda]`)).toBeVisible();
		await settle(page);
		const wOther = (await page.locator(`${STRIP} [data-strip-day="${other}"]`).boundingBox())!.width;
		const wToday = (await page.locator(`${STRIP} [data-strip-day="${todayKey()}"]`).boundingBox())!.width;
		expect(wOther / wToday).toBeGreaterThan(1.8);

		await page.locator(STRIP).getByRole("button", { name: "Next week" }).click();
		await expect(page.locator(`${STRIP} [data-day-header] button[aria-pressed="true"]`)).toHaveCount(0);
		await expect(page.locator(`${STRIP} [data-day-agenda]`)).toHaveCount(0);

		await page.locator(STRIP).getByRole("button", { name: "Today" }).click();
		await expect(headerBtn(page, todayKey())).toHaveAttribute("aria-pressed", "true");
	});

	test("agenda fits its track without horizontal overflow at 1024", async ({ page }) => {
		await openDashboard(page, 1024);
		const overflow = await page
			.locator(`${STRIP} [data-day-agenda]`)
			.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
		await page.locator(STRIP).screenshot({ path: "test-results/strip-1024.png" });
	});

	test("3-day widget pages by three days", async ({ page }) => {
		await openDashboard(page);
		await setStripWidth(page, 500);
		await expect(page.locator(`${STRIP} [data-day-header]`)).toHaveCount(3);
		const first = await page.locator(`${STRIP} [data-day-header]`).first().getAttribute("data-day-header");
		await page.locator(STRIP).getByRole("button", { name: "Next 3 days" }).click();
		await expect
			.poll(async () => {
				const next = await page.locator(`${STRIP} [data-day-header]`).first().getAttribute("data-day-header");
				return Math.round((Date.parse(next + "T12:00:00") - Date.parse(first + "T12:00:00")) / 86_400_000);
			})
			.toBe(3);
	});

	test("1-day widget shows the agenda and no zoom button", async ({ page }) => {
		await openDashboard(page);
		await setStripWidth(page, 300);
		await expect(page.locator(`${STRIP} [data-day-header]`)).toHaveCount(1);
		await expect(page.locator(`${STRIP} [data-day-header] button[aria-pressed]`)).toHaveCount(0);
		await expect(page.locator(`${STRIP} [data-day-agenda]`)).toBeVisible();
	});

	test("toolbar matches the schedule page and stays bordered when off", async ({ page }) => {
		await openDashboard(page);
		const dash = await toolbarStyles(page, STRIP);
		await page.goto("/dispatch/schedule");
		await expect(page.locator("main [data-schedule-toolbar]")).toBeVisible();
		expect(dash).toEqual(await toolbarStyles(page, "main"));

		await page.goto("/dispatch");
		const tb = page.locator(`${STRIP} [data-schedule-toolbar]`);
		await tb.getByRole("button", { name: "Visits" }).click();
		await tb.getByRole("button", { name: "Recurring" }).click();
		const off = await toolbarStyles(page, STRIP);
		expect(off.every((s) => s.bw === "1px" && s.bs === "solid")).toBe(true);
	});

	test("day header geometry matches the schedule page", async ({ page }) => {
		await openDashboard(page);
		const dash = await headerGeometry(page, STRIP);
		await page.goto("/dispatch/schedule");
		await expect(page.locator("main [data-day-header]")).toHaveCount(7);
		expect(dash).toEqual(await headerGeometry(page, "main"));
	});

	test.describe("fit-to-height", () => {
		test("taller widget shows more cards; nothing clipped", async ({ page }) => {
			await seedToday(page, 14);
			await openDashboard(page);
			await unzoomToday(page);
			await setStripHeight(page, 240);
			const short = await fitState(page, todayKey());
			await setStripHeight(page, 420);
			const tall = await fitState(page, todayKey());
			expect(tall.visible).toBeGreaterThan(short.visible);
			for (const s of [short, tall]) {
				expect(s.visible + s.more).toBe(14);
				expect(s.lastBottom).toBeLessThanOrEqual(s.bodyBottom + 0.5);
				expect(s.moreBottom).toBeLessThanOrEqual(s.bodyBottom + 0.5);
			}
		});

		test("no +N when everything fits", async ({ page }) => {
			await seedToday(page, 3);
			await openDashboard(page);
			await unzoomToday(page);
			expect(await fitState(page, todayKey())).toMatchObject({ visible: 3, more: 0 });
		});

		test("+N zooms that day", async ({ page }) => {
			await seedToday(page, 14);
			await openDashboard(page);
			await unzoomToday(page);
			await setStripHeight(page, 240);
			await page.locator(`${STRIP} [data-strip-day="${todayKey()}"] [data-show-more]`).click();
			await expect(headerBtn(page, todayKey())).toHaveAttribute("aria-pressed", "true");
		});

		test("long names at the minimum track are never clipped", async ({ page }) => {
			await seedToday(page, 10, LONG);
			await openDashboard(page);
			await setStripWidth(page, 660); // full mode; unzoomed days sit near the 64px floor
			await unzoomToday(page);
			await settle(page);
			const s = await fitState(page, todayKey());
			expect(s.visible).toBeGreaterThan(0);
			expect(s.lastBottom).toBeLessThanOrEqual(s.bodyBottom + 0.5);
			expect(s.hOverflow).toBeLessThanOrEqual(0);
		});

		test("toggling Visits re-fits", async ({ page }) => {
			await seedToday(page, 14);
			await openDashboard(page);
			await unzoomToday(page);
			const before = await fitState(page, todayKey());
			const visits = page.locator(STRIP).getByRole("button", { name: "Visits" });
			await visits.click();
			expect(await fitState(page, todayKey())).toMatchObject({ visible: 0, more: 0 });
			await visits.click();
			expect(await fitState(page, todayKey())).toMatchObject({
				visible: before.visible,
				more: before.more,
			});
		});

		test("an empty day shows no +N", async ({ page }) => {
			await seedToday(page, 14);
			await openDashboard(page);
			const days = await dayKeys(page, STRIP);
			const empty = days.find((d) => d !== todayKey())!;
			expect(await fitState(page, empty)).toMatchObject({ visible: 0, more: 0 });
		});
	});

	test("only the zoomed day offers 'open in schedule', and it opens that week", async ({ page }) => {
		await openDashboard(page);
		const open = page.locator(`${STRIP} [data-day-header] button[aria-label$="in schedule"]`);
		await expect(open).toHaveCount(1);
		await expect(
			page.locator(`${STRIP} [data-day-header="${todayKey()}"] button[aria-label$="in schedule"]`)
		).toHaveCount(1);
		await open.click();
		await expect(page).toHaveURL(new RegExp(`/dispatch/schedule\\?week=${todayKey()}&zoom=1$`));
		await expect(
			page.locator(`main [data-day-header="${todayKey()}"] button[aria-pressed]`)
		).toHaveAttribute("aria-pressed", "true");
	});

	test.describe("expanded day itinerary", () => {
		const MEDIUM = "Furnace Replacement - Smith Residence";

		for (const width of [1440, 1280]) {
			test(`titles wrap to two lines at most on a busy day at ${width}`, async ({ page }) => {
				await seedToday(page, 10, MEDIUM);
				await openDashboard(page, width);
				const col = page.locator(`${STRIP} [data-strip-day="${todayKey()}"]`);
				await expect(col.locator("[data-agenda-row]")).toHaveCount(10);
				await expect(col.locator("[data-agenda-title]").first()).toHaveCSS("-webkit-line-clamp", "2");
				const heights = await col
					.locator("[data-agenda-title]")
					.evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect().height));
				// 11px × 1.3 leading: wrapped past one line, never past two.
				expect(Math.max(...heights)).toBeGreaterThan(15);
				expect(Math.max(...heights)).toBeLessThanOrEqual(29);
				await expect(col.locator("[data-agenda-below]")).toBeVisible();
			});
		}

		test("past capacity, +N below counts hidden rows and pages to the end", async ({
			page,
		}) => {
			await seedToday(page, 10, MEDIUM);
			await openDashboard(page);
			const col = page.locator(`${STRIP} [data-strip-day="${todayKey()}"]`);
			const bar = col.locator("[data-agenda-below]");
			await expect(bar).toBeVisible();
			// Nothing bleeds between the bar and the body's bottom edge (the body is padded).
			const bleed = await col.locator("[data-strip-body]").evaluate((body) => {
				const b = body.getBoundingClientRect();
				const hit = document.elementFromPoint(b.left + b.width / 2, b.bottom - 1.5);
				return !!hit?.closest("[data-agenda-row]");
			});
			expect(bleed).toBe(false);
			const hidden = () =>
				col.locator("[data-strip-body]").evaluate((body) => {
					const cut = body.querySelector("[data-agenda-below]")!.getBoundingClientRect().top;
					return [...body.querySelectorAll("[data-agenda-row]")].filter(
						(r) => r.getBoundingClientRect().bottom > cut + 0.5
					).length;
				});
			const n = await hidden();
			expect(n).toBeGreaterThan(1);
			await expect(bar).toHaveText(`+${n} below`);
			// One page reaches the end here: every hidden row shows and the empty bar goes invisible.
			await bar.click();
			await expect.poll(hidden).toBe(0);
			await expect(bar).toBeHidden();
		});

		test("+N below pages the next set to the top and moves keyboard focus onto it", async ({
			page,
		}) => {
			await seedToday(page, 24, MEDIUM);
			await openDashboard(page);
			const col = page.locator(`${STRIP} [data-strip-day="${todayKey()}"]`);
			const body = col.locator("[data-strip-body]");
			const bar = col.locator("[data-agenda-below]");
			await expect(bar).toBeVisible();
			const firstHidden = await body.evaluate((b) => {
				const cut = b.querySelector("[data-agenda-below]")!.getBoundingClientRect().top;
				return [...b.querySelectorAll("[data-agenda-row]")].findIndex(
					(r) => r.getBoundingClientRect().bottom > cut + 0.5
				);
			});
			const n = Number((await bar.textContent())!.match(/\d+/)![0]);
			await bar.focus();
			await page.keyboard.press("Enter");
			const row = col.locator("[data-agenda-row]").nth(firstHidden);
			await expect(row).toBeFocused();
			const offset = await body.evaluate((b, i) => {
				const top =
					b.getBoundingClientRect().top + b.clientTop + parseFloat(getComputedStyle(b).paddingTop);
				return b.querySelectorAll("[data-agenda-row]")[i].getBoundingClientRect().top - top;
			}, firstHidden);
			expect(Math.abs(offset)).toBeLessThanOrEqual(1);
			// The count follows the scroll event, a frame after focus lands.
			await expect
				.poll(async () => Number((await bar.textContent())!.match(/\d+/)![0]))
				.toBeLessThan(n - 1);
		});

		test("a long unbroken title breaks and clamps to two lines inside its row", async ({ page }) => {
			const unbroken = "X".repeat(120);
			await seedToday(page, 10, unbroken);
			await openDashboard(page);
			const col = page.locator(`${STRIP} [data-strip-day="${todayKey()}"]`);
			const title = col.locator("[data-agenda-title]").first();
			await expect(title).toHaveCSS("-webkit-line-clamp", "2");
			expect((await title.boundingBox())!.height).toBeLessThanOrEqual(29);
			const fits = await col.locator("[data-strip-body]").evaluate((body) => {
				const b = body.getBoundingClientRect();
				return [...body.querySelectorAll("[data-agenda-row]")].every(
					(r) => r.getBoundingClientRect().right <= b.right + 0.5
				);
			});
			expect(fits).toBe(true);
			expect((await col.boundingBox())!.width).toBeLessThanOrEqual(241);
		});

		for (const width of [1440, 1024]) {
			test(`header is one quiet line at ${width}`, async ({ page }) => {
				await seedToday(page, 3);
				await openDashboard(page, width);
				const header = page.locator(`${STRIP} [data-agenda-header]`);
				expect((await header.boundingBox())!.height).toBeLessThanOrEqual(20);
				await expect(page.locator(STRIP).getByText(/sort by/i)).toHaveCount(0);
			});
		}

		test("long titles keep their full text but show two lines at most", async ({ page }) => {
			await seedToday(page, 3, LONG);
			await openDashboard(page);
			const title = page.locator(`${STRIP} [data-agenda-title]`).first();
			await expect(title).toHaveText(LONG);
			await expect(title).toHaveCSS("-webkit-line-clamp", "2");
			expect((await title.boundingBox())!.height).toBeLessThanOrEqual(29);
			await expect(page.locator(`${STRIP} [data-agenda-row]`).first()).toHaveAttribute("title", LONG);
		});

		test("anytime visits say Anytime and lead the list", async ({ page }) => {
			await seedToday(page, 2, undefined, { anytime: 1 });
			await openDashboard(page);
			const rows = page.locator(`${STRIP} [data-agenda-row]`);
			await expect(rows.first()).toHaveAttribute("aria-label", /^Anytime, /);
			await expect(page.locator(`${STRIP} [data-agenda-rail]`).first()).toHaveText("Anytime");
			await expect(page.locator(STRIP).getByText("12:00")).toHaveCount(0);
		});

		test("sort switch exposes state and Tech sort groups by technician", async ({ page }) => {
			await seedToday(page, 3);
			await openDashboard(page);
			const agenda = page.locator(`${STRIP} [data-day-agenda]`);
			await expect(agenda.getByRole("button", { name: "Time" })).toHaveAttribute("aria-pressed", "true");
			await expect(agenda.locator("[data-agenda-dots]").first()).toBeVisible();
			await agenda.getByRole("button", { name: "Tech" }).click();
			await expect(agenda.getByRole("button", { name: "Tech" })).toHaveAttribute("aria-pressed", "true");
			await expect(agenda.locator("[data-agenda-group]").first()).toBeVisible();
			await expect(agenda.locator("[data-agenda-dots]")).toHaveCount(0);
		});

		test("rows stay draggable", async ({ page }) => {
			await seedToday(page, 2);
			await openDashboard(page);
			await expect(page.locator(`${STRIP} [data-agenda-row]`).first()).toHaveAttribute(
				"draggable",
				"true"
			);
		});

		test("today shows the now rule after the visits that have started", async ({ page }) => {
			const d = new Date();
			await page.clock.setFixedTime(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 15));
			await seedToday(page, 3); // 08:00–08:02, all started by 10:15
			await openDashboard(page);
			const agenda = page.locator(`${STRIP} [data-day-agenda]`);
			await expect(agenda.locator("[data-now-rule]")).toHaveCount(1);
			const order = await agenda
				.locator("[data-agenda-row], [data-now-rule]")
				.evaluateAll((els) => els.map((e) => (e.hasAttribute("data-now-rule") ? "now" : "row")));
			expect(order).toEqual(["row", "row", "row", "now"]);
		});

		test("dragging a row onto another day asks to reschedule; cancel puts it back", async ({ page }) => {
			// Belt and braces: this test must never persist a reschedule.
			await page.route(/\/(job-visits|visits|jobs)\//, (route) =>
				route.request().method() === "GET" ? route.continue() : route.abort()
			);
			await seedToday(page, 2);
			await openDashboard(page);
			const days = await dayKeys(page, STRIP);
			const other = days.find((d) => d !== todayKey())!;
			const agenda = page.locator(`${STRIP} [data-strip-day="${todayKey()}"] [data-day-agenda]`);
			const row = agenda.locator("[data-agenda-row]").first();
			const label = (await row.getAttribute("aria-label"))!;

			await row.dragTo(page.locator(`${STRIP} [data-strip-day="${other}"] [data-strip-body]`));
			await expect(page.getByText("Reschedule Visit")).toBeVisible();
			await expect(agenda.locator(`[data-agenda-row][aria-label="${label}"]`)).toHaveCount(0);

			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await expect(page.getByText("Reschedule Visit")).toHaveCount(0);
			const back = agenda.locator(`[data-agenda-row][aria-label="${label}"]`);
			await expect(back).toHaveCount(1);
			await expect(back).toHaveCSS("opacity", "1");
			await expect(back).toHaveCSS("outline-style", "none");
		});
	});

	test("hovering a day's body reveals its zoom button", async ({ page }) => {
		await openDashboard(page);
		const day = await page
			.locator(`${STRIP} [data-strip-day]`)
			.evaluateAll((els, today) => els.map((e) => e.getAttribute("data-strip-day")!).find((d) => d !== today)!, todayKey());
		const btn = headerBtn(page, day);
		const opacity = () => btn.evaluate((e) => getComputedStyle(e).opacity);
		await page.mouse.move(0, 0);
		await expect.poll(opacity).toBe("0");
		await page.locator(`${STRIP} [data-strip-day="${day}"] [data-strip-body]`).hover();
		await expect.poll(opacity).toBe("1");
	});
});
