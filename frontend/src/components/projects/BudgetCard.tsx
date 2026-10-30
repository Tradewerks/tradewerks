import Card from "../ui/Card";
import { formatCurrency } from "../../util/util";

const compactUSD = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
    // Truncate so 999,999.99 reads $999.99K, not a rounded-up $1M. Cast: ES2022 lib lacks roundingMode.
    roundingMode: "trunc",
} as Intl.NumberFormatOptions);
// Tiles are ~150px wide; full cents at 100k+ wrap or clip. Legend keeps exact figures.
const tile = (n: number) => (Math.abs(n) >= 1e5 ? compactUSD.format(n) : formatCurrency(n));

interface BudgetCardProps {
    budget: number | null;
    estimated: number;
    actual: number;
    className?: string
}

export default function BudgetCard({ budget, estimated, actual, className }: BudgetCardProps) {
    // null budget = nothing was ever set; it is not the same as a $0 budget.
    const b = budget === null || budget === undefined ? null : Number(budget);
    const e = Number(estimated), a = Number(actual);
    const variance = b === null ? null : b - a;
    const pctActual = b !== null && b > 0 ? Math.min((a / b) * 100, 100) : 0;
    const pctEst = b !== null && b > 0 ? Math.min((e / b) * 100, 100) : 0;
    const over = b !== null && a > b;
    const pos = variance !== null && variance >= 0;

    return (
        <Card title="Budget" className={className}>
            <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-px bg-border-subtle border border-border-subtle rounded-lg overflow-hidden">
                    {[
                        {
                            label: "Budget",
                            value: b === null ? "No budget set" : tile(b),
                            full: b === null ? undefined : formatCurrency(b),
                            sub: b === null ? "add one in Edit Project" : "set manually",
                            muted: b === null,
                        },
                        { label: "Estimated", value: tile(e), full: formatCurrency(e), sub: "Σ job estimates", muted: false },
                        { label: "Actual", value: tile(a), full: formatCurrency(a), sub: "Σ completed work", muted: false },
                    ].map((m) => (
                        <div key={m.label} className="bg-surface-raised p-3">
                            <div className="text-[11px] uppercase tracking-wide font-semibold text-text-muted">{m.label}</div>
                            <div title={m.full} className={`font-bold tabular-nums tracking-tight mt-1 ${m.muted ? "text-base text-text-muted" : "text-xl"}`}>{m.value}</div>
                            <div className="text-xs text-text-muted mt-0.5">{m.sub}</div>
                        </div>
                    ))}
                    <div className="bg-surface-raised p-3">
                        <div className="text-[11px] uppercase tracking-wide font-semibold text-text-muted">Variance</div>
                        {variance === null ? (
                            <div className="text-base font-bold tabular-nums tracking-tight mt-1 text-text-muted">—</div>
                        ) : (
                            <div
                                title={formatCurrency(variance)}
                                className={`text-xl font-bold tabular-nums tracking-tight mt-1 whitespace-nowrap ${pos ? "text-success-text" : "text-error-text"}`}
                            >
                                {`${pos ? "+" : "-"}${tile(Math.abs(variance))}`}
                            </div>
                        )}
                        <div className="text-xs text-text-muted mt-0.5">
                            {variance === null ? "no budget to compare" : "budget - actual"}
                        </div>
                    </div>
                </div>

                {b === null ? (
                    <p className="text-xs text-text-muted">
                        Set a budget to track spend against it.
                    </p>
                ) : (
                    <div className="flex flex-col gap-2">
                        <div className="flex justify-between items-baseline text-xs text-text-tertiary">
                            <span>Spend against budget</span>
                            <span className="font-semibold text-text-primary tabular-nums">{Math.round(pctActual)}%</span>
                        </div>
                        <div className="relative h-3 rounded-full bg-border-strong overflow-hidden">
                            <div className="absolute inset-y-0 left-0 bg-warning" style={{ width: `${pctEst}%` }} />
                            <div className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-error" : "bg-primary"}`} style={{ width: `${pctActual}%` }} />
                        </div>
                        <div className="flex gap-4 flex-wrap text-[11px] text-text-muted">
                            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-primary" />Actual {formatCurrency(a)}</span>
                            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning" />Estimated {formatCurrency(e)}</span>
                            <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-border-strong" />Budget {formatCurrency(b)}</span>
                        </div>
                    </div>
                )}
            </div>
        </Card>
    );
}
