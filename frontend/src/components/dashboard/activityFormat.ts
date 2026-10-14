import {
	AlertTriangle,
	Briefcase,
	Calendar,
	CheckCircle2,
	Activity,
	MapPin,
	XCircle,
	Inbox,
	FileText,
	ReceiptText,
	Repeat,
	User,
} from "lucide-react";
import type React from "react";
import type { ActivityLog } from "../../types/logs";
import { OUTCOME_LABELS } from "../disputes/outcomes";
import type { DisputeResolution } from "../../types/disputes";

export type FeedEntry = {
	message: string;
	subtitle: string | null;
	icon: React.ElementType;
	color: string;
	bg: string;
};

const formatCurrency = (val: unknown): string | null => {
	const n = parseFloat(String(val));
	if (isNaN(n)) return null;
	return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
};

const formatShortDate = (val: unknown, tz: string): string | null => {
	if (!val) return null;
	const d = new Date(String(val));
	if (isNaN(d.getTime())) return null;
	return d.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: tz,
	});
};

const disputedDocument = (log: ActivityLog): { kind: "Quote" | "Invoice"; num: string | undefined } => {
	const isQuote = log.event_type.startsWith("quote.");
	const num = (isQuote ? log.changes?._quote_number?.new : log.changes?._invoice_number?.new) as
		| string
		| undefined;
	return { kind: isQuote ? "Quote" : "Invoice", num };
};

export const formatActivity = (log: ActivityLog, tz: string): FeedEntry | null => {
	const changes = log.changes as Record<string, { old: unknown; new: unknown }> | null;
	const newStatus = changes?.status?.new as string | undefined;
	const entityName = changes?.name?.new as string | undefined;

	switch (log.event_type) {
		case "job.created": {
			const jobNum = changes?.job_number?.new as string | undefined;
			const jobName = changes?.name?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			const base = `New job${jobNum ? ` ${jobNum}` : ""} created`;
			return {
				message: jobName ? `${base} — ${jobName}` : base,
				subtitle: clientName && jobNum ? `${clientName} · ${jobNum}` : clientName ?? null,
				icon: Briefcase,
				color: "text-warning-text",
				bg: "bg-warning/10",
			};
		}
		case "job_visit.created": {
			const jobNum = changes?._job_number?.new as string | undefined;
			const visitName = changes?.name?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			const dateStr = formatShortDate(changes?.scheduled_start_at?.new, tz);
			const namePart = visitName ? `Visit '${visitName}'` : "Visit";
			const jobPart = jobNum ? ` on ${jobNum}` : "";
			const datePart = dateStr ? ` — ${dateStr}` : "";
			return {
				message: `${namePart} scheduled${jobPart}${datePart}`,
				subtitle: clientName && jobNum ? `${clientName} · ${jobNum}` : clientName ?? null,
				icon: Calendar,
				color: "text-primary-text",
				bg: "bg-primary/10",
			};
		}
		case "job_visit.updated": {
			const jobNum = changes?._job_number?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			const suffix = jobNum ? ` on ${jobNum}` : "";
			const subtitle = clientName && jobNum ? `${clientName} · ${jobNum}` : clientName ?? null;
			if (!newStatus) {
				const rescheduledDate = formatShortDate(changes?.scheduled_start_at?.new, tz);
				if (rescheduledDate)
					return {
						message: `Visit${suffix} rescheduled to ${rescheduledDate}`,
						subtitle,
						icon: Calendar,
						color: "text-primary-text",
						bg: "bg-primary/10",
					};
				return null;
			}
			if (newStatus === "Completed")
				return { message: `Visit${suffix} marked complete`, subtitle, icon: CheckCircle2, color: "text-success-text", bg: "bg-emerald-500/10" };
			if (newStatus === "InProgress")
				return { message: `Visit${suffix} now in progress`, subtitle, icon: Activity, color: "text-warning-text", bg: "bg-warning/10" };
			if (newStatus === "OnSite")
				return { message: `Technician on site${suffix}`, subtitle, icon: MapPin, color: "text-reviewing-text", bg: "bg-purple-500/10" };
			if (newStatus === "Driving")
				return { message: `Technician en route${suffix}`, subtitle, icon: MapPin, color: "text-info-text", bg: "bg-cyan-500/10" };
			if (newStatus === "Cancelled")
				return { message: `Visit${suffix} cancelled`, subtitle, icon: XCircle, color: "text-error-text", bg: "bg-error/10" };
			return null;
		}
		case "job_visit.technicians_assigned": {
			const techsNew = changes?.technicians?.new;
			const rawTechs: unknown[] = Array.isArray(techsNew) ? techsNew : [];
			const isUUID = (s: unknown) =>
				typeof s === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
			const newTechs = rawTechs.filter((t): t is string => typeof t === "string" && !isUUID(t));
			let label: string;
			if (newTechs.length === 0) label = "Technician";
			else if (newTechs.length === 1) label = newTechs[0];
			else if (newTechs.length === 2) label = `${newTechs[0]} & ${newTechs[1]}`;
			else label = `${newTechs[0]} & ${newTechs.length - 1} others`;
			const jobNum = changes?._job_number?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			return {
				message: label + " assigned to visit" + (jobNum ? ` on ${jobNum}` : ""),
				subtitle: clientName && jobNum ? `${clientName} · ${jobNum}` : clientName ?? null,
				icon: User,
				color: "text-primary-text",
				bg: "bg-primary/10",
			};
		}
		case "request.created": {
			const title = changes?.title?.new as string | undefined;
			const priority = changes?.priority?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			const hasPriority = priority && priority !== "None" && priority !== "Low";
			const base = hasPriority ? `New ${priority} priority request` : "New request received";
			return {
				message: title ? `${base}: '${title}'` : base,
				subtitle: clientName && title ? `${clientName} · ${title}` : clientName ?? null,
				icon: Inbox,
				color: "text-orange-400",
				bg: "bg-orange-500/10",
			};
		}
		case "request.updated": {
			const clientName = changes?.client_name?.new as string | undefined;
			const title = changes?.title?.new as string | undefined;
			const subtitle = clientName && title ? `${clientName} · ${title}` : clientName ?? null;
			if (newStatus === "Reviewing") return { message: "Request under review", subtitle, icon: Inbox, color: "text-orange-400", bg: "bg-orange-500/10" };
			if (newStatus === "Quoted") return { message: "Quote created for request", subtitle, icon: Inbox, color: "text-orange-400", bg: "bg-orange-500/10" };
			if (newStatus === "ConvertedToJob") return { message: "Request converted to job", subtitle, icon: Inbox, color: "text-orange-400", bg: "bg-orange-500/10" };
			if (newStatus === "Cancelled") return { message: "Request cancelled", subtitle, icon: XCircle, color: "text-error-text", bg: "bg-error/10" };
			return null;
		}
		case "quote.created": {
			const qNum = changes?.quote_number?.new as string | undefined;
			const qTitle = changes?.title?.new as string | undefined;
			const qTotal = formatCurrency(changes?.total?.new);
			const clientName = changes?.client_name?.new as string | undefined;
			let msg = `Quote${qNum ? ` ${qNum}` : ""} created`;
			if (qTitle) msg += ` — ${qTitle}${qTotal ? ` (${qTotal})` : ""}`;
			else if (qTotal) msg += ` — ${qTotal}`;
			return {
				message: msg,
				subtitle: clientName && qNum ? `${clientName} · ${qNum}` : clientName ?? null,
				icon: FileText,
				color: "text-primary-text",
				bg: "bg-primary/10",
			};
		}
		case "quote.updated": {
			if (!newStatus) return null;
			const qNum = changes?._quote_number?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			const qSuffix = qNum ? ` ${qNum}` : "";
			const subtitle = clientName && qNum ? `${clientName} · ${qNum}` : clientName ?? null;
			if (newStatus === "Sent") return { message: `Quote${qSuffix} sent to client`, subtitle, icon: FileText, color: "text-primary-text", bg: "bg-primary/10" };
			if (newStatus === "Approved") return { message: `Quote${qSuffix} approved`, subtitle, icon: CheckCircle2, color: "text-success-text", bg: "bg-emerald-500/10" };
			if (newStatus === "Rejected") return { message: `Quote${qSuffix} rejected`, subtitle, icon: XCircle, color: "text-error-text", bg: "bg-error/10" };
			return null;
		}
		case "invoice.created": {
			const invNum = changes?.invoice_number?.new as string | undefined;
			const invTotal = formatCurrency(changes?.total?.new);
			const clientName = changes?.client_name?.new as string | undefined;
			const base = `Invoice${invNum ? ` ${invNum}` : ""} created`;
			return {
				message: invTotal ? `${base} — ${invTotal}` : base,
				subtitle: clientName && invNum ? `${clientName} · ${invNum}` : clientName ?? null,
				icon: ReceiptText,
				color: "text-success-text",
				bg: "bg-success/10",
			};
		}
		case "invoice.updated": {
			if (!newStatus) return null;
			const invNum = changes?._invoice_number?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			const invSuffix = invNum ? ` ${invNum}` : "";
			const subtitle = clientName && invNum ? `${clientName} · ${invNum}` : clientName ?? null;
			if (newStatus === "Sent") return { message: `Invoice${invSuffix} sent to client`, subtitle, icon: ReceiptText, color: "text-success-text", bg: "bg-success/10" };
			if (newStatus === "Void") return { message: `Invoice${invSuffix} voided`, subtitle, icon: XCircle, color: "text-error-text", bg: "bg-error/10" };
			if (newStatus === "Paid") return { message: `Invoice${invSuffix} fully paid`, subtitle, icon: CheckCircle2, color: "text-success-text", bg: "bg-emerald-500/10" };
			return null;
		}
		case "invoice_payment.created": {
			const invNum = changes?._invoice_number?.new as string | undefined;
			const amount = formatCurrency(changes?.amount?.new);
			const method = changes?.method?.new as string | undefined;
			const clientName = changes?.client_name?.new as string | undefined;
			let msg = amount ? `Payment of ${amount} received` : "Payment received";
			if (invNum) msg += ` on ${invNum}`;
			if (method) msg += ` via ${method}`;
			return {
				message: msg,
				subtitle: clientName && invNum ? `${clientName} · ${invNum}` : clientName ?? null,
				icon: CheckCircle2,
				color: "text-success-text",
				bg: "bg-emerald-500/10",
			};
		}
		case "recurring_occurrence.generated": {
			const count = changes?.generated_count?.new;
			const n = typeof count === "number" ? count : parseInt(String(count ?? ""), 10);
			const countStr = !isNaN(n) ? `${n} visit${n === 1 ? "" : "s"} generated` : "Visits generated";
			const clientName = changes?.client_name?.new as string | undefined;
			return {
				message: `${countStr} from recurring plan`,
				subtitle: clientName ?? null,
				icon: Repeat,
				color: "text-indigo-400",
				bg: "bg-indigo-500/10",
			};
		}
		case "recurring_plan.created": {
			const clientName = changes?.client_name?.new as string | undefined;
			return {
				message: `Recurring plan created${entityName ? ` — ${entityName}` : ""}`,
				subtitle: clientName ?? null,
				icon: Repeat,
				color: "text-primary-text",
				bg: "bg-primary/10",
			};
		}
		case "technician.updated": {
			const name = changes?.name?.new as string | undefined;
			const title = changes?.title?.new as string | undefined;
			const techName = name ?? "Technician";
			if (newStatus === "Available") return { message: `${techName} is now available`, subtitle: title ?? null, icon: CheckCircle2, color: "text-success-text", bg: "bg-emerald-500/10" };
			if (newStatus === "Offline") return { message: `${techName} went offline`, subtitle: title ?? null, icon: User, color: "text-text-tertiary", bg: "bg-zinc-500/10" };
			if (newStatus === "Break") return { message: `${techName} on break`, subtitle: title ?? null, icon: User, color: "text-primary-text", bg: "bg-primary/10" };
			if (newStatus === "EnRoute") return { message: `${techName} en route to job`, subtitle: title ?? null, icon: MapPin, color: "text-info-text", bg: "bg-cyan-500/10" };
			if (newStatus === "OnSite") return { message: `${techName} arrived on site`, subtitle: title ?? null, icon: MapPin, color: "text-reviewing-text", bg: "bg-purple-500/10" };
			if (newStatus === "Working") return { message: `${techName} started working`, subtitle: title ?? null, icon: Activity, color: "text-warning-text", bg: "bg-warning/10" };
			return null;
		}
		case "quote.dispute_opened":
		case "invoice.dispute_opened": {
			const { kind, num } = disputedDocument(log);
			return {
				message: `${kind}${num ? ` ${num}` : ""} disputed`,
				subtitle: null,
				icon: AlertTriangle,
				color: "text-warning-text",
				bg: "bg-warning/10",
			};
		}
		case "quote.dispute_resolved":
		case "invoice.dispute_resolved": {
			const { kind, num } = disputedDocument(log);
			const outcome = changes?.dispute_resolution?.new as DisputeResolution | undefined;
			return {
				message: `Dispute on ${num ?? kind.toLowerCase()} resolved${outcome ? ` — ${OUTCOME_LABELS[outcome]}` : ""}`,
				subtitle: null,
				icon: CheckCircle2,
				color: "text-text-secondary",
				bg: "bg-surface",
			};
		}
		default:
			return null;
	}
};

export const resolveRoute = (log: ActivityLog): string | null => {
	const ch = log.changes;
	const id = log.entity_id;
	switch (log.event_type) {
		case "job.created":
			return `/dispatch/jobs/${id}`;
		case "job_visit.created":
		case "job_visit.updated":
		case "job_visit.technicians_assigned":
		case "job_visit.generated_from_occurrence": {
			const jobId = (ch?.job_id?.new ?? ch?._job_id?.new) as string | undefined;
			return jobId ? `/dispatch/jobs/${jobId}/visits/${id}` : `/dispatch/jobs`;
		}
		case "request.created":
		case "request.updated":
			return `/dispatch/requests/${id}`;
		case "quote.created":
		case "quote.updated":
		case "quote.dispute_opened":
		case "quote.dispute_resolved":
			return `/dispatch/quotes/${id}`;
		case "invoice.created":
		case "invoice.updated":
		case "invoice.dispute_opened":
		case "invoice.dispute_resolved":
			return `/dispatch/invoices/${id}`;
		case "invoice_payment.created": {
			const invoiceId = ch?.invoice_id?.new as string | undefined;
			return invoiceId ? `/dispatch/invoices/${invoiceId}` : null;
		}
		case "recurring_plan.created":
		case "recurring_occurrence.generated":
			return `/dispatch/recurring-plans/${id}`;
		default:
			return null;
	}
};

export const timeAgo = (iso: string): string => {
	const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (diff < 15) return "just now";
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
};
