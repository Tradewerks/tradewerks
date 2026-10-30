import { useDeleteDispatcherMutation, useDispatcherByIdQuery, useReactivateDispatcherMutation } from "../../hooks/useDispatchers";
import EditDispatcher from "../../components/dispatchers/EditDispatcher";
import { useNavigate, useParams } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import { usePermission } from "../../hooks/usePermission";
import { useAuthStore } from "../../auth/authStore";
import { FALLBACK_TIMEZONE, errorMessage } from "../../util/util";
import { Mail, Phone, Clock, ShieldCheck, MoreVertical, Trash2, Edit, RotateCcw, KeyRound, FileText, FileCheck, Receipt, RefreshCw, FolderKanban, UserCheck } from "lucide-react";
import { requestPasswordResetCall } from "../../api/authenticate";
import { useResetMfaMutation } from "../../hooks/useMfa";
import { useToast } from "../../components/ui/useToast";
import ChangeHistory from "../../components/activity/ChangeHistory";
import Card from "../../components/ui/Card";
import AccessCard from "../../components/roles/AccessCard";

const DispatcherDetailPage = () => {
	const { dispatcherId } = useParams();
	const { data: dispatcher, isLoading } = useDispatcherByIdQuery(dispatcherId!);
	const { user } = useAuthStore();
	const tz = user?.orgTimezone ?? FALLBACK_TIMEZONE;
	const navigate = useNavigate();
	const [editOpen, setEditOpen] = useState(false);
	const deleteDispatcher = useDeleteDispatcherMutation();
	const reactivateDispatcher = useReactivateDispatcherMutation();
	const { mutateAsync: resetMFA, isPending: isResettingMFA } = useResetMfaMutation();
	const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [confirmResetMFA, setConfirmResetMFA] = useState(false);
	const [confirmResetPassword, setConfirmResetPassword] = useState(false);
	const [isResettingPassword, setIsResettingPassword] = useState(false);
	const optionsMenuRef = useRef<HTMLDivElement>(null);
	const toast = useToast();

	const EDIT_DISPATCHER = usePermission("manage_dispatchers");

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				optionsMenuRef.current &&
				!optionsMenuRef.current.contains(e.target as Node)
			) {
				setIsOptionsMenuOpen(false);
				setDeleteConfirm(false);
				setConfirmResetMFA(false);
				setConfirmResetPassword(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const handleDelete = async () => {
		if (!dispatcher) return;
		if (!EDIT_DISPATCHER) return;
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}
		try {
			navigate("/dispatch/admin?tab=users", { replace: true });
			await deleteDispatcher.mutateAsync(dispatcher!.id);
			toast.success(`${dispatcher.name} has been deleted`)
		} catch (error) {
			// we already left the page, so a console line would go unseen
			toast.error(error instanceof Error ? error.message : "Failed to delete dispatcher");
		}
	};

	const handleReactivate = async () => {
		if (!EDIT_DISPATCHER || !dispatcher) return;
		try {
			await reactivateDispatcher.mutateAsync(dispatcher.id);
			setIsOptionsMenuOpen(false);
			toast.success(`${dispatcher.name} reactivated.`);
		} catch (error) {
			toast.error(errorMessage(error, "Couldn't reactivate"));
		}
	};

	const handleResetPassword = async () => {
		if (!EDIT_DISPATCHER || !dispatcher) return;
		if (!confirmResetPassword) {
			setConfirmResetPassword(true);
			return;
		}
		setIsResettingPassword(true);
		try {
			await requestPasswordResetCall(dispatcher.id, dispatcher.role);
			setConfirmResetPassword(false);
			setIsOptionsMenuOpen(false);
			toast.success(`Password reset email sent to ${dispatcher.email}`);
		} catch (error) {
			setConfirmResetPassword(false);
			toast.error(error instanceof Error ? error.message : "Failed to send the reset email");
		} finally {
			setIsResettingPassword(false);
		}
	};

	const handleResetMFA = async () => {
		if (!EDIT_DISPATCHER || !dispatcher) return;
		if (!confirmResetMFA) {
			setConfirmResetMFA(true);
			return;
		}
		try {
			await resetMFA({ userId: dispatcher.id, role: dispatcher.role });
			setConfirmResetMFA(false);
			setIsOptionsMenuOpen(false);
			toast.success("MFA reset");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to reset MFA");
		}
	};

	const formatLastLogin = (iso: string | null) => {
		if (!iso) return "Never";
		return new Date(iso).toLocaleDateString("en-US", {
			month: "short", day: "numeric", year: "numeric",
			hour: "numeric", minute: "2-digit", timeZone: tz,
		});
	};

	const verifiedAt = dispatcher?.email_verified_at
		? new Date(dispatcher.email_verified_at).toLocaleDateString("en-US", {
				month: "short", day: "numeric", year: "numeric", timeZone: tz,
			})
		: null;

	const securityRows = [
		{
			icon: ShieldCheck,
			label: "Two-factor auth",
			value: dispatcher?.mfaEnabled ? "Enabled" : "Not set up",
			ok: !!dispatcher?.mfaEnabled,
			hint: dispatcher?.mfaEnabled
				? "Authenticator app"
				: "Account is password-only",
		},
		{
			icon: Mail,
			label: "Email address",
			value: verifiedAt ? "Verified" : "Unverified",
			ok: !!verifiedAt,
			hint: verifiedAt ?? "Never confirmed",
		},
	];

	const firstName = dispatcher?.name?.split(" ")[0] ?? "this dispatcher";
	const statCards = [
		{
			icon: FileText,
			label: "Requests",
			verb: "created",
			value: dispatcher?._count?.created_requests ?? 0,
			color: "text-primary-text",
		},
		{
			icon: FileCheck,
			label: "Quotes",
			verb: "created",
			value: dispatcher?._count?.created_quotes ?? 0,
			color: "text-text-primary",
		},
		{
			icon: Receipt,
			label: "Invoices",
			verb: "created",
			value: dispatcher?._count?.created_invoices ?? 0,
			color: "text-success-text",
		},
		{
			icon: RefreshCw,
			label: "Recurring plans",
			verb: "created",
			value: dispatcher?._count?.created_recurring_plans ?? 0,
			color: "text-warning-text",
		},
		{
			icon: FolderKanban,
			label: "Projects",
			verb: "managed",
			value: dispatcher?._count?.managed_projects ?? 0,
			color: "text-text-primary",
		},
	];

	if (isLoading) {
		return (
			<div className="flex justify-center py-10">
				<span className="text-sm text-text-muted">Loading...</span>
			</div>
		);
	}

	if (!dispatcher) {
		return <p className="text-sm text-text-muted">Dispatcher not found.</p>;
	}

	return (
		<>
			<div className="text-text-primary space-y-6">
				{/* Hero card */}
				<div className="flex items-start justify-between gap-4">
					<div className="flex items-center gap-4 min-w-0">
						<div className="relative flex-shrink-0">
							<div className="w-14 h-14 rounded-xl bg-avatar-bg flex items-center justify-center text-avatar-fg font-bold text-xl">
								{dispatcher.name.charAt(0).toUpperCase()}
							</div>
						</div>
						<div className="min-w-0">
							<h1 className="text-2xl sm:text-3xl font-bold text-text-primary truncate">
								{dispatcher.name}
							</h1>
							<p className="text-text-tertiary text-sm mt-0.5">
								{dispatcher.title}
							</p>
						</div>
					</div>
					<div className="flex items-center gap-2 flex-shrink-0">
						{dispatcher.role === "admin" && (
							<span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold border bg-primary-bg text-primary-text border-primary-border">
								<ShieldCheck size={11} />
								Admin
							</span>
						)}
						{dispatcher.mfaEnabled && (
							<span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold border bg-success-bg text-success-text border-success-border">
								<ShieldCheck size={11} />
								MFA
							</span>
						)}
						{dispatcher.organization_role && (
							<span className="px-3 py-1 rounded-full text-xs font-semibold border bg-surface text-text-secondary border-border-subtle">
								{dispatcher.organization_role.name}
							</span>
						)}
						<div className="relative" ref={optionsMenuRef}>
							<button
								onClick={() => {
									setIsOptionsMenuOpen((v) => !v);
									setDeleteConfirm(false);
								}}
								className="p-2 hover:bg-surface rounded-md transition-colors border border-border hover:border-border-strong"
							>
								<MoreVertical size={18} />
							</button>
							{isOptionsMenuOpen && (
								<div className="absolute right-0 mt-2 w-52 bg-base border border-border-subtle rounded-lg shadow-xl z-50">
									<div className="py-1">
											<button
												title={!EDIT_DISPATCHER ? "You don't have permission to perform this action" : undefined}
												disabled={!EDIT_DISPATCHER}
												onClick={() => {
													if (!EDIT_DISPATCHER) return;
													setEditOpen(
														true
													);
													setIsOptionsMenuOpen(
														false
													);
													setDeleteConfirm(
														false
													);
												}}
												className="w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
											>
												<Edit size={14} />
												Edit Dispatcher
											</button>
										<button
										title={!EDIT_DISPATCHER ? "You don't have permission to perform this action" : undefined}
										disabled={!EDIT_DISPATCHER || isResettingPassword}
										onClick={handleResetPassword}
										onMouseLeave={() => setConfirmResetPassword(false)}
										className="w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
									>
										<KeyRound size={14} />
										{isResettingPassword
											? "Sending..."
											: confirmResetPassword
												? "Click Again to Confirm"
												: "Reset Password"}
									</button>
									{dispatcher.mfaEnabled && (
											<button
												title={!EDIT_DISPATCHER ? "You don't have permission to perform this action" : undefined}
												disabled={!EDIT_DISPATCHER || isResettingMFA}
												onClick={handleResetMFA}
												onMouseLeave={() => setConfirmResetMFA(false)}
												className="w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
											>
												<RotateCcw size={14} />
												{isResettingMFA
													? "Resetting..."
													: confirmResetMFA
														? "Click Again to Confirm"
														: "Reset MFA"}
											</button>
										)}
										{EDIT_DISPATCHER && (
											<>
											<div className="my-1 border-t border-border-subtle" />
											{dispatcher.deactivated_at && (
												<button
													onClick={handleReactivate}
													disabled={reactivateDispatcher.isPending}
													className="w-full px-4 py-2 text-left text-sm hover:enabled:bg-surface transition-colors flex items-center gap-2 text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
												>
													<UserCheck size={14} />
													{reactivateDispatcher.isPending ? "Reactivating…" : "Reactivate"}
												</button>
											)}
											<button
												onClick={
													handleDelete
												}
												onMouseLeave={() =>
													setDeleteConfirm(
														false
													)
												}
												disabled={
													deleteDispatcher.isPending
												}
												className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
													deleteConfirm
														? "bg-error hover:bg-error-strong text-on-primary"
														: "text-error-text hover:bg-surface hover:text-error-text"
												} disabled:opacity-40 disabled:cursor-not-allowed`}
											>
												<Trash2 size={14} />
												{deleteDispatcher.isPending
													? "Deleting..."
													: deleteConfirm
														? "Click Again to Confirm"
														: "Delete Dispatcher"}
											</button>
											</>
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				</div>

				{dispatcher.deactivated_at && (
					<div role="status" className="rounded border border-border bg-surface-inset px-3 py-2 text-sm text-text-secondary">
						Inactive — this user can&apos;t sign in.
					</div>
				)}

				{/* Stat Row */}
				<div>
					
					<div className="grid grid-cols-2 md:grid-cols-5 gap-3">
						{statCards.map((s) => (
							<div
								key={s.label}
								title={`${s.value} ${s.label.toLowerCase()} ${s.verb} by ${firstName}`}
								className="bg-base border border-border-subtle rounded-lg p-4"
							>
								<div className="flex items-center gap-1.5 text-text-tertiary mb-1.5">
									<s.icon size={13} className="shrink-0" />
									<span className="text-[11px] font-medium truncate">{s.label}</span>
								</div>
								<p className={`text-2xl font-bold leading-none ${s.color}`}>{s.value}</p>
								<p className="text-[10px] text-text-muted uppercase tracking-wider mt-1">
									{s.verb}
								</p>
							</div>
						))}
					</div>
				</div>

				{/* Info + Change History */}
				{/* Stretched; Security absorbs the slack so the left stack ends
				    level with Change History. */}
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
					<div className="flex flex-col gap-6">
					<Card title="Information">
						<div className="space-y-4">
							{[
								{ icon: Mail, label: "Email", value: dispatcher.email },
								{ icon: Phone, label: "Phone", value: dispatcher.phone || "—" },
								{
									icon: Clock,
									label: "Last Login",
									value: formatLastLogin(dispatcher.last_login),
								},
							].map(({ icon: Icon, label, value }) => (
								<div key={label} className="flex items-center gap-3">
									<div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
										<Icon size={14} className="text-text-tertiary" />
									</div>
									<div className="min-w-0">
										<p className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">
											{label}
										</p>
										<p className="text-sm text-text-primary truncate">{value}</p>
									</div>
								</div>
							))}
							{dispatcher.description && (
								<div className="pt-3 border-t border-border-subtle">
									<p className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">
										Description
									</p>
									<p className="text-sm text-text-secondary leading-relaxed">
										{dispatcher.description}
									</p>
								</div>
							)}
						</div>
					</Card>

					<Card title="Security" className="flex-1">
						<div className="space-y-4">
							{securityRows.map(({ icon: Icon, label, value, ok, hint }) => (
								<div key={label} className="flex items-center gap-3">
									<div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
										<Icon size={14} className="text-text-tertiary" />
									</div>
									<div className="min-w-0 flex-1">
										<p className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">
											{label}
										</p>
										{hint && (
											<p className="text-xs text-text-muted truncate">{hint}</p>
										)}
									</div>
									<span
										className={`px-2.5 py-0.5 rounded-full border text-xs font-semibold whitespace-nowrap ${
											ok
												? "bg-success-bg text-success-text border-success-border"
												: "bg-warning-bg text-warning-text border-warning-border"
										}`}
									>
										{value}
									</span>
								</div>
							))}
						</div>
					</Card>
					</div>

					<ChangeHistory
						scope={{ kind: "actor", type: "dispatcher", id: dispatcherId ?? "" }}
					/>
				</div>

				{/* Access — full width; the permission pills wrap badly at half */}
				<AccessCard user={dispatcher} tier="dispatcher" />
			</div>

			{editOpen && (
				<EditDispatcher
					dispatcher={dispatcher}
					onClose={() => setEditOpen(false)}
					isOpen={editOpen}
				/>
			)}

		</>
	);
};

export default DispatcherDetailPage;
