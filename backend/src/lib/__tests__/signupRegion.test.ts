import { describe, it, expect } from "vitest";
import { countryForIp, signupRegion, visitorIp, SIGNUP_COUNTRIES } from "../signupRegion.js";

const req = (ip: string | undefined, headers: Record<string, string> = {}) => ({ ip, headers });


describe("countryForIp (bundled database)", () => {
	it.each([
		["8.8.8.8", "US"],
		["2600:1700::1", "US"],
		["66.50.0.1", "PR"],
		["81.2.69.142", "GB"],
		["24.48.0.1", "CA"],
	])("%s is %s", (ip, country) => {
		expect(countryForIp(ip)).toBe(country);
	});

	it("reads an IPv4-mapped IPv6 address as the IPv4 address", () => {
		expect(countryForIp("::ffff:8.8.8.8")).toBe("US");
	});

	// The data gives some of these a country (192.168/16 and 172.16/12 read as AU).
	it.each([
		"10.0.0.1", "127.0.0.1", "::1", "192.168.1.20", "172.20.0.5", "100.64.0.1",
		"198.51.100.7", "203.0.113.9", "fd12::1", "fe80::1", "::ffff:192.168.0.1",
		"not-an-ip", "", undefined,
	])(
		"has no country for %s",
		(ip) => {
			expect(countryForIp(ip)).toBeNull();
		},
	);
});

describe("visitorIp", () => {
	it("takes the first X-Forwarded-For entry: the address the visitor reached the edge from", () => {
		expect(visitorIp(req("10.0.4.7", { "x-forwarded-for": "81.2.69.142, 172.71.0.5, 10.0.0.2" }))).toBe("81.2.69.142");
	});

	it("uses the connection's address when no proxy is in front", () => {
		expect(visitorIp(req("8.8.8.8"))).toBe("8.8.8.8");
	});

	it("drops a port some proxies append", () => {
		expect(visitorIp(req(undefined, { "x-forwarded-for": "81.2.69.142:51234" }))).toBe("81.2.69.142");
		expect(visitorIp(req(undefined, { "x-forwarded-for": "[2600:1700::1]:443" }))).toBe("2600:1700::1");
	});
});

describe("signupRegion", () => {
	it("allows the US and its territories and refuses everywhere else", () => {
		expect(signupRegion(req("8.8.8.8"))).toEqual({ allowed: true, country: "US" });
		expect(signupRegion(req("66.50.0.1"))).toEqual({ allowed: true, country: "PR" });
		expect(signupRegion(req("81.2.69.142"))).toEqual({ allowed: false, country: "GB" });
		expect(signupRegion(req("24.48.0.1"))).toEqual({ allowed: false, country: "CA" });
		expect([...SIGNUP_COUNTRIES].sort()).toEqual(["AS", "GU", "MP", "PR", "UM", "US", "VI"]);
	});

	it("judges the visitor behind Render's proxy, not the proxy", () => {
		const behindProxy = (visitor: string) => req("10.0.4.7", { "x-forwarded-for": `${visitor}, 10.0.0.2` });
		expect(signupRegion(behindProxy("81.2.69.142"))).toEqual({ allowed: false, country: "GB" });
		expect(signupRegion(behindProxy("8.8.8.8"))).toEqual({ allowed: true, country: "US" });
	});

	it("accepts a US address the visitor wrote into the header themselves, like a US VPN", () => {
		expect(signupRegion(req("10.0.4.7", { "x-forwarded-for": "8.8.8.8, 81.2.69.142" }))).toEqual({
			allowed: true,
			country: "US",
		});
	});

	it("lets an unknown origin through rather than closing signups (local dev, private networks)", () => {
		expect(signupRegion(req("10.1.2.3"))).toEqual({ allowed: true, country: null });
		expect(signupRegion(req(undefined))).toEqual({ allowed: true, country: null });
		expect(signupRegion(req(undefined, { "x-forwarded-for": "garbage" }))).toEqual({ allowed: true, country: null });
	});
});
