import { useState } from "react";
import { UserPlus, X } from "lucide-react";
import Card from "../../components/ui/Card";
import PageHeader from "../../components/ui/PageHeader";
import SearchBar from "../../components/ui/SearchBar";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import {
	HEADER_BTN_BASE,
	HEADER_BTN_ICON,
	HEADER_BTN_SECONDARY,
	HEADER_META,
} from "../../components/ui/headerActions";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { inputClass, labelClass } from "../components/AuthCard";
import CopyLink from "../components/CopyLink";
import { platformError } from "../api";
import { chip, pageAction, primaryButton } from "../components/orgDetailUi";
import {
	useInviteStaff,
	useResendInvite,
	useResetStaffMfa,
	useSetStaffStatus,
	useStaff,
	useStaffActivity,
} from "../hooks";
import { usePlatformAuth } from "../store";
import type { StaffActivityRow, StaffRow } from "../types";

// Long lists scroll inside their card so the other card stays reachable on screen.
const SCROLL_REGION = "max-h-[min(32rem,60vh)] overflow-y-auto widget-scroll";
const action = HEADER_BTN_SECONDARY;
const dangerAction = `${HEADER_BTN_BASE} cursor-pointer border border-border text-error-text hover:border-error-border hover:bg-error-bg`;
const shortDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const when = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});

function describe(r: StaffActivityRow): string {
	const who = r.target_name ?? "a staff member";
	switch (r.event_type) {
		case "platform_staff.login":
			return "signed in";
		case "platform_staff.setup":
			return "created the first staff account";
		case "platform_staff.invite_accepted":
			return "accepted their invite";
		case "platform_staff.invited":
			return `invited ${who}`;
		case "platform_staff.invite_resent":
			return `sent ${who} a new invite link`;
		case "platform_staff.enabled":
			return `enabled ${who}`;
		case "platform_staff.disabled":
			return `disabled ${who}`;
		case "platform_staff.mfa_reset":
			return `reset two-factor for ${who}`;
		case "platform_staff.locked":
			return `locked ${who} out for 15 minutes after 5 wrong ${r.changes?.factor?.new === "mfa" ? "codes" : "passwords"}`;
		default:
			return r.event_type;
	}
}

const matches = (needle: string, ...hay: (string | null | undefined)[]) =>
	!needle || hay.some((h) => h?.toLowerCase().includes(needle));

function ActivityList() {
	const activity = useStaffActivity();
	const [search, setSearch] = useState("");
	const needle = search.trim().toLowerCase();
	const rows = (activity.data ?? []).filter((r) =>
		matches(needle, r.actor_name, r.target_name, describe(r))
	);
	return (
		<Card
			title="Activity"
			flush
			className="mt-6"
			headerAction={
				activity.data && (
					<span className={HEADER_META}>
						{needle
							? `${rows.length} of ${activity.data.length}`
							: activity.data.length}{" "}
						events
					</span>
				)
			}
		>
			{activity.data && activity.data.length > 0 && (
				<div className="border-b border-border-subtle px-4 py-3">
					<SearchBar
						placeholder="Filter by person or action..."
						value={search}
						onChange={setSearch}
						className="w-full sm:max-w-sm"
					/>
				</div>
			)}
			{activity.isError ? (
				<div className="p-4">
					<FormErrorBanner message={platformError(activity.error)} />
				</div>
			) : !activity.data ? (
				<p className="px-4 py-3 text-sm text-text-secondary">Loading…</p>
			) : activity.data.length === 0 ? (
				<p className="px-4 py-3 text-sm text-text-secondary">
					No activity yet.
				</p>
			) : rows.length === 0 ? (
				<p className="px-4 py-3 text-sm text-text-secondary">
					No events match "{search.trim()}".
				</p>
			) : (
				<ul className={`divide-y divide-border-subtle ${SCROLL_REGION}`}>
					{rows.map((r) => (
						<li
							key={r.id}
							className="flex flex-col gap-0.5 px-4 py-3 text-sm sm:flex-row sm:gap-3"
						>
							<span className="shrink-0 text-text-tertiary tabular-nums sm:w-36">
								{when(r.timestamp)}
							</span>
							<span className="min-w-0 text-text-primary">
								<span className="font-medium">
									{r.actor_name ?? "Someone"}
								</span>{" "}
								{describe(r)}
							</span>
						</li>
					))}
				</ul>
			)}
			<p className="border-t border-border-subtle px-4 py-2 text-xs text-text-tertiary">
				Latest 100 events.
			</p>
		</Card>
	);
}

type Pending = { kind: "disable" | "revoke" | "reset"; row: StaffRow } | null;
type StatusView = "all" | StaffRow["status"];
const STATUS_VIEWS: { id: StatusView; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "active", label: "Active" },
	{ id: "invited", label: "Invited" },
	{ id: "disabled", label: "Disabled" },
];

function StatusChip({ row }: { row: StaffRow }) {
	if (row.status === "invited")
		return (
			<span className={chip}>
				Invited
				{row.invite_expires_at
					? ` · expires ${shortDate(row.invite_expires_at)}`
					: ""}
			</span>
		);
	if (row.status === "disabled" && !row.accepted)
		return <span className={chip}>Invite revoked</span>;
	return <span className={chip}>{row.status === "active" ? "Active" : "Disabled"}</span>;
}

export default function StaffPage() {
	const me = usePlatformAuth((s) => s.staff?.id);
	const staff = useStaff();
	const invite = useInviteStaff();
	const resend = useResendInvite();
	const setStatus = useSetStaffStatus();
	const resetMfa = useResetStaffMfa();

	const [panelOpen, setPanelOpen] = useState(false);
	const [form, setForm] = useState({ name: "", email: "" });
	const [link, setLink] = useState<{ email: string; url: string; fresh: boolean } | null>(
		null
	);
	const [pending, setPending] = useState<Pending>(null);
	const [rowError, setRowError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [statusView, setStatusView] = useState<StatusView>("all");

	const sendInvite = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const r = await invite.mutateAsync(form);
			setLink({ email: r.staff.email, url: r.inviteUrl, fresh: true });
			setForm({ name: "", email: "" });
		} catch {
			// shown from invite.error
		}
	};

	const copyNewLink = async (row: StaffRow) => {
		setRowError(null);
		try {
			const r = await resend.mutateAsync(row.id);
			setPanelOpen(true);
			setLink({ email: row.email, url: r.inviteUrl, fresh: false });
		} catch (err) {
			setRowError(platformError(err));
		}
	};

	const enable = async (row: StaffRow) => {
		setRowError(null);
		try {
			await setStatus.mutateAsync({ id: row.id, status: "active" });
		} catch (err) {
			setRowError(platformError(err));
		}
	};

	const confirmPending = async () => {
		if (!pending) return;
		try {
			if (pending.kind === "reset") await resetMfa.mutateAsync(pending.row.id);
			else
				await setStatus.mutateAsync({
					id: pending.row.id,
					status: "disabled",
				});
			setPending(null);
		} catch {
			// shown in the dialog
		}
	};

	const dialogMutation = pending?.kind === "reset" ? resetMfa : setStatus;
	const dialog =
		pending &&
		{
			disable: {
				title: `Disable ${pending.row.name}?`,
				body: `${pending.row.name} loses back-office access within 30 seconds and every open session ends. Enabling the account later does not bring those sessions back.`,
				confirm: "Disable",
			},
			revoke: {
				title: "Revoke invite?",
				body: `The invite link for ${pending.row.email} stops working.`,
				confirm: "Revoke",
			},
			reset: {
				title: `Reset two-factor for ${pending.row.name}?`,
				body: `${pending.row.name} is signed out and must set up two-factor sign-in again at their next sign-in. Their recovery codes stop working.`,
				confirm: "Reset",
			},
		}[pending.kind];

	const actions = (row: StaffRow) => {
		if (row.id === me) return null;
		const open = (kind: NonNullable<Pending>["kind"]) => {
			dialogMutation.reset();
			setPending({ kind, row });
		};
		return (
			<div className="flex flex-wrap gap-1.5">
				{row.status === "invited" && (
					<>
						<button
							type="button"
							className={action}
							onClick={() => copyNewLink(row)}
						>
							Copy new link
						</button>
						<button
							type="button"
							className={dangerAction}
							onClick={() => open("revoke")}
						>
							Revoke invite
						</button>
					</>
				)}
				{row.status === "active" && (
					<>
						<button
							type="button"
							className={dangerAction}
							onClick={() => open("disable")}
						>
							Disable
						</button>
						{row.mfa_enrolled && (
							<button
								type="button"
								className={dangerAction}
								onClick={() => open("reset")}
							>
								Reset MFA
							</button>
						)}
					</>
				)}
				{row.status === "disabled" && row.accepted && (
					<button
						type="button"
						className={action}
						onClick={() => enable(row)}
					>
						Enable
					</button>
				)}
			</div>
		);
	};

	const nameCell = (row: StaffRow) => (
		<>
			{row.name}
			{row.id === me && <span className="text-text-tertiary"> (you)</span>}
		</>
	);
	const lastSignIn = (row: StaffRow) =>
		row.last_login ? shortDate(row.last_login) : "Never";

	const soleStaff =
		!!staff.data && staff.data.filter((r) => r.status === "active").length === 1;

	const needle = search.trim().toLowerCase();
	const visible = (staff.data ?? []).filter(
		(r) =>
			(statusView === "all" || r.status === statusView) &&
			matches(needle, r.name, r.email)
	);
	const statusOptions = STATUS_VIEWS.map((v) => ({
		...v,
		badge: (staff.data ?? []).filter((r) => v.id === "all" || r.status === v.id).length,
	}));

	return (
		<div className="text-text-primary">
			<PageHeader title="Staff">
				<button
					type="button"
					className={pageAction}
					onClick={() => {
						setPanelOpen((v) => !v);
						invite.reset();
					}}
				>
					<UserPlus size={16} />
					Invite staff
				</button>
			</PageHeader>

			{soleStaff && (
				<p
					role="status"
					className="mb-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text"
				>
					This is the only active staff account. If its authenticator
					app and recovery codes are lost, nobody can reset its
					two-factor sign-in. Invite a second staff member.
				</p>
			)}

			{panelOpen && (
				<Card
					title="Invite staff"
					className="mb-4"
					headerAction={
						<button
							type="button"
							aria-label="Close"
							className={HEADER_BTN_ICON}
							onClick={() => setPanelOpen(false)}
						>
							<X size={16} />
						</button>
					}
				>
					<form onSubmit={sendInvite} className="space-y-3">
						{invite.error && (
							<FormErrorBanner
								message={platformError(
									invite.error
								)}
							/>
						)}
						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<label
									htmlFor="inv-name"
									className={labelClass}
								>
									Name
								</label>
								<input
									id="inv-name"
									className={inputClass}
									value={form.name}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											name: e
												.target
												.value,
										}))
									}
									required
								/>
							</div>
							<div>
								<label
									htmlFor="inv-email"
									className={labelClass}
								>
									Email
								</label>
								<input
									id="inv-email"
									type="email"
									className={inputClass}
									value={form.email}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											email: e
												.target
												.value,
										}))
									}
									required
								/>
							</div>
						</div>
						<button
							type="submit"
							className={primaryButton}
							disabled={invite.isPending}
						>
							Send invite
						</button>
					</form>
					{link && (
						<div className="space-y-2 border-t border-border-subtle pt-3">
							<p className="text-sm text-text-secondary">
								{link.fresh
									? "Invite sent to"
									: "New invite link for"}{" "}
								{link.email}. The link works once
								and expires in 48 hours.
							</p>
							<CopyLink url={link.url} />
						</div>
					)}
				</Card>
			)}

			{rowError && <FormErrorBanner className="mb-4" message={rowError} />}
			{staff.error && (
				<FormErrorBanner className="mb-4" message={platformError(staff.error)} />
			)}

			{staff.isLoading ? (
				<Card flush>
					<div className="space-y-2 p-4">
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="h-9 animate-pulse rounded bg-surface-inset"
							/>
						))}
					</div>
				</Card>
			) : (
				staff.data && (
					<Card
						title="Members"
						flush
						headerAction={
							<span className={HEADER_META}>
								{visible.length === staff.data.length
									? staff.data.length
									: `${visible.length} of ${staff.data.length}`}{" "}
								staff
							</span>
						}
					>
						<div className="flex flex-col gap-2 border-b border-border-subtle px-4 py-3 sm:flex-row sm:items-center">
							<SearchBar
								placeholder="Search name or email..."
								value={search}
								onChange={setSearch}
								className="w-full sm:max-w-sm"
							/>
							<SegmentedToggle<StatusView>
								ariaLabel="Staff status"
								value={statusView}
								options={statusOptions}
								onChange={setStatusView}
							/>
						</div>
						{visible.length === 0 ? (
							<p className="px-4 py-3 text-sm text-text-secondary">
								No staff match these filters.
							</p>
						) : (
						<div className={SCROLL_REGION}>
						<table className="hidden w-full text-sm sm:table">
							<thead className="sticky top-0 z-10 bg-base">
								<tr className="bg-surface-inset/50">
									{[
										"Name",
										"Email",
										"Status",
										"MFA",
										"Last sign-in",
										"",
									].map((h) => (
										<th
											key={h || "actions"}
											className="py-2 pr-3 text-left text-xs font-medium text-text-tertiary first:pl-4 last:pr-4"
										>
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{visible.map((row) => (
									<tr
										key={row.id}
										className="border-t border-border-subtle"
									>
										<td className="py-2 pr-3 text-text-primary first:pl-4 last:pr-4">
											{nameCell(
												row
											)}
										</td>
										<td className="py-2 pr-3 text-text-secondary first:pl-4 last:pr-4">
											{row.email}
										</td>
										<td className="py-2 pr-3 first:pl-4 last:pr-4">
											<StatusChip
												row={
													row
												}
											/>
										</td>
										<td className="py-2 pr-3 text-text-secondary first:pl-4 last:pr-4">
											{row.mfa_enrolled
												? "On"
												: "Not set up"}
										</td>
										<td className="py-2 pr-3 text-text-secondary tabular-nums first:pl-4 last:pr-4">
											{lastSignIn(
												row
											)}
										</td>
										<td className="py-2 pr-3 first:pl-4 last:pr-4">
											{actions(
												row
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<ul className="divide-y divide-border-subtle sm:hidden">
							{visible.map((row) => (
								<li
									key={row.id}
									className="space-y-1 px-4 py-3"
								>
									<div className="flex items-center justify-between gap-2">
										<span className="truncate text-sm font-medium text-text-primary">
											{nameCell(
												row
											)}
										</span>
										<StatusChip
											row={row}
										/>
									</div>
									<p className="truncate text-sm text-text-secondary">
										{row.email}
									</p>
									<p className="text-xs text-text-tertiary">
										MFA{" "}
										{row.mfa_enrolled
											? "on"
											: "not set up"}{" "}
										· Last sign-in{" "}
										{lastSignIn(row)}
									</p>
									{actions(row)}
								</li>
							))}
						</ul>
						</div>
						)}
					</Card>
				)
			)}

			<ActivityList />

			{dialog && (
				<ConfirmDialog
					open
					title={dialog.title}
					body={dialog.body}
					confirmLabel={dialog.confirm}
					tone="destructive"
					pending={dialogMutation.isPending}
					error={
						dialogMutation.error
							? platformError(dialogMutation.error)
							: null
					}
					onConfirm={confirmPending}
					onCancel={() => setPending(null)}
				/>
			)}
		</div>
	);
}
