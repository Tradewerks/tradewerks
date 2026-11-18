import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import type { Request } from "express";
import { Reader, type Response as MmdbRecord } from "mmdb-lib";
import { log } from "../services/appLogger.js";

// Self-serve signup is open only to businesses in the United States, ahead of the
// Terms saying so. The region comes from the visitor's IP address, so anyone
// outside the US is refused unless they connect through a US VPN (or claim a US
// address); the register form also has them confirm their business is US-based,
// and that confirmation is the commitment the Terms rely on.
//
// The country database ships with the backend (@ip-location-db, CC0, built from
// RIR and ASN data; country statistics (c) NRO, nro.net, CC BY 4.0) so no client
// IP is ever sent to a third-party lookup. GEOIP_COUNTRY_DB_PATH may point at a
// MaxMind GeoLite2/GeoIP2 Country .mmdb instead, which is more accurate and
// refreshed weekly.
//
// The 50 states, DC and the inhabited territories. ISO 3166 gives the territories
// their own codes, and the product already serves them (Puerto Rico has its own
// timezone option at signup).
export const SIGNUP_COUNTRIES: ReadonlySet<string> = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM"]);

export const SIGNUP_REGION_MESSAGE =
	"TradeWerks is currently available only to businesses located in the United States.";

type CountryRecord = { country_code?: string; country?: { iso_code?: string } };

let reader: Reader<MmdbRecord> | null | undefined;

function openReader(): Reader<MmdbRecord> | null {
	if (reader !== undefined) return reader;
	const custom = process.env.GEOIP_COUNTRY_DB_PATH?.trim();
	try {
		const file =
			custom ||
			createRequire(import.meta.url).resolve(
				"@ip-location-db/geo-whois-asn-country-mmdb/geo-whois-asn-country.mmdb",
			);
		reader = new Reader<MmdbRecord>(readFileSync(file));
	} catch (err) {
		// Logged once; signups keep working on the attestation alone until fixed.
		log.error({ err, custom: !!custom }, "Signup country database could not be loaded; region check is off");
		reader = null;
	}
	return reader;
}

// Private, shared and documentation ranges. They are never a client's real
// location, and the bundled data assigns some of them a country anyway
// (192.168/16 and Docker's 172.16/12 come back as AU), which would refuse a
// signup made from inside a private network.
const NOT_PUBLIC = new BlockList();
for (const [net, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
	["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
	["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NOT_PUBLIC.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
	["::", 127], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NOT_PUBLIC.addSubnet(net, prefix, "ipv6");

const normalizeIp = (ip: string | undefined): string | null => {
	if (!ip) return null;
	const v = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
	return isIP(v) ? v : null;
};

const publicIp = (ip: string | undefined): string | null => {
	const addr = normalizeIp(ip);
	if (!addr) return null;
	return NOT_PUBLIC.check(addr, isIP(addr) === 4 ? "ipv4" : "ipv6") ? null : addr;
};

/** ISO country code for a public IP, or null when it is private, reserved or unknown. */
export function countryForIp(ip: string | undefined): string | null {
	const addr = publicIp(ip);
	if (!addr) return null;
	const r = openReader();
	if (!r) return null;
	try {
		// ip-location-db records are { country_code }; MaxMind's are { country: { iso_code } }.
		const rec = r.get(addr) as CountryRecord | null;
		const code = rec?.country_code ?? rec?.country?.iso_code;
		return code ? code.toUpperCase() : null;
	} catch {
		return null;
	}
}

export interface SignupRegion {
	allowed: boolean;
	country: string | null;
}

// "1.2.3.4:5678" and "[2001:db8::1]:443": some proxies append the port.
const stripPort = (v: string): string => {
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
	if (bracketed) return bracketed[1];
	const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
	return v4 ? v4[1] : v;
};

/**
 * The address the visitor says they are connecting from: the first
 * X-Forwarded-For entry when a proxy is in front (Render), else the connection's
 * own address. Deliberately not req.ip, whose meaning depends on the app-wide
 * trust proxy setting. Anyone can write that header themselves, and that is
 * accepted: like a VPN, it is someone choosing to misstate where they are, which
 * the US-business confirmation at signup covers.
 */
export function visitorIp(req: Pick<Request, "ip" | "headers">): string | undefined {
	const raw = req.headers["x-forwarded-for"];
	const first = (Array.isArray(raw) ? raw[0] : raw)?.split(",")[0]?.trim();
	return first ? stripPort(first) : req.ip;
}

/**
 * Decides whether this request may create an organization. An unknown country
 * (local development, a private address) is let through and logged, rather than
 * closing signups for everyone.
 */
export function signupRegion(req: Pick<Request, "ip" | "headers">): SignupRegion {
	const ip = visitorIp(req);
	const country = countryForIp(ip);
	if (country) return { allowed: SIGNUP_COUNTRIES.has(country), country };

	log.warn(
		{ evt: "signup.region_unknown", publicIp: publicIp(ip) !== null },
		"Signup country unknown; allowing.",
	);
	return { allowed: true, country: null };
}
