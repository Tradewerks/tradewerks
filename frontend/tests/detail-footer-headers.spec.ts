import { test, expect, Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { loginAsDispatcher } from "./fixtures/auth";

/**
 * Measurement harness for the detail-page footer + header contract, not an
 * assertion suite. For every side-by-side card row it reports the bottom of the
 * last painted CARD in each column (never the grid cell — stretched cells are
 * always equal, so a cell measurement cannot fail) and each column's first header
 * divider. It also reports any Card header row that is not 57px.
 *
 * Targets come from FOOTER_TARGETS (a JSON file of {name, path}) so the record
 * mix — with/without field purchases, invoices — is picked against live data.
 */

type Target = { name: string; path: string };
const targets: Target[] = JSON.parse(readFileSync(process.env.FOOTER_TARGETS ?? "", "utf8"));

async function measure(page: Page) {
	return page.evaluate(() => {
		const isCard = (el: Element) =>
			el.classList.contains("rounded-xl") && getComputedStyle(el).borderTopWidth !== "0px";
		const topLevelCards = (root: Element) =>
			[root, ...root.querySelectorAll("*")].filter((c) => {
				if (!isCard(c)) return false;
				for (let p = c.parentElement; p && p !== root.parentElement; p = p.parentElement)
					if (isCard(p)) return false;
				return true;
			});

		const rows: unknown[] = [];
		for (const g of document.querySelectorAll("main .grid")) {
			if (getComputedStyle(g).gridTemplateColumns.split(" ").length < 2) continue;
			const kids = [...g.children].filter((k) => k.getBoundingClientRect().height > 0);
			const firstTop = Math.min(...kids.map((k) => k.getBoundingClientRect().top));
			const row = kids.filter((k) => Math.abs(k.getBoundingClientRect().top - firstTop) < 2);
			if (row.length < 2) continue;
			const cols = row.map((k) => {
				const cards = topLevelCards(k);
				if (!cards.length) return null;
				const last = cards.reduce((a, b) =>
					b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a
				);
				const hdr = cards[0].querySelector(":scope > [class*=\"min-h-[57px]\"]");
				return {
					title: cards[0].querySelector("h3")?.textContent ?? "(untitled)",
					bottom: Math.round(last.getBoundingClientRect().bottom),
					hdrBottom: hdr ? Math.round(hdr.getBoundingClientRect().bottom) : null,
				};
			});
			if (cols.some((c) => !c)) continue;
			const c = cols as { title: string; bottom: number; hdrBottom: number | null }[];
			const hdrs = c.map((x) => x.hdrBottom).filter((x): x is number => x !== null);
			rows.push({
				titles: c.map((x) => x.title).join(" | "),
				bottoms: c.map((x) => x.bottom).join(","),
				bottomDelta: Math.max(...c.map((x) => x.bottom)) - Math.min(...c.map((x) => x.bottom)),
				hdrDelta: hdrs.length === c.length ? Math.max(...hdrs) - Math.min(...hdrs) : "n/a",
			});
		}
		const oddHeaders = [...document.querySelectorAll("main [class*=\"min-h-[57px]\"]")]
			.map((h) => ({
				title: h.querySelector("h3")?.textContent,
				height: Math.round(h.getBoundingClientRect().height),
			}))
			.filter((h) => h.height !== 57);
		return { rows, oddHeaders };
	});
}

test.use({ viewport: { width: 1440, height: 900 } });

test("detail footers + headers", async ({ page }) => {
	test.setTimeout(240_000);
	await loginAsDispatcher(page);
	const report: Record<string, unknown> = {};
	for (const t of targets) {
		await page.goto(t.path);
		await expect(page.locator("main")).toBeVisible({ timeout: 15000 });
		await page.waitForLoadState("networkidle").catch(() => undefined);
		await page.waitForTimeout(800);
		report[t.name] = await measure(page);
		await page.screenshot({ path: `test-results/footer/${t.name}.png`, fullPage: true });
	}
	console.log(JSON.stringify(report, null, 1));
});
