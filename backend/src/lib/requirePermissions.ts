import { NextFunction, Request, Response } from "express";
import { ErrorCodes, createErrorResponse } from "../types/responses.js";
import { db } from "../db.js";
import { log } from "../services/appLogger.js";

/*
 * Available permission strings for use with requirePermission()
 *
 * DISPATCHER
 *   Jobs
 *     view_jobs           · create_jobs        · edit_jobs          · delete_jobs
 *   Requests
 *     view_requests       · create_requests    · edit_requests      · delete_requests
 *   Quotes
 *     view_quotes         · create_quotes      · edit_quotes        · delete_quotes
 *     send_quotes         (emailing the client — independent of edit_quotes)
 *   Invoices
 *     view_invoices       · create_invoices    · edit_invoices      · delete_invoices
 *     send_invoices       (emailing the client — independent of edit_invoices)
 *     refund_invoices     (refunds and invoice voids — cash out)
 *   Disputes
 *     open_disputes       · resolve_disputes
 *     concede_disputes    (required with resolve_disputes for IssueAdjustment / Repeal)
 *     resolve_own_disputes (override for the opener != resolver rule)
 *   Clients
 *     view_clients        · create_clients     · edit_clients       · delete_clients
 *   Inventory
 *     view_inventory      · manage_inventory
 *   Reports
 *     view_reports        · export_reports
 *   Timesheets
 *     view_timesheet      · manage_timesheet   (approve, unapprove, push to QB)
 *   Recurring Plans
 *     view_recurring_plans · manage_recurring_plans
 *   Team
 *     view_technicians    · manage_technicians · view_dispatchers   · manage_dispatchers
 *   Administration
 *     view_admin          · manage_roles        · manage_organization
 *   Field Purchases
 *     view_field_purchases · review_field_purchases · manage_field_purchase_grants
 *     second_sign_off_field_purchases  (must differ from the reviewer and the purchaser)
 *   Purchases
 *     view_purchases      · manage_purchases
 *
 * TECHNICIAN
 *   Jobs
 *     view_assigned_jobs  · view_all_jobs      · update_job_status  · add_job_notes
 *   Job Visits
 *     view_visits         · check_in           · check_out          · update_visit_status · add_visit_notes
 *   Clients
 *     view_clients
 *   Inventory
 *     view_inventory      · use_inventory
 *   Vehicle Stock
 *     stock_own_vehicle   · complete_own_restock
 *     adjust_field_loss   · adjust_transfer      · adjust_audit
 *     adjust_warehouse_exchange
 *   Schedule
 *     view_own_schedule   · view_team_schedule
 *   Forms
 *     view_forms          · submit_forms
 *   Field Purchases
 *     request_field_purchase
 * 	 Timesheets
 *	   edit_own_timesheet
 */

function resolvePerms(req: Request): string[] | null {
	if (req.user?.role === "admin") return null;
	return Array.isArray(req.user?.permissions) ? (req.user.permissions as string[]) : [];
}

// Does the caller hold this permission on its own, ignoring any "or self" escape?
// requirePermissionOrSelf lets a user through on identity alone, so a route that
// also carries privileged fields needs this to tell the two cases apart.
export const hasPermission = (req: Request, permission: string): boolean => {
	const perms = resolvePerms(req);
	return perms === null || perms.includes(permission);
};

export const requirePermission = (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    const perms = resolvePerms(req);
    if (perms === null) return next();
    if (!perms.includes(permission)) {
        return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
    }
    next();
};

/**
 * Gate that engages only for the requests whose body asks for the privileged
 * variant of an operation. Voiding an invoice is a PATCH on the same route
 * that renames its memo, so the cash-out permission cannot sit on the route
 * itself — it has to read what the body is actually asking for.
 */
export const requirePermissionForBody =
	(permission: string, applies: (body: unknown) => boolean) =>
	(req: Request, res: Response, next: NextFunction) => {
		if (!applies(req.body)) return next();
		return requirePermission(permission)(req, res, next);
	};

export const requireAnyPermission = (...permissions: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const perms = resolvePerms(req);
    if (perms === null) return next();
    if (!permissions.some((p) => perms.includes(p))) {
        return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
    }
    next();
};

/**
 * Vehicle-scoped permission gate for vehicle stock routes.
 *
 * Pass order: admin → inventory/fleet managers → technician holding
 * `techPermission` whose CURRENT vehicle matches the :id route param.
 * Technicians can never act on a vehicle they are not checked into.
 */
export const requireVehiclePermission =
	(techPermission: string, vehicleParam = "id") =>
	async (req: Request, res: Response, next: NextFunction) => {
		const perms = resolvePerms(req);
		if (perms === null) return next();
		if (perms.includes("manage_inventory") || perms.includes("manage_technicians")) {
			return next();
		}

		if (req.user?.role === "technician" && perms.includes(techPermission)) {
			try {
				const tech = await db.technician.findFirst({
					where: {
						id: req.user.uid as string,
						organization_id: req.user.organization_id as string,
					},
					select: { current_vehicle_id: true },
				});
				if (tech?.current_vehicle_id && tech.current_vehicle_id === req.params[vehicleParam]) {
					return next();
				}
				return res
					.status(403)
					.json(
						createErrorResponse(
							ErrorCodes.INVALID_CREDENTIALS,
							"You can only manage stock on your current vehicle",
						),
					);
			} catch (err) {
				log.error({ err }, "requireVehiclePermission db lookup failed");
				return res
					.status(403)
					.json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
			}
		}

		return res
			.status(403)
			.json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
	};

export const requirePermissionOrSelf = (permission: string, idParam = "id") => (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.uid === req.params[idParam]) return next();
    const perms = resolvePerms(req);
    if (perms === null) return next();
    if (!perms.includes(permission)) {
        return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
    }
    next();
};

export const requireAnyPermissionOrSelf = (permissions: string[], idParam = "id") => (req: Request, res: Response, next: NextFunction) => {
    if (req.user?.uid === req.params[idParam]) return next();
    const perms = resolvePerms(req);
    if (perms === null) return next();
    if (!permissions.some((p) => perms.includes(p))) {
        return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
    }
    next();
};

export const denyTechnicians = (req: Request, res: Response, next: NextFunction)=>{
	if (req.user?.role === "technician"){
		return res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));
	}
	next();
}
