import { test, expect, Page } from "@playwright/test";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * The top-right user badge in the dispatch nav. Same family-collision check as
 * the dashboard technician badge, but the underline here encodes interaction
 * state (closed / hovered / open) rather than domain status, so what's verified
 * is that each state is distinguishable from the fill and from the others.
 */

const rgb = (s: string) => s.replace(/\s/g, "");

function badge(page: Page) {
	return page.locator("header button, nav button").filter({ hasText: /^[A-Z]$/ }).last();
}

async function styles(page: Page) {
	return badge(page).evaluate((el) => {
		const cs = getComputedStyle(el);
		return {
			bg: cs.backgroundColor,
			underline: cs.borderBottomColor,
			text: cs.color,
			underlineWidth: cs.borderBottomWidth,
		};
	});
}

for (const theme of ["dark", "light"] as const) {
	test(`${theme} — nav badge fill, hover and open states are all distinguishable`, async ({ page }) => {
		await page.addInitScript((t) => {
			window.localStorage.setItem("theme-preference", JSON.stringify({ state: { theme: t } }));
		}, theme);
		await page.setViewportSize({ width: 1600, height: 1000 });
		await loginAsDispatcher(page);
		await page.goto("/dispatch");
		await expect(badge(page)).toBeVisible({ timeout: 15000 });

		const rest = await styles(page);
		await badge(page).hover();
		await page.waitForTimeout(400);
		const hovered = await styles(page);
		await badge(page).click();
		await page.waitForTimeout(400);
		const open = await styles(page);

		test.info().annotations.push({
			type: "measurement",
			description: JSON.stringify({ rest, hovered, open }),
		});

		expect(rest.underlineWidth).toBe("3px");

		// The reported defect: a grey underline on a grey fill.
		expect(rgb(hovered.underline), "hover underline must not equal the fill").not.toBe(rgb(hovered.bg));
		expect(rgb(open.underline), "open underline must not equal the fill").not.toBe(rgb(open.bg));

		// Each state has to be readable as a different state.
		expect(rgb(hovered.underline)).not.toBe(rgb(rest.underline));
		expect(rgb(open.underline)).not.toBe(rgb(hovered.underline));

		// Fill must no longer come from the border family, in either theme.
		const borderFamily = ["rgb(113,113,122)", "rgb(178,188,201)"];
		expect(borderFamily).not.toContain(rgb(rest.bg));
	});
}
