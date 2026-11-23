import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Loader2, MessageSquareOff, Pencil, Plus, X } from "lucide-react";
import { usePermission } from "../../hooks/usePermission";
import { useModuleOn } from "../../hooks/useEntitlements";
import { useSequencesQuery } from "../../hooks/useFollowups";
import {
	useCustomerCommsSettings,
	useCustomerTemplate,
	useCustomerTemplateContext,
	useResetCustomerTemplate,
	useUpdateCustomerCommsSetting,
	useUpdateCustomerTemplate,
} from "../../hooks/useCustomerComms";
import type {
	CustomerEvent,
	CustomerEventSetting,
	UpdateCustomerEventSetting,
} from "../../types/customerComms";
import ToggleSwitch from "../ui/ToggleSwitch";
import FullPopup from "../ui/FullPopup";
import TemplateEditorModal from "../followups/TemplateEditorModal";
import { FeedbackBanner, INPUT, useFeedback } from "../followups/shared";
import SmsSetupCard from "./sms/SmsSetupCard";

const DEFAULT_LEAD_HOURS = [24];
const SMS_SETUP_HINT = "Set up text messaging first";
const REVIEW_LINK_HINT = "Add your review link first";

const isHttpsUrl = (value: string) => {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
};

/** Turning a review request on without a link is refused by the server. */
const needsReviewLink = (s: CustomerEventSetting) =>
	s.event === "review_request" && !s.review_url && !s.email_enabled && !s.sms_enabled;

/** Two reminder systems would double-send, so say so when both are live. */
function FollowupOverlapBanner() {
	const { data: sequences } = useSequencesQuery();
	if (!sequences?.some((s) => s.is_active && s.trigger_type === "visit_scheduled"))
		return null;
	return (
		<div
			role="status"
			className="mx-5 mt-4 flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5 text-xs text-warning-text"
		>
			<AlertTriangle size={14} className="mt-0.5 shrink-0" />
			<p>
				An active Followups sequence also sends reminders when a visit is
				scheduled. Customers may get two reminders.{" "}
				<Link to="/dispatch/followups" className="font-medium underline">
					Review Followups
				</Link>
			</p>
		</div>
	);
}

function ReminderLeadTimes({
	setting,
	canManage,
	onSave,
	saving,
}: {
	setting: CustomerEventSetting;
	canManage: boolean;
	onSave: (hours: number[]) => void;
	saving: boolean;
}) {
	const saved = setting.config.lead_hours ?? DEFAULT_LEAD_HOURS;
	const [hours, setHours] = useState<string[]>(() => saved.map(String));
	const parsed = hours.map((h) => Number(h));
	const valid = parsed.every((n) => Number.isInteger(n) && n >= 1 && n <= 168);
	const dirty = JSON.stringify(parsed) !== JSON.stringify(saved);

	return (
		<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
			<span>Remind</span>
			{hours.map((h, i) => (
				<span key={i} className="inline-flex items-center gap-1">
					<input
						type="number"
						min={1}
						max={168}
						value={h}
						disabled={!canManage}
						aria-label={`Reminder ${i + 1} hours before`}
						onChange={(e) =>
							setHours(
								hours.map((v, j) =>
									j === i ? e.target.value : v
								)
							)
						}
						className={`${INPUT} !w-16`}
					/>
					{hours.length > 1 && canManage && (
						<button
							type="button"
							aria-label={`Remove reminder ${i + 1}`}
							onClick={() =>
								setHours(
									hours.filter(
										(_, j) => j !== i
									)
								)
							}
							className="rounded p-1 text-text-muted transition-colors hover:bg-surface hover:text-text-primary"
						>
							<X size={12} />
						</button>
					)}
				</span>
			))}
			<span>hours before the visit</span>
			{canManage && hours.length < 3 && (
				<button
					type="button"
					onClick={() => setHours([...hours, "2"])}
					className="inline-flex items-center gap-1 rounded-md border border-border bg-base px-2 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised"
				>
					<Plus size={12} /> Add reminder
				</button>
			)}
			{canManage && dirty && (
				<button
					type="button"
					disabled={!valid || saving}
					onClick={() =>
						onSave([...new Set(parsed)].sort((a, b) => a - b))
					}
					className="inline-flex h-7 items-center rounded-md bg-confirm px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-confirm-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					Save reminders
				</button>
			)}
			{!valid && (
				<span className="text-error-text">
					Use whole hours from 1 to 168.
				</span>
			)}
		</div>
	);
}

function LateThreshold({
	setting,
	canManage,
	onSave,
	saving,
}: {
	setting: CustomerEventSetting;
	canManage: boolean;
	onSave: (minutes: number) => void;
	saving: boolean;
}) {
	// The server always fills in the default when nothing is stored.
	const saved = setting.config.threshold_minutes;
	const [value, setValue] = useState(String(saved ?? ""));
	const minutes = Number(value);
	const valid =
		value.trim() !== "" && Number.isInteger(minutes) && minutes >= 10 && minutes <= 120;

	return (
		<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
			<span>Notify when the visit is forecast</span>
			<input
				type="number"
				min={10}
				max={120}
				value={value}
				disabled={!canManage}
				aria-label="Minutes late before notifying the customer"
				aria-invalid={!valid}
				onChange={(e) => setValue(e.target.value)}
				className={`${INPUT} !w-16`}
			/>
			<span>minutes late or more</span>
			{canManage && minutes !== saved && (
				<button
					type="button"
					disabled={!valid || saving}
					onClick={() => onSave(minutes)}
					className="inline-flex h-7 items-center rounded-md bg-confirm px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-confirm-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					Save threshold
				</button>
			)}
			{!valid && (
				<span className="text-error-text">
					Use whole minutes from 10 to 120.
				</span>
			)}
		</div>
	);
}

function ReviewLinkField({
	setting,
	hintId,
	canManage,
	onSave,
	saving,
}: {
	setting: CustomerEventSetting;
	hintId: string;
	canManage: boolean;
	onSave: (url: string | null) => void;
	saving: boolean;
}) {
	const saved = setting.review_url ?? "";
	const [url, setUrl] = useState(saved);
	const trimmed = url.trim();
	const valid = trimmed === "" || isHttpsUrl(trimmed);
	const dirty = trimmed !== saved;
	const on = setting.email_enabled || setting.sms_enabled;
	// Clearing a saved link while a switch is on; the server refuses it.
	const removingWhileOn = on && !!saved && trimmed === "";

	return (
		<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
			<label htmlFor="review-link" className="shrink-0">
				Review link
			</label>
			<input
				id="review-link"
				type="url"
				inputMode="url"
				spellCheck={false}
				placeholder="https://g.page/r/your-business/review"
				value={url}
				disabled={!canManage}
				aria-invalid={!valid}
				onChange={(e) => setUrl(e.target.value)}
				className={`${INPUT} !h-7 min-w-0 max-w-md flex-1 basis-64 !text-xs`}
			/>
			{canManage && dirty && (
				<button
					type="button"
					disabled={!valid || saving || removingWhileOn}
					onClick={() => onSave(trimmed || null)}
					className="inline-flex h-7 items-center rounded-md bg-confirm px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-confirm-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					Save link
				</button>
			)}
			{!valid ? (
				<span className="basis-full text-error-text">
					The link must start with https://
				</span>
			) : removingWhileOn ? (
				<span className="basis-full text-error-text">
					Turn off review requests before removing the link.
				</span>
			) : (
				// Also shown when a switch is on but the link was removed from
				// the organization settings: nothing sends until one is added.
				!saved && (
					<span
						id={hintId}
						className={`basis-full ${on ? "text-warning-text" : "text-text-muted"}`}
					>
						{REVIEW_LINK_HINT}
					</span>
				)
			)}
		</div>
	);
}

function MessageEditor({ event, onClose }: { event: CustomerEvent; onClose: () => void }) {
	const { data: template, error } = useCustomerTemplate(event);
	const { data: context } = useCustomerTemplateContext();
	const update = useUpdateCustomerTemplate();
	const reset = useResetCustomerTemplate();
	const canManage = usePermission("manage_customer_comms");
	if (error || !template) {
		return (
			<FullPopup
				isModalOpen
				onClose={onClose}
				size="md"
				content={
					<div
						className="flex items-center justify-center gap-2 p-8 text-sm"
						role="status"
					>
						{error ? (
							<>
								<span className="text-error-text">
									{(error as Error).message ||
										"Could not load this message."}
								</span>
								<button
									type="button"
									onClick={onClose}
									className="rounded-md border border-border px-2.5 py-1 text-xs text-text-primary hover:bg-surface-raised"
								>
									Close
								</button>
							</>
						) : (
							<>
								<Loader2
									size={16}
									className="animate-spin text-text-muted"
								/>{" "}
								Loading message
							</>
						)}
					</div>
				}
			/>
		);
	}
	return (
		<TemplateEditorModal
			template={template}
			context={context}
			readOnly={!canManage}
			isPending={update.isPending || reset.isPending}
			withSms
			categoryLabel="Customer message"
			onClose={onClose}
			onSave={async (data) => {
				await update.mutateAsync({ event, data });
				onClose();
			}}
			onReset={async () => {
				await reset.mutateAsync(event);
				onClose();
			}}
		/>
	);
}

/** Events grouped by when they reach the customer; unknown events land last. */
const GROUPS: { title: string; events: CustomerEvent[] }[] = [
	{
		title: "Scheduling",
		events: [
			"visit_confirmed",
			"visit_reminder",
			"visit_rescheduled",
			"visit_cancelled",
		],
	},
	{ title: "Day of the visit", events: ["tech_on_the_way", "tech_running_late"] },
	{ title: "After the visit", events: ["visit_completed", "review_request"] },
];

function groupEvents(events: CustomerEventSetting[]) {
	const known = new Set(GROUPS.flatMap((g) => g.events));
	const groups = GROUPS.map((g) => ({
		title: g.title,
		items: g.events
			.map((e) => events.find((s) => s.event === e))
			.filter((s): s is CustomerEventSetting => !!s),
	}));
	groups[groups.length - 1].items.push(...events.filter((s) => !known.has(s.event)));
	return groups.filter((g) => g.items.length > 0);
}

// Name | Email | Text | action. Header and rows share it so the switches line up.
const ROW_GRID = "sm:grid sm:grid-cols-[minmax(0,1fr)_4rem_4rem_8rem] sm:items-center sm:gap-x-2";
const SMS_HINT_ID = "customer-messages-sms-hint";
const SMS_NOT_IN_PLAN = "Text messaging is not included in your plan";

function ChannelSwitch({
	channel,
	label,
	checked,
	disabled,
	describedBy,
	onChange,
}: {
	channel: "Email" | "Text";
	label: string;
	checked: boolean;
	disabled: boolean;
	describedBy?: string;
	onChange: () => void;
}) {
	return (
		<span className="flex items-center gap-2 text-xs text-text-tertiary sm:justify-center">
			<span className="sm:hidden">{channel}</span>
			<ToggleSwitch
				checked={checked}
				disabled={disabled}
				ariaLabel={`${channel} — ${label}`}
				ariaDescribedBy={describedBy}
				onChange={onChange}
			/>
		</span>
	);
}

function EventRow({
	setting: s,
	canManage,
	saving,
	onSave,
	onEdit,
}: {
	setting: CustomerEventSetting;
	canManage: boolean;
	saving: boolean;
	onSave: (data: UpdateCustomerEventSetting, done?: string) => void;
	onEdit: () => void;
}) {
	const reviewHintId = `review-hint-${s.event}`;
	const needsLink = needsReviewLink(s);
	return (
		<li className="px-5 py-3.5">
			<div className={`flex flex-wrap items-center gap-x-5 gap-y-2 ${ROW_GRID}`}>
				<div className="min-w-0 basis-full sm:basis-auto">
					<p className="text-sm font-medium text-text-primary">
						{s.label}
					</p>
					<p className="text-xs text-text-muted">{s.description}</p>
				</div>
				<ChannelSwitch
					channel="Email"
					label={s.label}
					checked={s.email_enabled}
					disabled={!canManage || needsLink || saving}
					describedBy={needsLink ? reviewHintId : undefined}
					onChange={() => onSave({ email_enabled: !s.email_enabled })}
				/>
				<ChannelSwitch
					channel="Text"
					label={s.label}
					checked={s.sms_enabled && s.sms_available}
					disabled={
						!canManage ||
						!s.sms_available ||
						needsLink ||
						saving
					}
					describedBy={
						!s.sms_available
							? SMS_HINT_ID
							: needsLink
								? reviewHintId
								: undefined
					}
					onChange={() => onSave({ sms_enabled: !s.sms_enabled })}
				/>
				<div className="ml-auto sm:ml-0 sm:flex sm:justify-end">
					<button
						type="button"
						onClick={onEdit}
						className="inline-flex items-center gap-1.5 rounded-md border border-border bg-base px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised"
					>
						<Pencil size={12} /> Edit message
					</button>
				</div>
			</div>
			{s.event === "visit_reminder" && (
				<ReminderLeadTimes
					key={JSON.stringify(s.config)}
					setting={s}
					canManage={canManage}
					saving={saving}
					onSave={(hours) =>
						onSave(
							{ config: { lead_hours: hours } },
							"Reminder times saved."
						)
					}
				/>
			)}
			{s.event === "tech_running_late" && (
				<LateThreshold
					key={JSON.stringify(s.config)}
					setting={s}
					canManage={canManage}
					saving={saving}
					onSave={(minutes) =>
						onSave(
							{ config: { threshold_minutes: minutes } },
							"Running-late threshold saved."
						)
					}
				/>
			)}
			{s.event === "review_request" && (
				<ReviewLinkField
					key={s.review_url ?? ""}
					setting={s}
					hintId={reviewHintId}
					canManage={canManage}
					saving={saving}
					onSave={(url) =>
						onSave(
							{ review_url: url },
							url
								? "Review link saved."
								: "Review link removed."
						)
					}
				/>
			)}
		</li>
	);
}

export default function CustomerMessagesSection() {
	const { data: events, isLoading, error } = useCustomerCommsSettings();
	const update = useUpdateCustomerCommsSetting();
	const canManage = usePermission("manage_customer_comms");
	const followupsOn = useModuleOn("followups");
	const canViewFollowups = usePermission("view_followups");
	const smsOn = useModuleOn("sms");
	const [editing, setEditing] = useState<CustomerEvent | null>(null);
	const { feedback, showFeedback } = useFeedback();

	const save = async (
		event: CustomerEvent,
		data: UpdateCustomerEventSetting,
		done?: string
	) => {
		try {
			await update.mutateAsync({ event, data });
			if (done) showFeedback("success", done);
		} catch (e) {
			showFeedback(
				"error",
				e instanceof Error ? e.message : "Could not save the change."
			);
		}
	};

	const reminderEmailOn = !!events?.find((e) => e.event === "visit_reminder")?.email_enabled;
	const smsMissing = !!events?.some((e) => !e.sms_available);
	const showSmsCard = smsOn && canManage;

	return (
		<div className="space-y-4">
			<div className="overflow-hidden rounded-lg border border-border-subtle bg-base">
				<FeedbackBanner feedback={feedback} />
				{/* Notices only; collapses when none render. */}
				<div className="border-b border-border-subtle pb-4 empty:hidden">
					{reminderEmailOn && followupsOn && canViewFollowups && (
						<FollowupOverlapBanner />
					)}
					{smsMissing && (
						<div
							role="note"
							className="mx-5 mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border-subtle bg-surface px-3 py-2 text-xs text-text-tertiary"
						>
							<MessageSquareOff
								size={14}
								className="shrink-0 text-text-muted"
							/>
							<span id={SMS_HINT_ID}>
								{smsOn
									? SMS_SETUP_HINT
									: SMS_NOT_IN_PLAN}
							</span>
							{smsOn && (
								<span className="text-text-muted">
									Text switches unlock once
									your number is active.
								</span>
							)}
							{showSmsCard && (
								<a
									href="#sms-setup"
									onClick={(e) => {
										e.preventDefault();
										document.getElementById(
											"sms-setup"
										)?.scrollIntoView({
											behavior: "smooth",
											block: "start",
										});
									}}
									className="ml-auto font-medium text-primary-text hover:underline"
								>
									Set up texting
								</a>
							)}
						</div>
					)}
				</div>

				{isLoading && (
					<div className="flex items-center justify-center px-5 py-10">
						<Loader2
							size={20}
							className="animate-spin text-text-muted"
						/>
					</div>
				)}
				{error && !isLoading && (
					<p className="px-5 py-6 text-sm text-error-text">
						{(error as Error).message}
					</p>
				)}

				{events && (
					<div>
						{groupEvents(events).map((g, gi) => {
							const headingId = `customer-messages-group-${gi}`;
							return (
								<section
									key={g.title}
									aria-labelledby={headingId}
								>
									<div
										className={`border-b border-border-subtle bg-surface px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted ${ROW_GRID} ${gi === 0 ? "" : "border-t"}`}
									>
										<h3 id={headingId}>
											{g.title}
										</h3>
										<span
											aria-hidden
											className="hidden text-center sm:block"
										>
											Email
										</span>
										<span
											aria-hidden
											className="hidden text-center sm:block"
										>
											Text
										</span>
									</div>
									<ul className="divide-y divide-border-subtle">
										{g.items.map(
											(s) => (
												<EventRow
													key={
														s.event
													}
													setting={
														s
													}
													canManage={
														canManage
													}
													saving={
														update.isPending
													}
													onSave={(
														data,
														done
													) =>
														save(
															s.event,
															data,
															done
														)
													}
													onEdit={() =>
														setEditing(
															s.event
														)
													}
												/>
											)
										)}
									</ul>
								</section>
							);
						})}
					</div>
				)}

				{editing && (
					<MessageEditor
						event={editing}
						onClose={() => setEditing(null)}
					/>
				)}
			</div>
			{showSmsCard && (
				<div id="sms-setup" className="scroll-mt-4">
					<SmsSetupCard />
				</div>
			)}
		</div>
	);
}
