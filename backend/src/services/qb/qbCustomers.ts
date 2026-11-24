import { getValidToken, qbFetch, QB_BASE } from "../quickbooksService.js"
import { getScopedDb } from "../../lib/context.js";
import { db } from "../../db.js";
import { ErrorCodes, httpError } from "../../types/responses.js";
import { getOrgRealmId } from "../quickbooksService.js";
import { QbHttpError } from "./qbHttpError.js";

export interface CustomerResponse {
  Customer: Customer;
  time: string;
}

export interface Customer {
  domain: string;
  PrimaryEmailAddr?: EmailAddress;
  DisplayName: string;
  CurrencyRef?: CurrencyRef;
  DefaultTaxCodeRef?: Reference;
  PreferredDeliveryMethod?: string;
  GivenName?: string;
  FullyQualifiedName: string;
  BillWithParent: boolean;
  Title?: string;
  Job: boolean;
  BalanceWithJobs: number;
  PrimaryPhone?: PhoneNumber;
  Taxable: boolean;
  MetaData: MetaData;
  BillAddr?: Address;
  MiddleName?: string;
  Notes?: string;
  Active: boolean;
  Balance: number;
  SyncToken: string;
  Suffix?: string;
  CompanyName?: string;
  FamilyName?: string;
  PrintOnCheckName?: string;
  sparse: boolean;
  Id: string;
}

export interface EmailAddress {
  Address: string;
}

export interface PhoneNumber {
  FreeFormNumber: string;
}

export interface CurrencyRef {
  value: string;
  name: string;
}

export interface Reference {
  value: string;
  name?: string;
}

export interface MetaData {
  CreateTime: string;
  LastUpdatedTime: string;
}

export interface Address {
  Id?: string;
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
  City?: string;
  Country?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Lat?: string;
  Long?: string;
}

export async function findQBCustomerByDisplayName(
    orgId: string,
    displayName: string,
): Promise<string | null> {
    const escaped = displayName.replace(/'/g, "\\'");
    const qs = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${escaped}'`);
    const data = (await qbFetch(orgId, "GET", `/query?query=${qs}`)) as {
        QueryResponse?: { Customer?: Array<{ Id: string }> };
    };
    return data?.QueryResponse?.Customer?.[0]?.Id ?? null;
}

export async function createQBCustomer(orgId: string, displayName: string): Promise<string> {
    const created = (await qbFetch(orgId, "POST", "/customer", {
        DisplayName: displayName,
    })) as { Customer: { Id: string } };
    return created.Customer.Id;
}

// QB "Duplicate Name Exists": DisplayName is unique across the company,
// inactive customers included.
function isDuplicateNameError(error: unknown): boolean {
    return (
        error instanceof QbHttpError &&
        error.status === 400 &&
        /"code"\s*:\s*"6240"/.test(error.message)
    );
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string })?.code === "P2002";
}

// Plan Decision 4: the bare name first (adopting an unmapped match), then
// "<name> (<id prefix>)", lengthening the prefix while that name is taken too.
function candidateDisplayNames(client: { id: string; name: string }): string[] {
    const names = [client.name];
    for (const len of [8, 13, 18, 23]) {
        if (client.id.length > len) names.push(`${client.name} (${client.id.slice(0, len)})`);
    }
    names.push(`${client.name} (${client.id})`);
    return [...new Set(names)];
}

async function findOwnMapping(
    orgId: string,
    clientId: string,
    accountId: string,
): Promise<string | null> {
    const own = await db.client_external_mapping.findFirst({
        where: {
            provider: "quickbooks",
            client_id: clientId,
            account_id: accountId,
            client: { organization_id: orgId },
        },
    });
    return own?.external_id ?? null;
}

/** Claims the QB customer named `displayName` for this client; null when another client owns it. */
async function claimByDisplayName(
    orgId: string,
    client: { id: string; name: string },
    accountId: string,
    displayName: string,
): Promise<string | null> {
    let qbId = await findQBCustomerByDisplayName(orgId, displayName);
    if (qbId === null) {
        try {
            qbId = await createQBCustomer(orgId, displayName);
        } catch (error) {
            if (!isDuplicateNameError(error)) throw error;
            // Either a concurrent push created it first (adopt theirs rather than
            // make a second customer), or an inactive customer holds the name and
            // the query cannot see it, so move on to the next name.
            qbId = await findQBCustomerByDisplayName(orgId, displayName);
            if (qbId === null) return null;
        }
    }

    const mappedElsewhere = await db.client_external_mapping.findFirst({
        where: {
            provider: "quickbooks",
            account_id: accountId,
            external_id: qbId,
            client_id: { not: client.id },
        },
    });
    if (mappedElsewhere) return null;

    try {
        await db.client_external_mapping.create({
            data: {
                client_id: client.id,
                provider: "quickbooks",
                account_id: accountId,
                external_id: qbId,
            },
        });
        return qbId;
    } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent push mapped this client first (use the winner's customer),
        // or another client just claimed this customer (try the next name).
        return findOwnMapping(orgId, client.id, accountId);
    }
}

/** The single resolver from a local client to its QuickBooks customer in this realm. */
export async function ensureQBCustomerForClient(
    orgId: string,
    client: { id: string; name: string },
    accountId: string,
): Promise<string> {
    const own = await findOwnMapping(orgId, client.id, accountId);
    if (own) return own;

    for (const displayName of candidateDisplayNames(client)) {
        const qbId = await claimByDisplayName(orgId, client, accountId, displayName);
        if (qbId) return qbId;
    }
    throw httpError(
        409,
        ErrorCodes.CONFLICT,
        `Every QuickBooks customer name for "${client.name}" is taken by another client`,
    );
}

export async function findAllQBCustomers(orgId: string): Promise<Customer[]> {
    const { accessToken, realmId } = await getValidToken(orgId);
    const qs = encodeURIComponent(`SELECT * FROM Customer`);
    const url = `${QB_BASE}/v3/company/${realmId}/query?query=${qs}&minorversion=75`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const data = (await res.json());
    const customers = data?.QueryResponse?.Customer as Customer[];

    return customers;
}

export async function pushClient(orgId: string, clientId: string): Promise<string> {
    const sdb = getScopedDb(orgId);
    const client = await sdb.client.findFirst({
        where: { id: clientId }
    });
    if (!client) {
        throw httpError(404, ErrorCodes.NOT_FOUND, "Client not found");
    }

    const accountId = await getOrgRealmId(orgId);
    return ensureQBCustomerForClient(orgId, client, accountId);
};