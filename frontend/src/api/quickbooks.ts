import {api} from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { QBCustomerLite } from "../types/clients"
import type { 
    QBItemLite, 
    MappedQBItem, 
    ImportQBItemResult, 
    QBTaxCodeLite, 
    QBImportableInvoice, 
    QBInvoiceImportResult, 
    QBInvoicePrefill,
    QBProfitAndLossQuery,
    QBProfitAndLossReport,
    QBVendorLite,
    MappedQBVendor,
    MappedQBCustomer,
    QBReportTypeId,
    QBReportQuery,
    QBReportPayload,
    QBPurchaseOrder,
    QBEmployeeLite,
    MappedQBEmployee,
} from "../types/quickbooks";
import type { Supplier } from "../types/suppliers";
 
export const getQBStatus = async (): Promise<{ connected: boolean; realmId?: string }> => {
    const response = await api.get<ApiResponse<{ connected: boolean; realmId?: string }>>(`/integrations/quickbooks/connection`);
    return response.data.data || { connected: false };
};

export const getQBConnectUrl = async (): Promise<string> => {
    const response = await api.get<ApiResponse<{ url: string }>>(`/integrations/quickbooks/connection/auth-url`);
    if (!response.data.success || !response.data.data) {
        throw new Error(response.data.error?.message || "Failed to get QuickBooks connect URL");
    }
    return response.data.data.url;
};

export const disconnectQB = async (): Promise<void> => {
    const response = await api.delete<ApiResponse<null>>(`/integrations/quickbooks/connection`);
    if (!response.data.success) {
        throw new Error(response.data.error?.message || "Failed to disconnect QuickBooks");
    }
};

export const syncInvoiceToQB = async (invoiceId: string): Promise<void> => {
    const response = await api.post<ApiResponse<null>>(`/integrations/quickbooks/invoices/${invoiceId}/sync`);
    if (!response.data.success) {
        throw new Error(response.data.error?.message || "Failed to sync invoice to QuickBooks");
    }
};

export const sendInvoiceEmailViaQB = async (invoiceId: string, sendTo: string)=>{
    const response = await api.post<ApiResponse<{ sent: boolean }>>(`integrations/quickbooks/invoices/${invoiceId}/email`, {sendTo});
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to send email");
    return response.data.data!;
}

export const getQBCustomers = async (): Promise<QBCustomerLite[]> => {
    const response = await api.get<ApiResponse<QBCustomerLite[]>>("integrations/quickbooks/customers");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB customers");
    return response.data.data!;
}

export const syncClientToQB = async (clientId: string): Promise<{ synced: boolean; qb_customer_id: string }> => {
    const response = await api.post<ApiResponse<{ synced: boolean; qb_customer_id: string }>>(`integrations/quickbooks/customers/${clientId}/sync`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to sync client to QB");
    return response.data.data!;
}

export const getQBMappedCustomers = async (): Promise<MappedQBCustomer[]> => {
    const response = await api.get<ApiResponse<MappedQBCustomer[]>>("integrations/quickbooks/customers/mappings");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get mapped QB customers");
    return response.data.data!;
}

export const getQBItems = async (): Promise<QBItemLite[]> => {
    const response = await api.get<ApiResponse<QBItemLite[]>>("integrations/quickbooks/items");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB items");
    return response.data.data!;
}

export const getQBMappedItems = async (): Promise<MappedQBItem[]> => {
    const response = await api.get<ApiResponse<MappedQBItem[]>>("integrations/quickbooks/items/mappings");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get mapped QB items");
    return response.data.data!;
}

export const linkQBItem = async (inventory_item_id: string, qb_item_id:string) => {
    const response = await api.post<ApiResponse<{linked: boolean}>>(`integrations/quickbooks/item-mappings`, {inventory_item_id, qb_item_id});
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to link QB item");
    return response.data.data!;
}

export const unlinkQBItem = async (inventory_item_id: string) => {
    const response = await api.delete<ApiResponse<{linked: boolean}>>(`integrations/quickbooks/item-mappings/${inventory_item_id}`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to unlink QB item");
    return response.data.data!;
}

export const importQBItem = async (qb_item_id: string): Promise<ImportQBItemResult> => {
    const response = await api.post<ApiResponse<ImportQBItemResult>>(`integrations/quickbooks/items/${qb_item_id}/import`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to import QB item");
    return response.data.data!;
}

export const pushQBItem = async (itemId: string) => {
    const response = await api.post<ApiResponse<{pushed: boolean}>>(`integrations/quickbooks/items/${itemId}/push`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to push QB item");
    return response.data.data!;
}

export const getQBVendors = async (): Promise<QBVendorLite[]> => {
    const response = await api.get<ApiResponse<QBVendorLite[]>>("integrations/quickbooks/vendors");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB vendors");
    return response.data.data!;
}

export const getQBMappedVendors = async (): Promise<MappedQBVendor[]> => {
    const response = await api.get<ApiResponse<MappedQBVendor[]>>("integrations/quickbooks/vendors/mappings");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get mapped QB vendors");
    return response.data.data!;
}

export const linkQBVendor = async (supplier_id: string, qb_vendor_id: string) => {
    const response = await api.post<ApiResponse<{linked: boolean}>>("integrations/quickbooks/vendor-mappings", {supplier_id, qb_vendor_id});
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to link QB vendor");
    return response.data.data!;
}

export const unlinkQBVendor = async (supplier_id: string) => {
    const response = await api.delete<ApiResponse<{unlinked: boolean}>>(`integrations/quickbooks/vendor-mappings/${supplier_id}`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to unlink QB vendor");
    return response.data.data!;
}

export const importQBVendor = async (qb_vendor_id: string) => {
    const response = await api.post<ApiResponse<{ supplier: Supplier; linkedExisting: boolean }>>(`integrations/quickbooks/vendors/${qb_vendor_id}/import`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to import QB vendor");
    return response.data.data!;
}

export const pushQBVendor = async (supplierId: string) => {
    const response = await api.post<ApiResponse<{pushed: boolean; qb_vendor_id: string}>>(`integrations/quickbooks/vendors/${supplierId}/push`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to push supplier to QB");
    return response.data.data!;
}

export const getQBPurchaseOrders = async (): Promise<QBPurchaseOrder[]> => {
    const response = await api.get<ApiResponse<QBPurchaseOrder[]>>("integrations/quickbooks/purchase-orders");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB purcase orders");
    return response.data.data!;
}

export const pushPurchaseToQB = async (purchaseId: string) => {
    const response = await api.post<ApiResponse<{ pushed: boolean; qb_purchase_order_id: string }>>(`integrations/quickbooks/purchases/${purchaseId}/push`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to push purchase to QB");
    return response.data.data!;
}

export const pushFieldPurchaseToQB = async (purchaseId: string) => {
    const response = await api.post<ApiResponse<{ pushed: boolean; qb_purchase_order_id: string }>>(`integrations/quickbooks/field-purchases/${purchaseId}/push`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to push purchase to QB");
    return response.data.data!;
}

export const pushTimesheetToQB = async (timesheetId: string) => {
    const response = await api.post<ApiResponse<{ pushed: boolean }>>(`integrations/quickbooks/timesheets/${timesheetId}/push`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to push timesheet to QB");
    return response.data.data!;
}

export const viewQBPurchaseOrderPdf = async (purchaseId: string): Promise<void> => {
    const response = await api.get(`integrations/quickbooks/purchases/${purchaseId}/pdf`, { responseType: "blob" });
    const url = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
    window.open(url, "_blank");
};

export const getQBTaxCodes = async (): Promise<QBTaxCodeLite[]> => {
    const response = await api.get<ApiResponse<QBTaxCodeLite[]>>("integrations/quickbooks/tax-codes");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB tax codes");
    return response.data.data!;
}

export const getQBTaxPrefs = async (): Promise<{ automatedSalesTax: boolean }> => {
    const response = await api.get<ApiResponse<{ automatedSalesTax: boolean }>>("integrations/quickbooks/tax-preferences");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB tax preferences");
    return response.data.data!;
}

export const linkTaxCode = async (tax_group_id: string, qb_tax_code_id: string) => {
    const response = await api.put<ApiResponse<{linked: boolean}>>(`integrations/quickbooks/tax-groups/${tax_group_id}/qb-tax-code`, {qb_tax_code_id});
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to link QB tax code");
    return response.data.data!;
}

export const unlinkTaxCode = async (tax_group_id: string) => {
    const response = await api.delete<ApiResponse<{unlinked: boolean}>>(`integrations/quickbooks/tax-groups/${tax_group_id}/qb-tax-code`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to unlink QB tax code");
    return response.data.data!;
}

export const getImportableQBInvoices = async (clientId?: string): Promise<QBImportableInvoice[]> => {
    const response = await api.get<ApiResponse<QBImportableInvoice[]>>("integrations/quickbooks/invoices/importable", { params: { clientId } });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get importable QB invoices");
    return response.data.data!;
}

export const getQBInvoicePrefill = async (qbInvoiceId: string): Promise<QBInvoicePrefill> => {
    const response = await api.get<ApiResponse<QBInvoicePrefill>>(`integrations/quickbooks/invoices/${qbInvoiceId}/prefill`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB invoice detail");
    return response.data.data!;
}

export const importQBInvoices = async (qbInvoiceIds: string[]): Promise<QBInvoiceImportResult> => {
    const response = await api.post<ApiResponse<QBInvoiceImportResult>>("integrations/quickbooks/invoices/import", { qbInvoiceIds });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to import QB invoices");
    return response.data.data!;
}

export const getQBProfitAndLossReport = async (query: QBProfitAndLossQuery): Promise<QBProfitAndLossReport> => {
    const response = await api.get<ApiResponse<QBProfitAndLossReport>>("integrations/quickbooks/reports/profit-and-loss", { params: query });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB profit and loss report");
    return response.data.data!;
}

// generalized version of profit and loss report query
export const getQBReport = async (reportType: QBReportTypeId, query: QBReportQuery): Promise<QBReportPayload> => {
    const response = await api.get<ApiResponse<QBReportPayload>>(`integrations/quickbooks/reports/${reportType}`, {params: query});
    if (response.data.error) throw new Error(response.data.error?.message || `Failed to get QB ${reportType} report`);
    return response.data.data!;
}

export const getQBEmployees = async (): Promise<QBEmployeeLite[]> => {
    const response = await api.get<ApiResponse<QBEmployeeLite[]>>("integrations/quickbooks/employees");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get QB employees");
    return response.data.data!;
}

export const getQBMappedEmployees = async (): Promise<MappedQBEmployee[]> => {
    const response = await api.get<ApiResponse<MappedQBEmployee[]>>("integrations/quickbooks/employees/mappings");
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get mapped QB employees");
    return response.data.data!;
}

export const linkQBEmployee = async (technician_id: string, qb_employee_id: string) => {
    const response = await api.post<ApiResponse<{linked: boolean}>>("integrations/quickbooks/employee-mappings", {technician_id, qb_employee_id});
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to link QB employee");
    return response.data.data!;
}

export const unlinkQBEmployee = async (technicianId: string) => {
    const response = await api.delete<ApiResponse<{unlinked: boolean}>>(`integrations/quickbooks/employee-mappings/${technicianId}`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to unlink QB employee");
    return response.data.data!;
}

export const pushQBEmployee = async (technicianId: string) => {
    const response = await api.post<ApiResponse<{pushed: boolean; qb_employee_id: string}>>(`integrations/quickbooks/employees/${technicianId}/push`);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to push QB employee");
    return response.data.data!;
}
