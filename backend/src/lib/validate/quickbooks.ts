import { z } from "zod";
import { QB_REPORT_TYPES } from "../../services/qb/qbReports.js";

export const linkQBItemSchema = z.object({
	inventory_item_id: z.string().uuid(),
	qb_item_id: z.string().min(1),
});

export const linkQBVendorSchema = z.object({
	supplier_id: z.string().uuid(),
	qb_vendor_id: z.string().min(1),
});

export const linkQBEmployeeSchema = z.object({
	technician_id: z.string().uuid(),
	qb_employee_id: z.string().min(1),
});

export const qbReportTypeSchema = z.enum(QB_REPORT_TYPES); 

export const qbReportQuerySchema = z.object({
    customer: z.string().optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    accounting_method: z.enum(["Cash", "Accrual"]).optional(),
    date_macro: z.string().optional(),
    summarize_column_by: z.string().optional(),
    class: z.string().optional(),
    department: z.string().optional(),
    vendor: z.string().optional(),
    item: z.string().optional(),
    sort_order: z.enum(["ascend", "descend"]).optional(),
    qzurl: z.enum(["true", "false"]).optional(),
    adjusted_gain_loss: z.enum(["true", "false"]).optional(),
});
