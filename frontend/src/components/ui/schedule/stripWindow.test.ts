import { describe, it, expect } from "vitest";
import {
	colModeForWidth,
	defaultZoom,
	effectiveZoom,
	FULL_MIN_W,
	navLabels,
	shiftAnchor,
	visibleWindow,
	weekParamToMonday,
	windowLabel,
} from "./stripWindow";
import { STRIP_DAY_MIN_W, STRIP_ZOOMED_MIN_W } from "./weekTemplate";

const WEEK = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

describe("colModeForWidth", () => {
	it("switches at 640 and 350", () => {
		expect(colModeForWidth(640)).toBe("full");
		expect(colModeForWidth(639)).toBe("three");
		expect(colModeForWidth(350)).toBe("three");
		expect(colModeForWidth(349)).toBe("one");
	});

	it("full mode always has room for a readable zoomed day", () => {
		expect(FULL_MIN_W).toBeGreaterThanOrEqual(STRIP_ZOOMED_MIN_W + 6 * STRIP_DAY_MIN_W);
	});
});

describe("visibleWindow", () => {
	it("full: Monday–Sunday of the anchor's week", () => {
		expect(visibleWindow("2026-09-30", "full")).toEqual(WEEK);
		expect(visibleWindow("2026-10-04", "full")).toEqual(WEEK);
	});

	it("three: centred on the anchor, spanning weeks", () => {
		expect(visibleWindow("2026-09-28", "three")).toEqual(["2026-09-27", "2026-09-28", "2026-09-29"]);
	});

	it("three: survives the DST change", () => {
		expect(visibleWindow("2026-11-01", "three")).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
	});

	it("one: just the anchor", () => {
		expect(visibleWindow("2026-09-29", "one")).toEqual(["2026-09-29"]);
	});
});

describe("shiftAnchor", () => {
	it("pages by the visible count", () => {
		expect(shiftAnchor("2026-09-29", "full", -1)).toBe("2026-09-22");
		expect(shiftAnchor("2026-09-29", "three", 1)).toBe("2026-10-02");
		expect(shiftAnchor("2026-09-30", "one", 1)).toBe("2026-10-01");
	});
});

describe("windowLabel", () => {
	it("full week crossing months", () => {
		expect(windowLabel(WEEK, "full")).toBe("Sep 28 – Oct 4, 2026");
	});
	it("full week inside a month", () => {
		expect(windowLabel(visibleWindow("2026-10-07", "full"), "full")).toBe("Oct 5 – 11, 2026");
	});
	it("full week crossing years uses the end year", () => {
		expect(windowLabel(visibleWindow("2026-12-30", "full"), "full")).toBe("Dec 28 – Jan 3, 2027");
	});
	it("three days, no year", () => {
		expect(windowLabel(["2026-09-30", "2026-10-01", "2026-10-02"], "three")).toBe("Sep 30 – Oct 2");
		expect(windowLabel(["2026-10-05", "2026-10-06", "2026-10-07"], "three")).toBe("Oct 5 – 7");
	});
	it("one day", () => {
		expect(windowLabel(["2026-09-29"], "one")).toBe("Tue, Sep 29");
	});
});

describe("navLabels", () => {
	it("names the step", () => {
		expect(navLabels("full")).toEqual({ prev: "Previous week", next: "Next week" });
		expect(navLabels("three")).toEqual({ prev: "Previous 3 days", next: "Next 3 days" });
		expect(navLabels("one")).toEqual({ prev: "Previous day", next: "Next day" });
	});
});

describe("defaultZoom", () => {
	it("zooms today when the window contains it", () => {
		expect(defaultZoom(WEEK, "2026-09-29", "full")).toBe("2026-09-29");
		expect(defaultZoom(["2026-09-28", "2026-09-29", "2026-09-30"], "2026-09-29", "three")).toBe("2026-09-29");
	});
	it("starts unzoomed in a window without today", () => {
		expect(defaultZoom(visibleWindow("2026-10-07", "full"), "2026-09-29", "full")).toBeNull();
		expect(defaultZoom(["2026-10-01", "2026-10-02", "2026-10-03"], "2026-09-29", "three")).toBeNull();
	});
	it("one-day mode always zooms its only day", () => {
		expect(defaultZoom(["2026-10-07"], "2026-09-29", "one")).toBe("2026-10-07");
	});
});

describe("effectiveZoom", () => {
	it("keeps a zoomed day inside the window", () => {
		expect(effectiveZoom(WEEK, "2026-10-01", "full")).toBe("2026-10-01");
	});
	it("drops a zoomed day the window no longer shows (resize to 3-day)", () => {
		expect(effectiveZoom(["2026-09-28", "2026-09-29", "2026-09-30"], "2026-10-01", "three")).toBeNull();
	});
	it("one-day mode is always zoomed", () => {
		expect(effectiveZoom(["2026-09-29"], null, "one")).toBe("2026-09-29");
	});
	it("nothing zoomed stays unzoomed", () => {
		expect(effectiveZoom(WEEK, null, "full")).toBeNull();
	});
});

describe("weekParamToMonday", () => {
	it("returns the Monday of the week containing the date", () => {
		expect(weekParamToMonday("2026-09-30")).toBe("2026-09-28");
		expect(weekParamToMonday("2026-09-28")).toBe("2026-09-28");
		expect(weekParamToMonday("2026-10-04")).toBe("2026-09-28");
	});

	it("rejects absent, malformed and impossible dates", () => {
		expect(weekParamToMonday(null)).toBeNull();
		expect(weekParamToMonday("")).toBeNull();
		expect(weekParamToMonday("garbage")).toBeNull();
		expect(weekParamToMonday("2026-9-30")).toBeNull();
		expect(weekParamToMonday("2026-02-31")).toBeNull();
	});
});
