import { useMemo, useState } from "react";
import { CheckCircle2, Circle, Loader2, RefreshCw, Search } from "lucide-react";
import { useAllClientsQuery } from "../../hooks/useClients";
import {
    useQBClientSyncMutation,
    useQBCustomerQuery,
    useQBMappedCustomersQuery,
} from "../../hooks/useQuickbooks";
import { usePermission } from "../../hooks/usePermission";
import { useToast } from "../ui/useToast";

const NO_PERMISSION_TITLE = "You don't have permission to perform this action";

type StatusFilter = "all" | "synced" | "not_synced";

export default function QBClientSyncCard() {
    const { data: clients } = useAllClientsQuery();
    const { data: mappedCustomers } = useQBMappedCustomersQuery();
    const { data: qbCustomers } = useQBCustomerQuery();
    const sync = useQBClientSyncMutation();
    const toast = useToast();

    const EDIT_CLIENTS = usePermission("edit_clients");

    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());

    // client_id -> QB external_id
    const externalIdByClientId = useMemo(
        () => new Map((mappedCustomers ?? []).map((m) => [m.client_id, m.external_id])),
        [mappedCustomers],
    );
    // QB Id -> QB display name (to show what a client is linked to)
    const qbNameById = useMemo(
        () => new Map((qbCustomers ?? []).map((c) => [c.Id, c.DisplayName])),
        [qbCustomers],
    );

    const allClients = useMemo(() => clients ?? [], [clients]);
    const syncedCount = allClients.filter((c) => externalIdByClientId.has(c.id)).length;
    const notSyncedIds = allClients.filter((c) => !externalIdByClientId.has(c.id)).map((c) => c.id);

    const filteredClients = useMemo(() => {
        const term = search.trim().toLowerCase();
        return allClients.filter((c) => {
            const synced = externalIdByClientId.has(c.id);
            if (statusFilter === "synced" && !synced) return false;
            if (statusFilter === "not_synced" && synced) return false;
            if (!term) return true;
            return c.name.toLowerCase().includes(term) || (c.address?.toLowerCase().includes(term) ?? false);
        });
    }, [allClients, externalIdByClientId, search, statusFilter]);

    const syncOne = async (clientId: string) => {
        setSyncingIds((prev) => new Set(prev).add(clientId));
        try {
            await sync.mutateAsync({ client_id: clientId });
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

    const syncMany = async (ids: string[]) => {
        if (ids.length === 0) return;
        setSyncingIds((prev) => new Set([...prev, ...ids]));
        const results = await Promise.allSettled(ids.map((id) => sync.mutateAsync({ client_id: id })));
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

    const allVisibleSelected = filteredClients.length > 0 && filteredClients.every((c) => selected.has(c.id));
    const toggleSelectAllVisible = () => {
        setSelected((prev) => {
            if (allVisibleSelected) {
                const next = new Set(prev);
                filteredClients.forEach((c) => next.delete(c.id));
                return next;
            }
            const next = new Set(prev);
            filteredClients.forEach((c) => next.add(c.id));
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
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search clients…"
                            className="w-full bg-transparent text-text-primary placeholder:text-text-muted"
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => setStatusFilter("all")}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                            statusFilter === "all" ? "bg-text-primary text-text-inverse" : "border border-border bg-surface-raised text-text-secondary"
                        }`}
                    >
                        All {allClients.length}
                    </button>
                    <button
                        type="button"
                        onClick={() => setStatusFilter("synced")}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            statusFilter === "synced" ? "bg-text-primary text-text-inverse" : "border border-border bg-surface-raised text-text-secondary"
                        }`}
                    >
                        Synced {syncedCount}
                    </button>
                    <button
                        type="button"
                        onClick={() => setStatusFilter("not_synced")}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            statusFilter === "not_synced" ? "bg-text-primary text-text-inverse" : "border border-border bg-surface-raised text-text-secondary"
                        }`}
                    >
                        Not synced {notSyncedIds.length}
                    </button>
                </div>
                <button
                    type="button"
                    disabled={!EDIT_CLIENTS || notSyncedIds.length === 0}
                    title={!EDIT_CLIENTS ? NO_PERMISSION_TITLE : undefined}
                    onClick={() => syncMany(notSyncedIds)}
                    className="flex items-center gap-1.5 rounded-md bg-quickbooks px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:enabled:bg-quickbooks-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <RefreshCw size={12} />
                    Sync all not-synced ({notSyncedIds.length})
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
                        {filteredClients.length ? (
                            filteredClients.map((client, idx) => {
                                const externalId = externalIdByClientId.get(client.id);
                                const synced = externalId != null;
                                const isSyncing = syncingIds.has(client.id);
                                const isSelected = selected.has(client.id);
                                return (
                                    <tr
                                        key={client.id}
                                        className={`border-b border-border-subtle/50 transition-colors hover:bg-surface/40 ${idx === filteredClients.length - 1 ? "border-b-0" : ""} ${isSelected ? "bg-primary-bg" : ""}`}
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
                                    No clients match this filter.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <p className="mt-3 text-[11px] text-text-faint max-w-2xl">
                Linking a client to an already-existing QuickBooks customer, and unlinking, aren't supported yet —
                syncing today always creates or reuses a customer matched by name.
            </p>
        </div>
    );
}
