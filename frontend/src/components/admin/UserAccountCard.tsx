import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { Clock, Mail, Phone, ShieldCheck } from "lucide-react";
import { Avatar, MfaMark } from "../technicians/TechnicianBits";
import { capitalizeWords, formatLastLogin } from "../technicians/technicianFormat";
import UserTypeChip from "./UserTypeChip";
import { USER_KIND_LABELS, type UserKind } from "./userKind";
import { USER_COL_VISIBILITY, USER_ROW_COLS } from "./userRowLayout";

interface UserAccountCardProps {
	viewMode: "list" | "card";
	kind: UserKind;
	name: string;
	title?: string | null;
	roleName?: string | null;
	phone?: string | null;
	email?: string | null;
	mfaEnabled?: boolean;
	lastLogin: unknown;
	inactive: boolean;
	onOpen?: () => void;
	actions?: ReactNode;
}

function stop(e: MouseEvent) {
	e.stopPropagation();
}

const ICON_LINK =
	"flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
const TEXT_LINK =
	"flex w-fit max-w-full items-center gap-2 text-text-secondary hover:text-text-primary";
const DASH = <span className="text-sm text-text-muted">—</span>;

export function UserListHeader() {
	// Matches the Technicians roster header, including its sticky offset.
	return (
		<div className="sticky -top-6 z-10 hidden rounded-t-lg border-b border-border bg-surface md:block">
			<div
				className={`grid ${USER_ROW_COLS} px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary`}
			>
				<span>User</span>
				<span className={USER_COL_VISIBILITY.type}>Type</span>
				<span className={USER_COL_VISIBILITY.role}>Role</span>
				<span className={USER_COL_VISIBILITY.mfa}>MFA</span>
				<span className={USER_COL_VISIBILITY.contact}>Contact</span>
				<span className={USER_COL_VISIBILITY.lastLogin}>Last login</span>
				<span aria-hidden />
			</div>
		</div>
	);
}

export default function UserAccountCard({
	viewMode,
	kind,
	name,
	title,
	roleName,
	phone,
	email,
	mfaEnabled,
	lastLogin,
	inactive,
	onOpen,
	actions,
}: UserAccountCardProps) {
	const displayName = capitalizeWords(name);
	const lastLoginText = formatLastLogin(lastLogin);
	const nameTone = inactive ? "text-text-secondary" : "text-text-primary";
	const inactiveBadge = inactive && (
		<span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-text-tertiary">
			Inactive
		</span>
	);

	// Only the row/card itself — Enter on a nested link or button already acts on its own.
	const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (!onOpen || e.target !== e.currentTarget) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onOpen();
		}
	};

	const interactive = onOpen
		? {
				role: "button" as const,
				tabIndex: 0,
				"aria-label": `Open ${displayName}`,
				onClick: onOpen,
				onKeyDown: handleKeyDown,
			}
		: {};

	if (viewMode === "list") {
		return (
			<div
				{...interactive}
				className={`grid ${USER_ROW_COLS} border-b border-border-subtle px-4 py-2.5 last:rounded-b-lg last:border-b-0 ${
					onOpen
						? "cursor-pointer transition-colors duration-100 hover:bg-surface focus-visible:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
						: ""
				}`}
			>
				<div className="flex min-w-0 items-center gap-3">
					<Avatar technician={{ name }} size="md" showStatus={false} />
					<div className="min-w-0">
						<div className="flex min-w-0 items-center gap-2">
							<p className={`truncate text-sm font-medium ${nameTone}`} title={displayName}>
								{displayName}
							</p>
							{inactiveBadge}
						</div>
						{/* Below sm the type column is hidden, so the type word rides this line. */}
						<p
							className={`truncate text-xs text-text-tertiary ${title ? "" : "sm:hidden"}`}
							title={title ?? undefined}
						>
							<span className="sm:hidden">
								{USER_KIND_LABELS[kind]}
								{title && " · "}
							</span>
							{title}
						</p>
					</div>
				</div>

				<div className={USER_COL_VISIBILITY.type}>
					<UserTypeChip kind={kind} />
				</div>

				<div
					className={`min-w-0 truncate text-sm ${USER_COL_VISIBILITY.role} ${
						roleName ? "text-text-secondary" : "text-text-muted"
					}`}
					title={roleName ?? undefined}
				>
					{roleName || "—"}
				</div>

				<div className={`items-center ${USER_COL_VISIBILITY.mfa}`}>
					{mfaEnabled ? <MfaMark enabled /> : DASH}
				</div>

				<div className={`items-center gap-0.5 ${USER_COL_VISIBILITY.contact}`}>
					{phone && (
						<a
							href={`tel:${phone}`}
							onClick={stop}
							aria-label={`Call ${displayName}`}
							title={phone}
							className={ICON_LINK}
						>
							<Phone size={15} />
						</a>
					)}
					{email && (
						<a
							href={`mailto:${email}`}
							onClick={stop}
							aria-label={`Email ${displayName}`}
							title={email}
							className={ICON_LINK}
						>
							<Mail size={15} />
						</a>
					)}
					{!phone && !email && DASH}
				</div>

				<div className={`truncate text-xs text-text-tertiary ${USER_COL_VISIBILITY.lastLogin}`}>
					{lastLoginText}
				</div>

				<div className="flex items-center justify-end">{actions}</div>
			</div>
		);
	}

	return (
		<div
			{...interactive}
			className={`flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-base p-4 ${
				onOpen
					? "cursor-pointer transition-colors duration-100 hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					: ""
			}`}
		>
			<div className="flex items-center gap-3">
				<Avatar technician={{ name }} size="lg" showStatus={false} />
				<div className="min-w-0 flex-1">
					<p className={`truncate text-sm font-semibold ${nameTone}`} title={displayName}>
						{displayName}
					</p>
					{title && (
						<p className="truncate text-xs text-text-tertiary" title={title}>
							{title}
						</p>
					)}
				</div>
			</div>

			{/* Full-width row under the avatar: type and role read as one "what access" fact,
			    and the name keeps the whole header width. */}
			<div className="flex min-w-0 items-center gap-2 text-xs">
				<UserTypeChip kind={kind} />
				{roleName && (
					<>
						<span aria-hidden className="text-text-faint">
							·
						</span>
						<span className="min-w-0 truncate text-text-secondary" title={roleName}>
							{roleName}
						</span>
					</>
				)}
				{inactive && <span className="ml-auto shrink-0">{inactiveBadge}</span>}
			</div>

			{phone || email ? (
				<div className="flex min-w-0 flex-col gap-1 text-xs">
					{phone && (
						<a href={`tel:${phone}`} onClick={stop} className={TEXT_LINK}>
							<Phone size={13} aria-hidden className="shrink-0 text-text-tertiary" />
							<span className="truncate">{phone}</span>
						</a>
					)}
					{email && (
						<a href={`mailto:${email}`} onClick={stop} className={TEXT_LINK}>
							<Mail size={13} aria-hidden className="shrink-0 text-text-tertiary" />
							<span className="truncate" title={email}>
								{email}
							</span>
						</a>
					)}
				</div>
			) : (
				<p className="text-xs text-text-muted">No contact details</p>
			)}

			<div className="mt-auto flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
				<span
					title="Last login"
					className="flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary"
				>
					<Clock size={12} aria-hidden className="shrink-0" />
					<span className="sr-only">Last login:</span>
					<span className="truncate">{lastLoginText}</span>
				</span>
				<div className="flex shrink-0 items-center gap-3">
					{mfaEnabled && (
						<span className="flex items-center gap-1 text-xs text-success-text">
							<ShieldCheck size={13} aria-hidden /> MFA
						</span>
					)}
					{actions}
				</div>
			</div>
		</div>
	);
}
