import {
    getQBStatus,
    getQBConnectUrl,
    disconnectQB,
    syncInvoiceToQB,
    sendInvoiceEmailViaQB,
    getQBCustomers,
    getQBMappedCustomers,
    getQBItems,
    getQBMappedItems,
    linkQBItem,
    unlinkQBItem,
    importQBItem,
    pushQBItem,
    getQBTaxCodes,
    getQBTaxPrefs,
    getQBTaxCalculation,
    setPassthroughTaxCode,
    unlinkTaxCode,
    linkTaxCode,
    getImportableQBInvoices,
    getQBInvoicePrefill,
    importQBInvoices,
    getQBProfitAndLossReport,
    getQBVendors,
    getQBMappedVendors,
    linkQBVendor,
    unlinkQBVendor,
    importQBVendor,
    pushQBVendor,
    getQBEmployees,
    getQBMappedEmployees,
    linkQBEmployee,
    unlinkQBEmployee,
    pushQBEmployee,
    getQBReport,
    syncClientToQB,
    getQBPurchaseOrders,
    pushPurchaseToQB,
    pushFieldPurchaseToQB,
    pushTimesheetToQB,
    getQBUnsynced,
    syncQBUnsynced,
} from "../api/quickbooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import { useEffect, useState } from "react";
import type { ImportQBItemResult, QBProfitAndLossQuery, QBReportQuery, QBReportTypeId } from "../types/quickbooks";
import type { Supplier } from "../types/suppliers";
import { invalidate, qk } from "../lib/queryKeys";

const useQuery = moduleQuery("quickbooks");

type QBInvoiceEmailVars = {
  invoiceId: string;
  sendTo: string;
};

export const useQBStatusQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbStatus"],
        queryFn: getQBStatus,
        enabled,
        refetchInterval: 2 * 60 * 1000,
        staleTime: 30_000,
    });
};

export const useQBMappedCustomersQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbMappedCustomers"],
        queryFn: getQBMappedCustomers,
        enabled,
    });
};

/**
 * "Synced clients only" toggle for a QB report: when on, resolves to a
 * comma-joined `customer` filter of every client already linked to a QB
 * customer (via client_external_mapping), scoped to the connected realm.
 * `customer` stays undefined while off or with nothing synced yet, so the
 * report query cleanly falls back to unfiltered.
 */
export const useSyncedClientFilter = () => {
    const [enabled, setEnabled] = useState(false);
    const { data: mappedCustomers = [] } = useQBMappedCustomersQuery();
    const customer =
        enabled && mappedCustomers.length > 0
            ? mappedCustomers.map((m) => m.external_id).join(",")
            : undefined;
    return { enabled, setEnabled, mappedCount: mappedCustomers.length, customer };
};

export const useQBCustomerQuery = (enabled = true) => {
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: ["qbCustomers"],
        queryFn: getQBCustomers,
        enabled,
        retry: false,
    });

    useEffect(() => {
        if (query.isError) {
            queryClient.invalidateQueries({ queryKey: ["qbStatus"] });
        }
    }, [query.isError, queryClient]);

    return query;
}

export const useQBItemsQuery = (enabled = true) => {
    const queryClient = useQueryClient();
    const query = useQuery({
        queryKey: ["qbItems"],
        queryFn: getQBItems,
        enabled,
        retry: false,
    });
    
    useEffect(() => {
        if (query.isError) {
            queryClient.invalidateQueries({ queryKey: ["qbStatus"] });
        }
    }, [query.isError, queryClient]);

    return query;
};

export const useQBMappedItemsQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbMappedItems"],
        queryFn: getQBMappedItems,
        enabled,
        retry: false,
    });
};

// ── Vendors ──────────────────────────────────────────────────────────────────
// Every mutation here also invalidates the supplier list: an import creates or
// enriches a supplier, and a link changes what the Suppliers page can show as
// connected.

export const useQBVendorsQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbVendors"],
        queryFn: getQBVendors,
        enabled,
        retry: false,
    });
};

export const useQBMappedVendorsQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbMappedVendors"],
        queryFn: getQBMappedVendors,
        enabled,
        retry: false,
    });
};

export const useQBEmployeesQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbEmployees"],
        queryFn: getQBEmployees,
        enabled,
        retry: false,
    });
};

export const useQBMappedEmployeesQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbMappedEmployees"],
        queryFn: getQBMappedEmployees,
        enabled,
        retry: false,
    });
};

const invalidateVendors = (queryClient: ReturnType<typeof useQueryClient>) => {
    queryClient.invalidateQueries({ queryKey: ["qbVendors"] });
    queryClient.invalidateQueries({ queryKey: ["qbMappedVendors"] });
    queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
};

export const useLinkQBVendorMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { supplier_id: string; qb_vendor_id: string }>({
        mutationFn: ({ supplier_id, qb_vendor_id }) => linkQBVendor(supplier_id, qb_vendor_id),
        onSuccess: () => invalidateVendors(queryClient),
    });
};

export const useUnlinkQBVendorMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, string>({
        mutationFn: (supplierId) => unlinkQBVendor(supplierId),
        onSuccess: () => invalidateVendors(queryClient),
    });
};

export const useImportQBVendorMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ supplier: Supplier; linkedExisting: boolean }, Error, string>({
        mutationFn: (qbVendorId) => importQBVendor(qbVendorId),
        onSuccess: () => invalidateVendors(queryClient),
    });
};

export const usePushQBVendorMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ pushed: boolean; qb_vendor_id: string }, Error, string>({
        mutationFn: (supplierId) => pushQBVendor(supplierId),
        onSuccess: () => invalidateVendors(queryClient),
    });
};

const invalidateEmployees = (queryClient: ReturnType<typeof useQueryClient>) => {
    queryClient.invalidateQueries({ queryKey: ["qbEmployees"] });
    queryClient.invalidateQueries({ queryKey: ["qbMappedEmployees"] });
};

export const useLinkQBEmployeeMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { technician_id: string; qb_employee_id: string }>({
        mutationFn: ({ technician_id, qb_employee_id }) => linkQBEmployee(technician_id, qb_employee_id),
        onSuccess: () => invalidateEmployees(queryClient),
    });
};

export const useUnlinkQBEmployeeMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, string>({
        mutationFn: (technicianId) => unlinkQBEmployee(technicianId),
        onSuccess: () => invalidateEmployees(queryClient),
    });
};

export const usePushQBEmployeeMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ pushed: boolean; qb_employee_id: string }, Error, string>({
        mutationFn: (technicianId) => pushQBEmployee(technicianId),
        onSuccess: () => invalidateEmployees(queryClient),
    });
};

export const usePushPurchaseToQBMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ pushed: boolean; qb_purchase_order_id: string }, Error, string>({
        mutationFn: (purchaseId) => pushPurchaseToQB(purchaseId),
        onSuccess: (_result, purchaseId) => {
            queryClient.invalidateQueries({ queryKey: qk.purchases.detail(purchaseId) });
            queryClient.invalidateQueries({ queryKey: ["qbPurchaseOrders"] });
        },
    });
};

export const usePushFieldPurchaseToQBMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ pushed: boolean; qb_purchase_order_id: string }, Error, string>({
        mutationFn: (purchaseId) => pushFieldPurchaseToQB(purchaseId),
        onSuccess: (_result, purchaseId) => {
            queryClient.invalidateQueries({ queryKey: qk.fieldPurchases.detail(purchaseId) });
            queryClient.invalidateQueries({ queryKey: ["qbPurchaseOrders"] });
        },
    });
};

export const usePushTimesheetToQBMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ pushed: boolean }, Error, string>({
        mutationFn: (timesheetId) => pushTimesheetToQB(timesheetId),
        onSettled: () => queryClient.invalidateQueries({ queryKey: qk.timesheets.all }),
    });
};

export const useQBPurchaseOrderQuery = (enabled = true) =>{
    return useQuery({
        queryKey: ["qbPurchaseOrders"],
        queryFn: getQBPurchaseOrders,
        enabled,
        retry: false
    })
}

export const useQBTaxCodesQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbTaxCodes"],
        queryFn: getQBTaxCodes,
        enabled,
        retry: false,
    });
};

export const useQBTaxPrefsQuery = (enabled = true) => {
    return useQuery({
        queryKey: ["qbTaxPrefs"],
        queryFn: getQBTaxPrefs,
        enabled,
        retry: false,
    });
};

export const useQBTaxCalculationQuery = (enabled: boolean) => {
    return useQuery({
        queryKey: ["qbTaxCalculation"],
        queryFn: getQBTaxCalculation,
        enabled,
        staleTime: 5 * 60_000,
        retry: false,
    });
};

export const useImportableQBInvoicesQuery = (enabled = true, customerId?: string) => {
    return useQuery({
        queryKey: ["importableQBInvoices", customerId],
        queryFn: () => getImportableQBInvoices(customerId),
        enabled,
        retry: false,
    });
};

export const useQBInvoicePrefillQuery = (qbInvoiceId?: string | null) => {
    return useQuery({
        queryKey: ["qbInvoicePrefill", qbInvoiceId],
        queryFn: () => getQBInvoicePrefill(qbInvoiceId!),
        enabled: !!qbInvoiceId,
        retry: false,
    });
};

export const useQBProfitAndLossReportQuery = (query: QBProfitAndLossQuery, enabled = true) => {
    return useQuery({
        queryKey: ["qbProfitAndLossReport", query],
        queryFn: () => getQBProfitAndLossReport(query),
        enabled,
        retry: false,
    });
};

export const useQBReportQuery = (reportType: QBReportTypeId, query: QBReportQuery, enabled = true) => {
    return useQuery({
        queryKey: ["qbReport", reportType, query],
        queryFn: () => getQBReport(reportType, query),
        enabled,
        retry: false,
    });
};

export const useQBConnectMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            // A features string with a size is what makes browsers open a real
            // popup window instead of a new tab. Center it over the app window.
            const w = 600;
            const h = 720;
            const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
            const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
            const popup = window.open(
                "",
                "qb-connect",
                `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
            );

            const channel = new BroadcastChannel("qb-oauth");
            const cleanup = () => {
                channel.close();
                window.clearInterval(poll);
            };
            channel.onmessage = (e) => {
                if (e.data?.type === "qb-oauth") {
                    queryClient.invalidateQueries({ queryKey: ["qbStatus"] });
                    popup?.close();
                    cleanup();
                }
            };
            // Stop listening if the user closes the popup manually.
            const poll = window.setInterval(() => {
                if (popup?.closed) cleanup();
            }, 1000);

            const url = await getQBConnectUrl();
            if (popup) {
                popup.location.href = url;
            } else {
                // Popup was blocked — fall back to navigating the current tab.
                cleanup();
                sessionStorage.setItem("qb-oauth-same-tab", "1");
                window.location.href = url;
            }
        },
    });
};

export const useQBDisconnectMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: disconnectQB,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbStatus"] });
        },
    });
};

export const useQBInvoiceSyncMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (invoiceId: string) => syncInvoiceToQB(invoiceId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
        },
        onError: () => {
            queryClient.invalidateQueries({ queryKey: ["qbStatus"] });
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
        },
    });
};

export const useQBInvoiceEmailMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, QBInvoiceEmailVars>({
        mutationFn: ({ invoiceId, sendTo }) => sendInvoiceEmailViaQB(invoiceId, sendTo),
        onError: () => {
            queryClient.invalidateQueries({ queryKey: ["qbStatus"] });
        },
    });
};

export const useLinkQBItemMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { inventory_item_id: string; qb_item_id: string }>({
        mutationFn: ({ inventory_item_id, qb_item_id }) => linkQBItem(inventory_item_id, qb_item_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbMappedItems"] });
            invalidate.warehouse(queryClient);
        },
    });
};

export const useImportQBItemMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<ImportQBItemResult, Error, { qb_item_id: string }>({
        mutationFn: ({ qb_item_id }) => importQBItem(qb_item_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbMappedItems"] });
            invalidate.warehouse(queryClient);
        },
    });
};

export const usePushQBItemMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { itemId: string }>({
        mutationFn: ({itemId}) => pushQBItem(itemId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbMappedItems"] });
            invalidate.warehouse(queryClient);
        },
    });
};

export const useUnlinkQBItemMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { inventory_item_id: string }>({
        mutationFn: ({ inventory_item_id }) => unlinkQBItem(inventory_item_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbMappedItems"] });
            invalidate.warehouse(queryClient);
        },
    });
};

export const useLinkTaxCodeMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { tax_group_id: string; qb_tax_code_id: string }>({
        mutationFn: ({ tax_group_id, qb_tax_code_id }) => linkTaxCode(tax_group_id, qb_tax_code_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
        },
    });
};

export const useUnlinkTaxCodeMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { tax_group_id: string }>({
        mutationFn: ({ tax_group_id }) => unlinkTaxCode(tax_group_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
        },
    });
};

export const useSetPassthroughTaxCodeMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { qb_tax_code_id: string | null }>({
        mutationFn: ({ qb_tax_code_id }) => setPassthroughTaxCode(qb_tax_code_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbTaxPrefs"] });
        },
    });
};

export const useImportQBInvoicesMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<unknown, Error, { qb_invoice_ids: string[] }>({
        mutationFn: ({ qb_invoice_ids }) => importQBInvoices(qb_invoice_ids),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["importableQBInvoices"] });
        },
    });
};

export const useQBClientSyncMutation = () => {
    const queryClient = useQueryClient();
    return useMutation<{ synced: boolean; qb_customer_id: string }, Error, { client_id: string }>({
        mutationFn: ({ client_id }) => syncClientToQB(client_id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["qbCustomers"]});
            queryClient.invalidateQueries({ queryKey: ["qbMappedCustomers"]});
        }
    })
};

export const useQBUnsyncedQuery = (enabled: boolean) =>
	useQuery({ queryKey: ["qbUnsynced"], queryFn: getQBUnsynced, enabled, staleTime: 30_000 });

export const useQBSyncNowMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: syncQBUnsynced,
		onSettled: () => queryClient.invalidateQueries({ queryKey: ["qbUnsynced"] }),
	});
};
