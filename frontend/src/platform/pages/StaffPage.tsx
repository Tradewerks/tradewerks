import { useState } from "react";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { inputClass, labelClass } from "../components/AuthCard";
import { platformError } from "../api";
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

const chip = "rounded px-1.5 py-0.5 text-xs bg-surface-inset text-text-secondary";
const action = "text-sm text-primary hover:underline";
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

function ActivityList() {
	const activity = useStaffActivity();
	return (
		<section className="space-y-2">
			<h2 className="text-sm font-semibold text-text-primary">Activity</h2>
			{activity.isError ? (
				<FormErrorBanner message={platformError(activity.error)} />
			) : !activity.data ? (
				<p className="text-sm text-text-secondary">Loading…</p>
			) : activity.data.length === 0 ? (
				<p className="text-sm text-text-secondary">No activity yet.</p>
			) : (
				<ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface">
					{activity.data.map((r) => (
						<li
							key={r.id}
							className="flex flex-col gap-0.5 px-3 py-2 text-sm sm:flex-row sm:gap-3"
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
			<p className="text-xs text-text-tertiary">Latest 100 events.</p>
		</section>
	);
}

type Pending = { kind: "disable" | "revoke" | "reset"; row: StaffRow } | null;

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

function CopyLink({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex gap-2">
			<input
				readOnly
				value={url}
				aria-label="Invite link"
				className={`${inputClass} min-w-0`}
			/>
			<button
				type="button"
				className="h-9 shrink-0 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-surface-inset"
				onClick={() => {
					void navigator.clipboard.writeText(url);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				}}
			>
				{copied ? "Copied" : "Copy link"}
			</button>
		</div>
	);
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
			<div className="flex flex-wrap gap-x-3 gap-y-1">
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
							className={action}
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
							className={action}
							onClick={() => open("disable")}
						>
							Disable
						</button>
						{row.mfa_enrolled && (
							<button
								type="button"
								className={action}
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

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<h1 className="text-lg font-semibold text-text-primary">Staff</h1>
				<button
					type="button"
					className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-white"
					onClick={() => {
						setPanelOpen((v) => !v);
						invite.reset();
					}}
				>
					Invite staff
				</button>
			</div>

			{soleStaff && (
				<p
					role="status"
					className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text"
				>
					This is the only active staff account. If its authenticator
					app and recovery codes are lost, nobody can reset its
					two-factor sign-in. Invite a second staff member.
				</p>
			)}

			{panelOpen && (
				<div className="space-y-3 rounded-lg border border-border bg-surface p-4">
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
							className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-white disabled:opacity-50"
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
				</div>
			)}

			{rowError && <FormErrorBanner message={rowError} />}
			{staff.error && <FormErrorBanner message={platformError(staff.error)} />}

			{staff.isLoading ? (
				<div className="space-y-2">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="h-9 animate-pulse rounded bg-surface-inset"
						/>
					))}
				</div>
			) : (
				staff.data && (
					<>
						<table className="hidden w-full text-sm sm:table">
							<thead>
								<tr>
									{[
										"Name",
										"Email",
										"Status",
										"MFA",
										"Last sign-in",
										"",
									].map((h) => (
										<th
											key={h}
											className="pb-2 pr-3 text-left text-xs font-medium text-text-tertiary"
										>
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{staff.data.map((row) => (
									<tr
										key={row.id}
										className="border-t border-border-subtle"
									>
										<td className="py-2 pr-3 text-text-primary">
											{nameCell(
												row
											)}
										</td>
										<td className="py-2 pr-3 text-text-secondary">
											{row.email}
										</td>
										<td className="py-2 pr-3">
											<StatusChip
												row={
													row
												}
											/>
										</td>
										<td className="py-2 pr-3 text-text-secondary">
											{row.mfa_enrolled
												? "On"
												: "Not set up"}
										</td>
										<td className="py-2 pr-3 text-text-secondary tabular-nums">
											{lastSignIn(
												row
											)}
										</td>
										<td className="py-2">
											{actions(
												row
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<ul className="space-y-2 sm:hidden">
							{staff.data.map((row) => (
								<li
									key={row.id}
									className="space-y-1 rounded-lg border border-border bg-surface p-3"
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
					</>
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
