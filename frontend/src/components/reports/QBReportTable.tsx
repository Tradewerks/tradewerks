import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatCurrency } from "../../util/util";
import type { QBReportPayload } from "../../types/quickbooks";

interface QBReportTableProps {
    report: QBReportPayload;
}

type LineKind = "section" | "data" | "summary";

interface StatementLine {
    id: string;
    label: string;
    amount: string | null;
    depth: number;
    kind: LineKind;
    group?: string;
    ancestors: string[];
    collapsible?: boolean;
}

type QBRow = QBReportPayload["Rows"]["Row"][number];

function amountOf(colData: { value: string }[] | undefined): string | null {
    if (!colData?.length) return null;
    const raw = colData[colData.length - 1]?.value ?? "";
    if (raw.trim() === "") return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return raw;
    return num < 0 ? `(${formatCurrency(Math.abs(num))})` : formatCurrency(num);
}

function flatten(
    rows: QBRow[] | undefined,
    depth: number,
    out: StatementLine[],
    path: string,
    ancestors: string[],
) {
    if (!rows) return;
    rows.forEach((row, i) => {
        const rowPath = `${path}.${i}`;
        const headerId = `${rowPath}-h`;
        const hasHeader = !!row.Header?.ColData?.length;
        const hasChildren = !!row.Rows?.Row;
        if (hasHeader) {
            out.push({
                id: headerId,
                label: row.Header!.ColData[0]?.value ?? "",
                amount: amountOf(row.Header!.ColData),
                depth,
                kind: "section",
                group: row.group,
                ancestors,
                collapsible: hasChildren,
            });
        }
        if (row.ColData?.length) {
            out.push({
                id: `${rowPath}-d`,
                label: row.ColData[0]?.value ?? "",
                amount: amountOf(row.ColData),
                depth,
                kind: "data",
                ancestors,
            });
        }
        if (hasChildren) {
            flatten(
                row.Rows!.Row,
                depth + 1,
                out,
                rowPath,
                hasHeader ? [...ancestors, headerId] : ancestors,
            );
        }
        if (row.Summary?.ColData?.length) {
            out.push({
                id: `${rowPath}-s`,
                label: row.Summary.ColData[0]?.value ?? "",
                amount: amountOf(row.Summary.ColData),
                depth,
                kind: "summary",
                group: row.group,
                ancestors,
            });
        }
    });
}

function amountColumnTitle(report: QBReportPayload): string {
    const cols = report.Columns?.Column ?? [];
    const money = cols.find((c) => c.ColType === "money");
    return money?.ColTitle || cols[cols.length - 1]?.ColTitle || "Total";
}

export default function QBReportTable({ report }: QBReportTableProps) {
    const lines = useMemo(() => {
        const out: StatementLine[] = [];
        flatten(report.Rows?.Row, 0, out, "r", []);
        return out;
    }, [report]);

    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const toggle = (id: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const visible = lines.filter((l) => !l.ancestors.some((a) => collapsed.has(a)));

    const { StartPeriod, EndPeriod, ReportBasis, Currency } = report.Header;
    const totalTitle = amountColumnTitle(report);

    return (
        <div>
            <div className="mb-3 text-sm text-text-muted">
                {StartPeriod && EndPeriod && (
                    <span>
                        {StartPeriod} – {EndPeriod}
                    </span>
                )}
                {ReportBasis && <span> · {ReportBasis} basis</span>}
                {Currency && <span> · {Currency}</span>}
            </div>
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border">
                        <th className="py-1.5 pr-4" />
                        <th className="py-1.5 text-right text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                            {totalTitle}
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {visible.map((line) => {
                        const isNetIncome = line.group === "NetIncome";
                        const isKeyTotal =
                            line.group === "GrossProfit" || line.group === "NetOperatingIncome";
                        const strong = line.kind === "section" || line.kind === "summary";
                        const isExpanded = !collapsed.has(line.id);

                        const rowBorder = isNetIncome
                            ? "border-t-2 border-border"
                            : line.kind === "summary" || isKeyTotal
                                ? "border-t border-border-subtle"
                                : "";
                        const topSpace = line.kind === "section" && line.depth === 0 ? "pt-4" : "";
                        const emphasis = isNetIncome
                            ? "font-bold text-text-primary"
                            : strong || isKeyTotal
                                ? "font-semibold text-text-primary"
                                : "text-text-secondary";

                        return (
                            <tr key={line.id} className={`${rowBorder} ${isNetIncome ? "bg-surface" : ""}`}>
                                <td
                                    className={`${topSpace} py-1.5 pr-4 ${emphasis}`}
                                    style={{ paddingLeft: `${line.depth * 1.25}rem` }}
                                >
                                    {line.collapsible ? (
                                        <button
                                            type="button"
                                            onClick={() => toggle(line.id)}
                                            aria-expanded={isExpanded}
                                            className="flex items-center gap-1 text-left hover:text-primary-text transition-colors"
                                        >
                                            {isExpanded ? (
                                                <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
                                            ) : (
                                                <ChevronRight size={14} className="shrink-0 text-text-tertiary" />
                                            )}
                                            <span>{line.label}</span>
                                        </button>
                                    ) : (
                                        line.label
                                    )}
                                </td>
                                <td className={`${topSpace} py-1.5 text-right tabular-nums ${emphasis}`}>
                                    {line.amount ?? ""}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
