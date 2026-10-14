import { qbFetch } from "../quickbooksService.js";

export interface ProfitAndLossQuery {
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

export interface ProfitAndLossReport {
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

export const QB_REPORT_TYPES = ["ProfitAndLoss", "BalanceSheet", "CashFlow", "TrialBalance", "GeneralLedger"] as const;
export type QBReportType = typeof QB_REPORT_TYPES[number];
export type QBReportPayload = ProfitAndLossReport; // structural alias — QBO returns the same Header/Rows/Columns shape for all 5

export const queryQBReport = async (orgId: string, reportType: QBReportType, params?: string): Promise<QBReportPayload> => {
    const qs = new URLSearchParams(params).toString();
    const path = `/reports/${reportType}` + (qs ? `?${qs}` : "");
    return (await qbFetch(orgId, "GET", path)) as QBReportPayload;
};

export const queryProfitAndLossQBReport = async (
    orgId: string,
    params?: string,
): Promise<ProfitAndLossReport> => {
    const qs = new URLSearchParams(params).toString();
    const path = "/reports/ProfitAndLoss" + (qs ? `?${qs}` : "");
    return (await qbFetch(orgId, "GET", path)) as ProfitAndLossReport;
};
