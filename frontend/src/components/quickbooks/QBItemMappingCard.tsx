import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import {
    useQBMappedItemsQuery,
    useQBItemsQuery,
    usePushQBItemMutation,
    useUnlinkQBItemMutation,
} from "../../hooks/useQuickbooks";
import { useAllInventoryQuery } from "../../hooks/useInventory";
import { usePermission } from "../../hooks/usePermission";
import type { InventoryItem } from "../../types/inventory";
import LinkQBItemModal from "./LinkQBItemModal";

const NO_PERMISSION_TITLE = "You don't have permission to perform this action";

export default function QBItemMappingCard() {
    const { data: mappedItems } = useQBMappedItemsQuery();
    const { data: qbItems } = useQBItemsQuery();
    const { data: inventoryItems } = useAllInventoryQuery();
    const push = usePushQBItemMutation();
    const unlink = useUnlinkQBItemMutation();

    // permissions
    const MANAGE_INVENTORY = usePermission("manage_inventory");
    const [linkItem, setLinkItem] = useState<InventoryItem | null>(null);

    // inventory_item_id -> linked QB external_id
    const mappedByItemId = useMemo(
        () => new Map((mappedItems ?? []).map((m) => [m.inventory_item_id, m.external_id])),
        [mappedItems],
    );
    // QB Id -> QB item name (to show what an item is linked to)
    const qbNameById = useMemo(
        () => new Map((qbItems ?? []).map((q) => [q.Id, q.Name])),
        [qbItems],
    );

    return (
        <div>
            <p className="mb-4 text-xs text-text-muted leading-relaxed w-fit">
                Link inventory items to QuickBooks items so synced invoice lines post to the right product instead of the generic “Services”.
            </p>

            {inventoryItems?.length ? (
                <div className="grid gap-3 [grid-template-columns:repeat(2,minmax(0,1fr))]">
                    {inventoryItems.map((item) => {
                        const externalId = mappedByItemId.get(item.id);
                        const linked = externalId != null;
                        return (
                            <div key={item.id} className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3.5">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-text-primary" title={item.name}>
                                        {item.name}
                                    </div>
                                    {item.sku && <div className="truncate text-xs text-text-muted" title={item.sku}>{item.sku}</div>}
                                </div>
                                {linked ? (
                                    <div className="flex items-center justify-between gap-2 border-t border-surface-raised pt-2">
                                        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-success-text">
                                            <CheckCircle2 size={11} className="flex-shrink-0" />
                                            <span className="truncate">{qbNameById.get(externalId!) ?? `#${externalId}`}</span>
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => unlink.mutate({ inventory_item_id: item.id })}
                                            disabled={!MANAGE_INVENTORY || unlink.isPending}
                                            title={!MANAGE_INVENTORY ? NO_PERMISSION_TITLE : undefined}
                                            className="flex-shrink-0 rounded-md border border-border bg-surface-raised px-2 py-1 text-[11px] font-medium text-text-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Unlink
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 border-t border-surface-raised pt-2">
                                        <button
                                            type="button"
                                            onClick={() => setLinkItem(item)}
                                            disabled={!MANAGE_INVENTORY}
                                            title={!MANAGE_INVENTORY ? NO_PERMISSION_TITLE : undefined}
                                            className="rounded-md border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Link
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => push.mutate({ itemId: item.id })}
                                            disabled={!MANAGE_INVENTORY || push.isPending}
                                            title={!MANAGE_INVENTORY ? NO_PERMISSION_TITLE : undefined}
                                            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Push to QB
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="rounded-lg border border-border-subtle px-5 py-8 text-center text-sm text-text-muted">
                    No inventory items yet.
                </div>
            )}

            {linkItem && (
                <LinkQBItemModal item={linkItem} isOpen={!!linkItem} onClose={() => setLinkItem(null)} />
            )}
        </div>
    );
}
