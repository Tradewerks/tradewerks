import { useMemo, useState, useCallback } from "react";
import { startOfMonth, endOfMonth } from "date-fns";
import { usePageSummaryQuery } from "../../../hooks/useReports";
import PageSummary from "../../reports/PageSummary";
import Card from "../../ui/Card";

function usePersistentPage(key: string, fallback: string,): [string, (v: string) => void] {
    const [page, setPage] = useState<string>(
        () => localStorage.getItem(key) ?? fallback,
    );
    const set = useCallback(
        (v: string) => {
            setPage(v);
            localStorage.setItem(key, v);
        }, 
        [key],
    );
    return [page, set];
}

function PagePicker ({ pages, value, onChange }: { pages: string[]; value: string; onChange: (v: string) => void }) {

    return (
        <div>
            <select 
                value={value} 
                onChange={(e) => onChange(e.target.value)}
                aria-label="Group breakdown by"
				className="flex h-9 cursor-pointer items-center whitespace-nowrap rounded-md border border-border bg-surface px-3 text-sm text-text-tertiary transition-colors hover:text-text-primary"
            >
                {pages.map((p, i) => 
                    <option key={i}>
                        {p}
                    </option>
                )}
            </select>
        </div>
    )
}

function Skeleton () {
    return <div className="animate-pulse h-full min-h-40 rounded-md bg-surface-raised" />;
}

function ErrorBox () {
    return (
        <div className="flex h-full min-h-40 items-center justify-center text-sm text-text-faint">
            Failed to load report.
        </div>
    );
}

export default function PageReportWidget () {
    const [page, setPage] = usePersistentPage("dashboard:page-report:page", "Jobs");
    const now = useMemo(()=> new Date(), []);
    const start = useMemo(() => startOfMonth(now).toISOString(), [now]);
	const end   = useMemo(() => endOfMonth(now).toISOString(),   [now]);
    const PAGES = ["Requests", "Quotes", "Jobs", "Projects", "Invoices", "Clients", "Inventory"];
    const selected = PAGES.find((p) => p.toLowerCase() === page.toLowerCase()) ?? "Jobs";
    const { data, isLoading, error } = usePageSummaryQuery(selected.toLowerCase(), start, end);

    return (
        <Card className="h-full" scrollable
            title={`${selected} Report`}
            headerAction={<PagePicker pages={PAGES} value={selected} onChange={setPage} />}>

            {error ? <ErrorBox /> : (isLoading || !data) ? <Skeleton/> : <PageSummary data={data} fill/>}
        </Card>
    );
}