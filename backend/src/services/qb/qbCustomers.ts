import { getValidToken, qbFetch, QB_BASE } from "../quickbooksService.js"
import { getScopedDb } from "../../lib/context.js";
import { db } from "../../db.js";
import { ErrorCodes, httpError } from "../../types/responses.js";
import { getOrgRealmId } from "../quickbooksService.js";

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

export async function findOrCreateQBCustomer(orgId: string, displayName: string): Promise<string> {
    const { accessToken, realmId } = await getValidToken(orgId);
    const escaped = displayName.replace(/'/g, "\\'");
    const qs = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${escaped}'`);
    const url = `${QB_BASE}/v3/company/${realmId}/query?query=${qs}&minorversion=75`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const data = (await res.json());
    const existing = data?.QueryResponse?.Customer;
    if (existing?.length) return existing[0].Id as string;

    const created = (await qbFetch(orgId, "POST", "/customer", {
        DisplayName: displayName,
    })) as any;
    return created.Customer.Id as string;
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
    const existing = await db.client_external_mapping.findFirst({
        where: {
            provider: "quickbooks",
            client_id: clientId,
            account_id: accountId,
            client: { organization_id: orgId },
        }
    });
    if (existing) return existing.external_id;

    const qbClientId = await findOrCreateQBCustomer(orgId, client.name);
    await db.client_external_mapping.create({
        data: {
            client_id: clientId,
            external_id: qbClientId,
            provider: "quickbooks",
            account_id: accountId
        }
    });
    return qbClientId;
};