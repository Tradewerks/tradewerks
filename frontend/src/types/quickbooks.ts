import { BarChart3, Scale, Waves, ListChecks, BookOpen, type LucideIcon } from "lucide-react";
import type { InventoryItem } from "./inventory"

export interface QBItemLite {
    Id: string;
    Name: string;
    Sku?: string;
    Description?: string;
    Type?: string;
    UnitPrice?: number;
    PurchaseCost?: number;
    QtyOnHand?: number;
    Active?: boolean;
}

export interface MappedQBItem {
    inventory_item_id: string;
    external_id: string;
}

export interface MappedQBCustomer {
    client_id: string;
    external_id: string;
}

// Mirrors QBVendorRow in backend/src/services/qb/qbVendors.ts.
export interface QBVendorLite {
    Id: string;
    DisplayName: string;
    CompanyName?: string;
    AcctNum?: string;
    PrimaryPhone?: { FreeFormNumber?: string };
    PrimaryEmailAddr?: { Address?: string };
    Active?: boolean;
    /** Set when this QBO vendor already maps to one of our suppliers. */
    linkedSupplierId: string | null;
    /**
     * An unlinked supplier with the same normalized name. Offered so the operator
     * links what they already have instead of importing a second copy of it.
     */
    suggestedSupplierId: string | null;
    suggestedSupplierName: string | null;
}

export interface MappedQBVendor {
    supplier_id: string;
    external_id: string;
}

// Mirrors QBEmployeeRow in backend/src/services/qb/qbEmployees.ts.
export interface QBEmployeeLite {
    Id: string;
    DisplayName: string;
    GivenName?: string;
    FamilyName?: string;
    PrimaryPhone?: { FreeFormNumber?: string };
    PrimaryEmailAddr?: { Address?: string };
    Active?: boolean;
    /** Set when this QBO employee already maps to one of our technicians. */
    linkedTechnicianId: string | null;
    /** An unlinked technician matching by email, else by name. */
    suggestedTechnicianId: string | null;
    suggestedTechnicianName: string | null;
}

export interface MappedQBEmployee {
    technician_id: string;
    external_id: string;
}

export interface ImportQBItemResult{
    item: InventoryItem;
    warning?: string;
}

export interface QBTaxCodeLite {
    id: string;
    name: string;
    rates: { id: string; name: string; rate: number }[];
    totalRate: number;
}

export interface QBImportableInvoice {
    Id: string;
    DocNumber: string | null;
    TxnDate: string | null;
    DueDate: string | null;
    TotalAmt: number;
    customerId: string | null;
    customerName: string | null;
    lineCount: number;
    alreadyImported: boolean;
}

export interface QBInvoiceImportResult {
    imported: number;
    skipped: number;
    errors: string[];
}

export interface QBInvoicePrefillLineItem {
    name: string;
    description: string | null;
    quantity: number;
    unit_price: number;
    inventory_item_id: string | null;
}

export interface QBInvoicePrefill {
    qbInvoiceId: string;
    docNumber: string | null;
    txnDate: string | null;
    dueDate: string | null;
    memo: string | null;
    customerId: string | null;
    customerName: string | null;
    clientId: string | null;
    alreadyImported: boolean;
    lineItems: QBInvoicePrefillLineItem[];
}

export interface QBProfitAndLossQuery {
    customer?: string;
    start_date?: string;
    end_date?: string;
    accounting_method?: "Cash" | "Accrual";
    date_macro?: string;
    summarize_column_by?: string;
    class?: string;
    department?: string;
    vendor?: string;
    item?: string;
    sort_order?: "ascend" | "descend";
    qzurl?: "true" | "false";
    adjusted_gain_loss?: "true" | "false";
}

export interface QBProfitAndLossReport {
  Header: ReportHeader;
  Rows: ReportRows;
  Columns: ReportColumns;
}

interface ReportHeader {
  Customer?: string;
  ReportName: string;
  ReportBasis: string;
  StartPeriod: string;
  EndPeriod: string;
  Currency?: string;
  Time: string;
  SummarizeColumnsBy?: string;
  Option?: ReportOption[];
}

interface ReportOption {
  Name: string;
  Value: string;
}

interface ReportColumns {
  Column: ReportColumn[];
}

interface ReportColumn {
  ColType: string;
  ColTitle: string;
  MetaData?: ReportMetaData[];
}

interface ReportMetaData {
  Name: string;
  Value: string;
}

interface ReportRows {
  Row: ReportRow[];
}

interface ReportRow {
  type: "Section" | "Data" | string;
  group?: string;

  Header?: ReportHeaderRow;
  Rows?: ReportRows;
  Summary?: ReportSummary;

  ColData?: ReportColData[];
}

interface ReportHeaderRow {
  ColData: ReportColData[];
}

interface ReportSummary {
  ColData: ReportColData[];
}

interface ReportColData {
  id?: string;
  value: string;
}

export type QBReportTypeId = "ProfitAndLoss" | "BalanceSheet" | "CashFlow" | "TrialBalance" | "GeneralLedger";

export interface QBReportTypeMeta {
  id: QBReportTypeId;
  label: string;
  description: string;
  icon: LucideIcon;
  /**
   * Whether QBO's `customer` report filter actually narrows this report type.
   * Confirmed empirically against a live sandbox: ProfitAndLoss/GeneralLedger/
   * CashFlow all changed output when filtered by customer; TrialBalance ignored
   * the param entirely. BalanceSheet did change but in a way that doesn't map
   * to a coherent "balance sheet for this customer" (it's a point-in-time
   * statement, not customer-scoped) — left off to avoid a misleading report.
   */
  supportsClientFilter?: boolean;
};

export const QB_REPORT_TYPES: QBReportTypeMeta[] = [
  { id: "ProfitAndLoss", label: "Profit & Loss", description: "Income and expenses over a period", icon: BarChart3, supportsClientFilter: true },
  { id: "BalanceSheet", label: "Balance Sheet", description: "Assets, liabilities, and equity as of a date", icon: Scale },
  { id: "CashFlow", label: "Cash Flow", description: "Cash in/out across operating, investing, financing", icon: Waves, supportsClientFilter: true },
  { id: "TrialBalance", label: "Trial Balance", description: "Debit/credit balances by account", icon: ListChecks },
  { id: "GeneralLedger", label: "General Ledger", description: "Detailed transaction ledger by account", icon: BookOpen, supportsClientFilter: true },
];

export type QBReportQuery = QBProfitAndLossQuery;

export type QBReportPayload = QBProfitAndLossReport;

// Mirrors backend/src/services/qb/qbPurchases.ts.

/** QuickBooks reference object, e.g. VendorRef / APAccountRef. */
export interface QBRef {
    value: string;
    name?: string;
}

export interface QBMetaData {
    CreateTime: string;
    LastUpdatedTime: string;
}

/** A QBO postal address (ShipAddr / VendorAddr). Line1-5 are free-form, printable lines. */
export interface QBAddress {
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

export interface QBEmailAddress {
    Address: string;
}

export interface QBCustomField {
    DefinitionId: string;
    Name: string;
    Type: string; // "StringType", etc.
    StringValue?: string;
}

export interface QBItemBasedExpenseLineDetail {
    ItemRef: QBRef;
    CustomerRef?: QBRef;
    ClassRef?: QBRef;
    TaxCodeRef?: QBRef;
    PriceLevelRef?: QBRef;
    MarkupInfo?: { Percent?: number; PriceLevelRef?: QBRef };
    Qty?: number;
    UnitPrice?: number;
    BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled";
}

export interface QBAccountBasedExpenseLineDetail {
    AccountRef: QBRef;
    CustomerRef?: QBRef;
    ClassRef?: QBRef;
    TaxCodeRef?: QBRef;
    BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled";
}

export interface QBPurchaseOrderLine {
    Id?: string;
    LineNum?: number;
    Description?: string;
    Amount: number;
    DetailType: "ItemBasedExpenseLineDetail" | "AccountBasedExpenseLineDetail";
    ProjectRef?: QBRef;
    ItemBasedExpenseLineDetail?: QBItemBasedExpenseLineDetail;
    AccountBasedExpenseLineDetail?: QBAccountBasedExpenseLineDetail;
}

export interface QBPurchaseOrder {
    Id: string;
    SyncToken: string;
    domain: string;
    sparse: boolean;
    DocNumber?: string;
    TxnDate: string;
    TotalAmt: number;
    POStatus?: "Open" | "Closed";
    EmailStatus?: "NotSet" | "NeedToSend" | "EmailSent";
    POEmail?: QBEmailAddress;
    APAccountRef: QBRef;
    CurrencyRef?: QBRef;
    VendorRef: QBRef;
    ShipAddr?: QBAddress;
    VendorAddr?: QBAddress;
    Line: QBPurchaseOrderLine[];
    CustomField?: QBCustomField[];
    MetaData: QBMetaData;
}