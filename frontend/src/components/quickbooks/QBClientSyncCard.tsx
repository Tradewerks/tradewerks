import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Loader2, RefreshCw, Search } from "lucide-react";
import { getClientsPage, type ClientListExtras } from "../../api/clients";
import {
    invalidateQBClientSync,
    useQBClientSyncMutation,
    useQBCustomerQuery,
} from "../../hooks/useQuickbooks";
import { usePagedList } from "../../hooks/usePagedList";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { usePermission } from "../../hooks/usePermission";
import { qk } from "../../lib/queryKeys";
import { useToast } from "../ui/useToast";
import ReportPagination from "../reports/ReportPagination";
import { DEFAULT_LIST_LIMIT } from "../../types/paging";

const NO_PERMISSION_TITLE = "You don't have permission to perform this action";
const COLLECT_PAGE_SIZE = 200;
const SYNC_CONCURRENCY = 5;

type StatusFilter = "all" | "synced" | "not_synced";

// A count is a one-row page: only meta.count is read.
const useClientCount = (qb?: ClientListExtras["qb"]) =>
    useQuery({
        queryKey: [...qk.clients.list(), "count", { qb }],
        queryFn: async () => (await getClientsPage({ page: 1, limit: 1 }, { qb })).total,
        placeholderData: (prev) => prev,
    });

export default function QBClientSyncCard() {
    const { data: qbCustomers } = useQBCustomerQuery();
    // Invalidation is ours, once per action, not once per client.
    const sync = useQBClientSyncMutation({ invalidate: false });
    const queryClient = useQueryClient();
    const toast = useToast();

    const EDIT_CLIENTS = usePermission("edit_clients");

    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [page, setPage] = useState(1);
    const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
    // Ids, so a selection survives paging and a changed filter.
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
    const [collecting, setCollecting] = useState(false);

    const q = useDebouncedValue(search.trim());
    const qb = statusFilter === "all" ? undefined : statusFilter;
    const { data, isLoading, isFetching } = usePagedList(
        [...qk.clients.list(), { qb, withQb: true }],
        (p) => getClientsPage(p, { qb, withQb: true }),
        { page, limit, q: q || undefined }
    );
    const pageClients = data?.rows ?? [];
    const total = data?.total ?? 0;

    // A sync inside a filter can empty the page we are on.
    useEffect(() => {
        if (!data || page === 1 || data.rows.length > 0) return;
        setPage(Math.max(1, Math.ceil(data.total / limit)));
    }, [data, page, limit]);

    const { data: allCount = 0 } = useClientCount();
    const { data: syncedCount = 0 } = useClientCount("synced");
    const { data: notSyncedCount = 0 } = useClientCount("not_synced");

    // QB Id -> QB display name (to show what a client is linked to)
    const qbNameById = new Map((qbCustomers ?? []).map((c) => [c.Id, c.DisplayName]));

    const changeFilter = (next: StatusFilter) => {
        setStatusFilter(next);
        setPage(1);
    };

    const syncOne = async (clientId: string) => {
        setSyncingIds((prev) => new Set(prev).add(clientId));
        try {
            await sync.mutateAsync({ client_id: clientId });
            invalidateQBClientSync(queryClient);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to sync client to QuickBooks");
        } finally {
            setSyncingIds((prev) => {
                const next = new Set(prev);
                next.delete(clientId);
                return next;
            });
        }
    };

    // The ids come from paging the not-synced filter at click time, so nothing
    // whole-org is held while the card is just open.
    const syncAllNotSynced = async () => {
        setCollecting(true);
        try {
            const ids: string[] = [];
            for (let p = 1; ; p++) {
                const res = await getClientsPage(
                    { page: p, limit: COLLECT_PAGE_SIZE },
                    { qb: "not_synced" }
                );
                ids.push(...res.rows.map((c) => c.id));
                if (res.rows.length < COLLECT_PAGE_SIZE || ids.length >= res.total) break;
            }
            await syncMany(ids);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to load clients to sync");
        } finally {
            setCollecting(false);
        }
    };

    const syncMany = async (ids: string[]) => {
        if (ids.length === 0) return;
        setSyncingIds((prev) => new Set([...prev, ...ids]));
        // A few at a time: each one is a QuickBooks API call.
        const results: PromiseSettledResult<unknown>[] = new Array(ids.length);
        let next = 0;
        const worker = async () => {
            while (next < ids.length) {
                const i = next++;
                try {
                    results[i] = {
                        status: "fulfilled",
                        value: await sync.mutateAsync({ client_id: ids[i] }),
                    };
                } catch (reason) {
                    results[i] = { status: "rejected", reason };
                }
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(SYNC_CONCURRENCY, ids.length) }, worker)
        );
        invalidateQBClientSync(queryClient);
        setSyncingIds((prev) => {
            const next = new Set(prev);
            ids.forEach((id) => next.delete(id));
            return next;
        });
        const failed = results.filter((r) => r.status === "rejected").length;
        const succeeded = results.length - failed;
        if (failed === 0) {
            toast.success(`Synced ${succeeded} client${succeeded === 1 ? "" : "s"} to QuickBooks`);
        } else if (succeeded === 0) {
            toast.error(`Failed to sync ${failed} client${failed === 1 ? "" : "s"}`);
        } else {
            toast.warning(`Synced ${succeeded} client${succeeded === 1 ? "" : "s"}, ${failed} failed`);
        }
        setSelected(new Set());
    };

    const toggleSelected = (clientId: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(clientId)) next.delete(clientId);
            else next.add(clientId);
            return next;
        });
    };

    const allVisibleSelected = pageClients.length > 0 && pageClients.every((c) => selected.has(c.id));
    const toggleSelectAllVisible = () => {
        setSelected((prev) => {
            if (allVisibleSelected) {
                const next = new Set(prev);
                pageClients.forEach((c) => next.delete(c.id));
                return next;
            }
            const next = new Set(prev);
            pageClients.forEach((c) => next.add(c.id));
            return next;
        });
    };

    return (
        <div>
            <p className="mb-4 text-xs text-text-muted leading-relaxed max-w-2xl">
                Push clients to QuickBooks as customers. Clients already linked show their matched QuickBooks
                customer — sync again anytime to refresh the link.
            </p>

            {selected.size > 0 && (
                <div className="mb-3 flex items-center justify-between rounded-md border border-primary-border bg-primary-bg px-3.5 py-2">
                    <span className="text-xs font-semibold text-primary-text">{selected.size} selected</span>
                    <div className="flex items-center gap-4">
                        <button
                            type="button"
                            disabled={!EDIT_CLIENTS}
                            title={!EDIT_CLIENTS ? NO_PERMISSION_TITLE : undefined}
                            onClick={() => syncMany(Array.from(selected))}
                            className="flex items-center gap-1.5 rounded-md bg-quickbooks px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:enabled:bg-quickbooks-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <RefreshCw size={12} />
                            Sync selected
                        </button>
                        <button
                            type="button"
                            onClick={() => setSelected(new Set())}
                            className="text-xs font-medium text-text-muted hover:text-text-primary"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}

            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text-muted w-52">
                        <Search size={13} />
                        <input
                            value={search}
                            onChange={(e) => {
                                setSearch(e.target.value);
                                setPage(1);
                            }}
                            placeholder="Search clients…"
                            className="w-full bg-transparent text-text-primary placeholder:text-text-muted"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => changeFilter("all")}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                            statusFilter === "all" ? "bg-text-primary text-text-inverse" : "border border-border bg-surface-raised text-text-secondary"
                        }`}
                    >
                        All {allCount}
                    </button>
                    <button
                        type="button"
                        onClick={() => changeFilter("synced")}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            statusFilter === "synced" ? "bg-text-primary text-text-inverse" : "border border-border bg-surface-raised text-text-secondary"
                        }`}
                    >
                        Synced {syncedCount}
                    </button>
                    <button
                        type="button"
                        onClick={() => changeFilter("not_synced")}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            statusFilter === "not_synced" ? "bg-text-primary text-text-inverse" : "border border-border bg-surface-raised text-text-secondary"
                        }`}
                    >
                        Not synced {notSyncedCount}
                    </button>
                </div>
                <button
                    type="button"
                    disabled={!EDIT_CLIENTS || collecting || notSyncedCount === 0}
                    title={!EDIT_CLIENTS ? NO_PERMISSION_TITLE : undefined}
                    onClick={syncAllNotSynced}
                    className="flex items-center gap-1.5 rounded-md bg-quickbooks px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:enabled:bg-quickbooks-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <RefreshCw size={12} />
                    Sync all not-synced ({notSyncedCount})
                </button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[560px]">
                    <thead>
                        <tr className="border-b border-border-subtle">
                            <th className="w-8 px-5 py-2.5">
                                <button
                                    type="button"
                                    onClick={toggleSelectAllVisible}
                                    aria-label="Select all visible clients"
                                    className="flex items-center text-text-muted hover:text-text-primary"
                                >
                                    {allVisibleSelected ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                                </button>
                            </th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Client</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Status</th>
                            <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">QuickBooks Customer</th>
                            <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pageClients.length ? (
                            pageClients.map((client, idx) => {
                                const externalId = client.client_external_mapping?.[0]?.external_id;
                                const synced = externalId != null;
                                const isSyncing = syncingIds.has(client.id);
                                const isSelected = selected.has(client.id);
                                return (
                                    <tr
                                        key={client.id}
                                        className={`border-b border-border-subtle/50 transition-colors hover:bg-surface/40 ${idx === pageClients.length - 1 ? "border-b-0" : ""} ${isSelected ? "bg-primary-bg" : ""}`}
                                    >
                                        <td className="px-5 py-3">
                                            <button
                                                type="button"
                                                onClick={() => toggleSelected(client.id)}
                                                aria-label={`Select ${client.name}`}
                                                className="flex items-center text-text-muted hover:text-text-primary"
                                            >
                                                {isSelected ? <CheckCircle2 size={15} className="text-primary" /> : <Circle size={15} />}
                                            </button>
                                        </td>
                                        <td className="px-3 py-3">
                                            <div className="text-sm font-medium text-text-primary">{client.name}</div>
                                            {client.address && (
                                                <div className="text-xs text-text-muted truncate max-w-[220px]">{client.address}</div>
                                            )}
                                        </td>
                                        <td className="px-3 py-3">
                                            {synced ? (
                                                <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-1 text-xs font-medium text-success-text border border-success-border">
                                                    <CheckCircle2 size={11} />
                                                    Synced
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 rounded-full bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-muted border border-border">
                                                    Not synced
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-3 py-3 text-xs text-text-secondary">
                                            {synced ? (qbNameById.get(externalId!) ?? `#${externalId}`) : "—"}
                                        </td>
                                        <td className="px-3 py-3 text-right">
                                            <button
                                                type="button"
                                                onClick={() => syncOne(client.id)}
                                                disabled={!EDIT_CLIENTS || isSyncing}
                                                title={!EDIT_CLIENTS ? NO_PERMISSION_TITLE : undefined}
                                                className={
                                                    synced
                                                        ? "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                                        : "inline-flex items-center gap-1.5 rounded-md bg-quickbooks px-2.5 py-1 text-xs font-medium text-white transition-colors hover:enabled:bg-quickbooks-hover disabled:cursor-not-allowed disabled:opacity-50"
                                                }
                                            >
                                                {isSyncing && <Loader2 size={11} className="animate-spin" />}
                                                {synced ? "Re-sync" : "Sync"}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })
                        ) : (
                            <tr>
                                <td colSpan={5} className="px-5 py-8 text-center text-sm text-text-muted">
                                    {isLoading ? "Loading clients…" : "No clients match this filter."}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
            <ReportPagination
                page={page - 1}
                pageSize={limit}
                total={total}
                hasMore={page * limit < total}
                onPageChange={(p) => setPage(p + 1)}
                onPageSizeChange={(size) => {
                    setLimit(size);
                    setPage(1);
                }}
                isFetching={isFetching}
            />

            <p className="mt-3 text-[11px] text-text-faint max-w-2xl">
                Linking a client to an already-existing QuickBooks customer, and unlinking, aren't supported yet —
                syncing today always creates or reuses a customer matched by name.
            </p>
        </div>
    );
}
