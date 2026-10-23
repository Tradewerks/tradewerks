import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import {
	useAutoSwitchPreview,
	useTaxSettings,
	useUpdateTaxSettings,
} from "../../hooks/useTaxSettings";
import type { AutoSwitchPreview } from "../../api/taxSettings";
import SegmentedToggle from "../ui/SegmentedToggle";
import ConfirmDialog from "../ui/ConfirmDialog";
import Dropdown from "../ui/Dropdown";
import { NO_SALES_TAX_STATES, US_STATES, stateName } from "../../lib/usStates";
import { useToast } from "../ui/useToast";
import { errorMessage } from "../../util/util";

type Mode = "auto" | "manual";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function previewBody(p: AutoSwitchPreview): string {
	if (p.default_group_drafts <= 0)
		return "No drafts use your default tax group. New documents will be taxed by address.";
	const parts = [
		p.quote_drafts > 0 && plural(p.quote_drafts, "quote"),
		p.job_drafts > 0 && plural(p.job_drafts, "job"),
		p.visit_drafts > 0 && plural(p.visit_drafts, "visit"),
		p.invoice_drafts > 0 && plural(p.invoice_drafts, "invoice"),
	].filter(Boolean);
	return `${plural(p.default_group_drafts, "draft document")} (${parts.join(", ")}) will drop their default tax group and recalculate from their address. Overridden groups are kept.`;
}

interface TaxModeCardProps {
	/** Rendered inside the card, below the mode and states block. */
	children?: ReactNode;
}

export default function TaxModeCard({ children }: TaxModeCardProps) {
	const { data: settings, isLoading, error } = useTaxSettings();
	const update = useUpdateTaxSettings();
	const toast = useToast();
	const [pendingMode, setPendingMode] = useState<Mode | null>(null);
	// update.error outlives the action that raised it; only surface it for an attempt made since.
	const [submitted, setSubmitted] = useState(false);
	const [statesSubmitted, setStatesSubmitted] = useState(false);
	const pickerRef = useRef<HTMLSelectElement>(null);

	const previewEnabled = pendingMode === "auto" && settings?.tax_mode === "manual";
	const preview = useAutoSwitchPreview(previewEnabled);

	if (isLoading) {
		return (
			<div className="rounded-lg border border-border-subtle bg-base">
				<div className="flex items-center justify-center px-5 py-10">
					<Loader2 size={20} className="animate-spin text-text-muted" />
				</div>
			</div>
		);
	}
	if (error || !settings) {
		return (
			<div className="rounded-lg border border-border-subtle bg-base px-5 py-6">
				<p className="text-sm text-error-text">
					{errorMessage(error, "Couldn't load tax settings.")}
				</p>
			</div>
		);
	}

	const openDialog = (mode: Mode) => {
		if (mode === settings.tax_mode) return;
		setSubmitted(false);
		setPendingMode(mode);
	};

	const confirm = () => {
		if (!pendingMode) return;
		const mode = pendingMode;
		setSubmitted(true);
		update.mutate(
			{ tax_mode: mode },
			{
				onSuccess: (result) => {
					setPendingMode(null);
					if (mode === "manual") toast.success("Manual tax groups on");
					else
						toast.success(
							result.recompute_queued > 0
								? `Automatic tax on — ${result.recompute_queued} drafts recalculating`
								: "Automatic tax on",
						);
				},
			},
		);
	};

	const saveStates = (next: string[]) => {
		setStatesSubmitted(true);
		update.mutate({ tax_registered_states: next }, {});
	};

	const collectIn =
		settings.tax_registered_states.length > 0
			? settings.tax_registered_states.join(", ")
			: (settings.org_state ?? "your registered states");

	const addableStates = US_STATES.filter(
		(st) =>
			!settings.tax_registered_states.includes(st.code) && !NO_SALES_TAX_STATES.has(st.code),
	);

	const isAuto = settings.tax_mode === "auto";
	// Manual mode with nothing to flag has no body; skip it so it leaves no empty band.
	const hasBody = isAuto || !settings.auto_entitled || settings.qb_passthrough_required;
	const dialogError =
		submitted && update.error
			? errorMessage(update.error, "Couldn't change the tax mode.")
			: null;

	// The switch clears default groups on drafts, so the count must be seen before confirming.
	const previewBlocked = pendingMode === "auto" && (preview.isError || !preview.data);

	const dialogBody =
		pendingMode === "auto" ? (
			<div className="space-y-2">
				{preview.isError ? (
					<p className="text-error-text">
						{errorMessage(preview.error, "Couldn't count affected drafts.")}
					</p>
				) : (
					<p>{preview.data ? previewBody(preview.data) : "Counting drafts…"}</p>
				)}
				<p>You'll collect tax in {collectIn}. Change this below after switching.</p>
			</div>
		) : (
			<p>
				New and draft documents will use your tax groups again. Rates already on drafts stay
				until each is saved.
			</p>
		);

	return (
		<div className="rounded-lg border border-border-subtle bg-base">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle px-5 py-4">
				<h3 className="min-w-0 text-xs font-medium text-text-tertiary">Calculation</h3>
				<SegmentedToggle<Mode>
					ariaLabel="Tax calculation mode"
					className="min-w-0 max-w-full flex-wrap"
					value={settings.tax_mode}
					onChange={openDialog}
					options={[
						{
							id: "auto",
							label: "Automatic (address-based)",
							disabled: !settings.auto_entitled,
							title: !settings.auto_entitled
								? "Not included in your plan"
								: undefined,
						},
						{ id: "manual", label: "Manual groups" },
					]}
				/>
			</div>

			{hasBody && (
				<div
					className={`space-y-3 px-5 py-4 ${children ? "border-b border-border-subtle" : ""}`}
				>
					{isAuto && settings.effective_tax_mode === "manual" && (
						<div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5">
							<AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-warning" />
							<p className="text-xs text-warning-text">
								Automatic tax is off for your plan right now — documents use your
								default tax group.
							</p>
						</div>
					)}
					{!settings.auto_entitled && !isAuto && (
						<p className="text-xs text-text-muted">
							Automatic tax is not included in your plan.
						</p>
					)}
					{settings.qb_passthrough_required && !isAuto && (
						<div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5">
							<AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-warning" />
							<p className="text-xs text-warning-text">
								QuickBooks needs a pass-through tax code before automatic tax can turn
								on.{" "}
								<Link
									to="/dispatch/admin?tab=integrations"
									className="font-medium underline underline-offset-2"
								>
									Set it in Integrations
								</Link>
							</p>
						</div>
					)}

					{isAuto && (
						<div>
							<h3 className="text-xs font-medium text-text-tertiary">
								States where you collect sales tax
							</h3>
							<p className="mt-0.5 text-xs text-text-muted">
								Add each state where you hold a sales tax permit. Your business address
								state is added for you.
							</p>
							<div className="mt-2 w-64 max-w-full">
								<Dropdown
									aria-label="Add a state"
									value=""
									refToApply={pickerRef}
									// Stays enabled while pending: Remove focuses it, and a disabled
									// element would drop focus to <body>.
									onChange={(code) => {
										if (code && !update.isPending)
											saveStates([...settings.tax_registered_states, code]);
									}}
									entries={[
										<option key="" value="">
											Add a state…
										</option>,
										...addableStates.map((st) => (
											<option key={st.code} value={st.code}>
												{st.name} ({st.code})
											</option>
										)),
									]}
								/>
							</div>
							{statesSubmitted && update.error && pendingMode === null && (
								<p className="mt-1.5 text-xs text-error-text">
									{errorMessage(update.error, "Couldn't save the registered states.")}
								</p>
							)}
							{settings.tax_registered_states.length === 0 ? (
								<p className="mt-2 text-xs text-text-muted">No states added yet.</p>
							) : (
								<ul
									aria-label="Registered states"
									className="mt-2 flex flex-wrap gap-1.5"
								>
									{settings.tax_registered_states.map((st) => (
										<li
											key={st}
											className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface pl-2.5 pr-1 text-xs font-medium text-text-primary"
										>
											{stateName(st)}
											{st === settings.org_state && (
												<span
													title="The state in your organization's business address"
													className="text-[10px] font-normal text-text-muted"
												>
													Business address
												</span>
											)}
											<button
												type="button"
												aria-label={`Remove ${st}`}
												disabled={
													update.isPending ||
													settings.tax_registered_states.length === 1
												}
												title={
													settings.tax_registered_states.length === 1
														? "Automatic tax needs at least one state"
														: undefined
												}
												onClick={() => {
													saveStates(
														settings.tax_registered_states.filter(
															(s) => s !== st,
														),
													);
													// The focused button unmounts with its chip.
													pickerRef.current?.focus();
												}}
												className="rounded p-1.5 text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary disabled:opacity-50"
											>
												<X size={12} />
											</button>
										</li>
									))}
								</ul>
							)}
							<p className="mt-1.5 text-xs text-text-muted">
								Documents outside these states are flagged for review instead of
								blocked.
							</p>
						</div>
					)}
				</div>
			)}

			{children}

			<ConfirmDialog
				open={pendingMode !== null}
				title={
					pendingMode === "auto"
						? "Turn on automatic tax?"
						: "Switch to manual tax groups?"
				}
				body={dialogBody}
				confirmLabel={pendingMode === "auto" ? "Turn on automatic tax" : "Switch to manual"}
				pending={update.isPending}
				confirmDisabled={previewBlocked}
				error={dialogError}
				onConfirm={confirm}
				onCancel={() => setPendingMode(null)}
			/>
		</div>
	);
}
