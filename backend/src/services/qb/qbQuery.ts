import { getValidToken } from "../quickbooksService.js";

const QB_ENV = (process.env.QB_ENVIRONMENT ?? "sandbox") as "sandbox" | "production";
const QB_BASE =
	QB_ENV === "production"
		? "https://quickbooks.api.intuit.com"
		: "https://sandbox-quickbooks.api.intuit.com";

// Paginated QB query. QB's query endpoint defaults to XML (must send
// Accept: application/json) and caps each page at 1000 rows, so loop on
// STARTPOSITION until a short page comes back.
export async function qbQueryAll<T>(orgId: string, entity: string, where?: string): Promise<T[]> {
	const { accessToken, realmId } = await getValidToken(orgId);
	const results: T[] = [];
	let start = 1;
	const pageSize = 1000;

	for (;;) {
		const sql = `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ""} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
		const url = `${QB_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=75`;
		const res = await fetch(url, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
			},
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`QB query ${entity} -> ${res.status}: ${text}`);
		}
		const data = (await res.json()) as any;
		const page = (data?.QueryResponse?.[entity] ?? []) as T[];
		results.push(...page);
		if (page.length < pageSize) break;
		start += pageSize;
	}
	return results;
}

/** Resolves an active QB account of the given AccountType, preferring one of the given AccountSubTypes if present. */
export async function getAccountId(orgId: string, accountType: string, preferredSubtypes: string[] = []): Promise<string> {
	const accounts = await qbQueryAll<any>(orgId, "Account", `AccountType = '${accountType}' AND Active = true`);
	if (!accounts.length) throw new Error(`No active ${accountType} account found`);

	const preferred = accounts.find((a: any) => preferredSubtypes.includes(a.AccountSubType));
	return preferred ? (preferred.Id as string) : (accounts[0].Id as string);
}
