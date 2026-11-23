import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { useSmsAccount } from "../../../hooks/useSmsAccount";
import type { SmsAccount, SmsAccountStatus } from "../../../api/smsAccount";
import SmsRegistrationForm from "./SmsRegistrationForm";

const STEPS = ["Details", "Business check", "Campaign check", "Active"] as const;

type StepState = "done" | "current" | "error" | "todo";

const STEP_SR = { done: "done", current: "in progress", error: "needs changes" } as const;

/** Index of the step in progress; a failure sends the org back to Details. */
function currentStep(status: SmsAccountStatus): number {
	switch (status) {
		case "submitted":
		case "brand_pending":
			return 1;
		case "campaign_pending":
			return 2;
		case "active":
		case "suspended":
			return 3;
		default:
			return 0;
	}
}

function stepState(i: number, status: SmsAccountStatus): StepState {
	const at = currentStep(status);
	if (status === "active") return "done";
	if (i < at) return "done";
	if (i > at) return "todo";
	return status === "failed" || status === "suspended" ? "error" : "current";
}

function StatusTrack({ status }: { status: SmsAccountStatus }) {
	return (
		<ol aria-label="Registration progress" className="flex items-center gap-2">
			{STEPS.map((label, i) => {
				const s = stepState(i, status);
				const dot =
					s === "done"
						? "border-primary bg-primary text-on-primary"
						: s === "current"
							? "border-primary text-primary-text"
							: s === "error"
								? "border-error bg-error-bg text-error-text"
								: "border-border text-text-muted";
				return (
					<li
						key={label}
						data-state={s}
						aria-current={
							s === "current" || s === "error"
								? "step"
								: undefined
						}
						className="flex min-w-0 flex-1 items-center gap-2"
					>
						<span
							aria-hidden
							className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${dot}`}
						>
							{s === "done" ? (
								<Check size={12} strokeWidth={3} />
							) : s === "error" ? (
								<X size={12} strokeWidth={3} />
							) : (
								i + 1
							)}
						</span>
						<span
							className={`truncate text-xs ${
								s === "todo"
									? "text-text-muted"
									: "font-medium text-text-primary"
							}`}
						>
							{label}
							{s !== "todo" && (
								<span className="sr-only">
									{" "}
									({STEP_SR[s]})
								</span>
							)}
						</span>
						{i < STEPS.length - 1 && (
							<span
								aria-hidden
								className={`h-px min-w-3 flex-1 ${s === "done" ? "bg-primary" : "bg-border"}`}
							/>
						)}
					</li>
				);
			})}
		</ol>
	);
}

const PENDING: SmsAccountStatus[] = ["submitted", "brand_pending", "campaign_pending"];

function formatDate(iso: string) {
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function Body({ acct, onEdit }: { acct: SmsAccount; onEdit: () => void }) {
	const reg = acct.registration;
	const started = !!reg && Object.keys(reg).length > 0;
	const button = (label: string) => (
		<button
			type="button"
			onClick={onEdit}
			className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover"
		>
			{label}
		</button>
	);

	if (acct.status === "draft")
		return (
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="max-w-prose text-xs text-text-muted">
					Text customers from your own local number. US carriers
					require a one-time business registration before any texts
					can be sent.
				</p>
				{button(started ? "Continue setup" : "Set up")}
			</div>
		);

	if (acct.status === "failed")
		return (
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div
					role="alert"
					className="flex min-w-0 flex-1 basis-72 items-start gap-2 rounded-md border border-error-border bg-error-bg px-3 py-2.5 text-xs text-error-text"
				>
					<AlertTriangle size={14} className="mt-0.5 shrink-0" />
					<div className="min-w-0">
						<p className="font-medium">
							Setup stopped before your number was ready.
						</p>
						<p className="mt-0.5 break-words">
							{acct.failure_reason ??
								"No reason was given."}
						</p>
					</div>
				</div>
				{button("Edit and resubmit")}
			</div>
		);

	if (PENDING.includes(acct.status)) {
		const soleProp = !reg?.ein && !!reg?.sole_prop_mobile;
		return (
			<div className="space-y-1 text-xs text-text-muted">
				<p className="text-text-secondary">
					This usually takes about two weeks. We check on it for you
					and notify you when it's done.
				</p>
				{soleProp && acct.status !== "campaign_pending" && (
					<p>
						Watch for a text to {reg?.sole_prop_mobile} and
						reply to it to confirm your identity.
					</p>
				)}
				{acct.submitted_at && (
					<p>Submitted {formatDate(acct.submitted_at)}.</p>
				)}
			</div>
		);
	}

	if (acct.status === "suspended")
		return (
			<div
				role="alert"
				className="flex items-start gap-2 rounded-md border border-error-border bg-error-bg px-3 py-2.5 text-xs text-error-text"
			>
				<AlertTriangle size={14} className="mt-0.5 shrink-0" />
				<p>
					The carriers suspended text messaging for your business.
					Texts are not being sent. Contact support to resolve it.
				</p>
			</div>
		);

	const { used, limit } = acct.usage;
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
			<dt className="text-text-muted">Your number</dt>
			<dd className="font-medium tabular-nums text-text-primary">
				{acct.phone_number}
			</dd>
			<dt className="text-text-muted">This month</dt>
			<dd className="tabular-nums text-text-primary">
				{limit === null
					? `${used.toLocaleString()} text segments`
					: `${used.toLocaleString()} of ${limit.toLocaleString()} text segments`}
			</dd>
		</dl>
	);
}

const STATUS_LABEL: Record<SmsAccountStatus, string> = {
	draft: "Not set up",
	submitted: "In review",
	brand_pending: "In review",
	campaign_pending: "In review",
	active: "Active",
	failed: "Needs changes",
	suspended: "Suspended",
};

const STATUS_CHIP: Record<SmsAccountStatus, string> = {
	draft: "border-border text-text-tertiary",
	submitted: "border-primary-border bg-primary-bg text-primary-text",
	brand_pending: "border-primary-border bg-primary-bg text-primary-text",
	campaign_pending: "border-primary-border bg-primary-bg text-primary-text",
	active: "border-success-border bg-success-bg text-success-text",
	failed: "border-error-border bg-error-bg text-error-text",
	suspended: "border-error-border bg-error-bg text-error-text",
};

export default function SmsSetupCard() {
	const { data: acct, isLoading, error } = useSmsAccount();
	const [editing, setEditing] = useState(false);
	const qc = useQueryClient();
	const status = acct?.status;

	// Activation happens in the background; the Text switches follow it.
	useEffect(() => {
		if (status === "active")
			qc.invalidateQueries({ queryKey: ["customer-comms", "settings"] });
	}, [status, qc]);

	return (
		<section
			aria-labelledby="sms-setup-title"
			className="rounded-lg border border-border-subtle bg-base"
		>
			<div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
				<div>
					<h2
						id="sms-setup-title"
						className="text-sm font-semibold text-text-primary"
					>
						Text messaging
					</h2>
					<p className="mt-0.5 text-xs text-text-muted">
						Your business's own number for appointment texts.
					</p>
				</div>
				{acct && (
					<span
						className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP[acct.status]}`}
					>
						{STATUS_LABEL[acct.status]}
					</span>
				)}
			</div>
			<div className="space-y-4 px-5 py-4">
				{isLoading && (
					<div className="flex justify-center py-2">
						<Loader2
							size={18}
							className="animate-spin text-text-muted"
						/>
					</div>
				)}
				{error && !isLoading && (
					<p className="text-sm text-error-text">
						{(error as Error).message}
					</p>
				)}
				{acct && (
					<>
						<StatusTrack status={acct.status} />
						<Body acct={acct} onEdit={() => setEditing(true)} />
					</>
				)}
			</div>
			{editing && acct && (
				<SmsRegistrationForm
					draft={acct.registration}
					onClose={() => setEditing(false)}
				/>
			)}
		</section>
	);
}
