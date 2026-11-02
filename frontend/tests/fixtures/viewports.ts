// Screen size minus 130px of browser chrome, the same convention as the Oct 30 laptop
// audit. 1229x691 is 1536x864 at 125% browser zoom.
export const VIEWPORTS: { name: string; width: number; height: number }[] = [
	{ name: "1280x590", width: 1280, height: 590 },
	{ name: "1229x691", width: 1229, height: 691 },
	{ name: "1366x638", width: 1366, height: 638 },
	{ name: "1536x734", width: 1536, height: 734 },
	{ name: "1440x770", width: 1440, height: 770 },
	{ name: "1920x950", width: 1920, height: 950 },
	{ name: "2560x1310", width: 2560, height: 1310 },
	{ name: "3440x1310", width: 3440, height: 1310 },
];
