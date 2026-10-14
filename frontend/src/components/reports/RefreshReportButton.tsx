import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";


const isReportKey = (key: readonly unknown[]) => ["reports", "qbReport", "qbProfitAndLossReport"].includes(key[0] as string);

export default function RefreshReportsButton () {
    const qc = useQueryClient();
    const fetching = useIsFetching({ predicate: (q) => isReportKey(q.queryKey) }) > 0;
    const refresh = () => qc.invalidateQueries({ predicate: (q) => isReportKey(q.queryKey) })
    return (
        <button 
            onClick={refresh}
            disabled={fetching}
            className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-surface text-sm text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
            <RefreshCw size={14} className={fetching ? "animate-spin" : ""} /> Refresh
        </button>
    )
}