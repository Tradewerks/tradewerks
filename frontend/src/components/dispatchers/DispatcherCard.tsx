import { Phone, Mail, Briefcase, Clock, Trash2, ShieldCheck } from "lucide-react";
import type { Dispatcher } from "../../types/dispatchers";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { requestPasswordResetCall } from "../../api/authenticate"
import { usePermission } from "../../hooks/usePermission";
import {
  useDeleteDispatcherMutation,
  useDeactivateDispatcherMutation,
  useReactivateDispatcherMutation,
} from "../../hooks/useDispatchers";
import { useResetMfaMutation } from "../../hooks/useMfa";
import { useToast } from "../ui/useToast";
import { errorMessage } from "../../util/util";

interface DispatcherCardProps {
  dispatcher: Dispatcher;
  onClick?: () => void;
  onEdit?: (dispatcher: Dispatcher) => void;
  onAssignRole?: (dispatcher: Dispatcher) => void;
  viewMode?: "card" | "list";
}

function capitalizeWords(str: string) {
  return str
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatLastLogin(raw: unknown) {
  if (!raw) return "Never";

  let d: Date;

  if (raw instanceof Date) {
    d = raw;
  } else if (typeof raw === "string") {
    d = new Date(raw);
  } else {
    d = new Date(String(raw));
  }

  if (isNaN(d.getTime())) {
    return "Never";
  }

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 5) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function DispatcherCard({ dispatcher, onClick, onEdit, onAssignRole, viewMode }: DispatcherCardProps) {
    const displayName = capitalizeWords(dispatcher.name);
    const lastLoginText = formatLastLogin(dispatcher.last_login);
    const mfaBadge = dispatcher.mfaEnabled ? (
        <span
            title="Two-factor authentication enabled"
            className="inline-flex items-center gap-1 rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-xs font-medium text-success-text"
        >
            <ShieldCheck size={12} /> MFA
        </span>
    ) : null;
    const inactiveBadge = dispatcher.deactivated_at ? (
        <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-text-tertiary">
            Inactive
        </span>
    ) : null;
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [confirmResetMFA, setConfirmResetMFA] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [confirmResetPassword, setConfirmResetPassword] = useState(false);
    const [isResettingPassword, setIsResettingPassword] = useState(false);
    const { mutateAsync: deleteDispatcher, isPending: isDeleting } = useDeleteDispatcherMutation();
    const { mutateAsync: resetMFA, isPending: isResetingMFA } = useResetMfaMutation();
    const [deactivateConfirm, setDeactivateConfirm] = useState(false);
    const { mutateAsync: deactivateDispatcher, isPending: isDeactivating } = useDeactivateDispatcherMutation();
    const { mutateAsync: reactivateDispatcher, isPending: isReactivating } = useReactivateDispatcherMutation();
    const toast = useToast();

    //permissions
    const MANAGE_DISPATCHER = usePermission("manage_dispatchers");
    const VIEW_DISPATCHER = usePermission("view_dispatchers");

    const handleDelete = async () => {
		if (!MANAGE_DISPATCHER) return;
		if (!dispatcher) return;
		if (!deleteConfirm) {
			setDeleteConfirm(true);
			return;
		}
		try {
			await deleteDispatcher(dispatcher.id);
			setDeleteConfirm(false);
		} catch (error) {
			console.error("Failed to delete dispatcher:", error);
		}
	};

    const handleDeactivate = async () => {
        if (!MANAGE_DISPATCHER) return;
        if (!deactivateConfirm) {
            setDeactivateConfirm(true);
            return;
        }
        try {
            await deactivateDispatcher(dispatcher.id);
            setDeactivateConfirm(false);
            setDropdownOpen(false);
            toast.success(`${displayName} deactivated. Signed out within 30 seconds; history is kept.`);
        } catch (error) {
            setDeactivateConfirm(false);
            toast.error(errorMessage(error, "Couldn't deactivate"));
        }
    };

    const handleReactivate = async () => {
        if (!MANAGE_DISPATCHER) return;
        try {
            await reactivateDispatcher(dispatcher.id);
            setDropdownOpen(false);
            toast.success(`${displayName} reactivated.`);
        } catch (error) {
            toast.error(errorMessage(error, "Couldn't reactivate"));
        }
    };

    const handleResetPassword = async () => {
		if (!MANAGE_DISPATCHER || !dispatcher) return;
		if (!confirmResetPassword) {
			setConfirmResetPassword(true);
			return;
		}
		setIsResettingPassword(true);
		try {
			await requestPasswordResetCall(dispatcher.id, dispatcher.role);
			setConfirmResetPassword(false);
			setDropdownOpen(false);
			toast.success(`Password reset email sent to ${dispatcher.email}`);
		} catch (error) {
			setConfirmResetPassword(false);
			toast.error(error instanceof Error ? error.message : "Failed to send the reset email");
		} finally {
			setIsResettingPassword(false);
		}
	};

    const handleResetMFA = async (dispatcher: Dispatcher) => {
        if (!MANAGE_DISPATCHER) return;
		if (!dispatcher) return;
        if (!confirmResetMFA) {
            setConfirmResetMFA(true);
            return;
        }
        try {
            await resetMFA({userId: dispatcher.id, role: dispatcher.role});
            setConfirmResetMFA(false);
            setDropdownOpen(false);
        }catch (error) {
			console.error("Failed to reset MFA:", error);
			setConfirmResetMFA(false);
			alert(
				error instanceof Error
					? "Failed to reset MFA: " + error.message
					: "Failed to reset MFA."
			);
		}
    }

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // avoid repeating same code for both views
    const OPTIONS = (
                    <div className="absolute right-0 top-full mt-1 w-44 bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden">
                        {viewMode === "list" &&
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDropdownOpen(false);
                                    onClick?.();
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-surface-raised transition-colors"
                            >
                                View Details
                            </button>
                        } 
                        <button
                            title={!MANAGE_DISPATCHER ? "You don't have permission to perform this action" : undefined}
                            disabled={!MANAGE_DISPATCHER || isResettingPassword}
                            onClick={(e) => {
                                e.stopPropagation();
                                handleResetPassword();
                            }}
                            onMouseLeave={() => setConfirmResetPassword(false)}
                            className="w-full px-4 py-2 text-left text-sm text-text-primary hover:enabled:bg-surface-raised transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {isResettingPassword
                                ? "Sending..."
                                : confirmResetPassword
                                    ? "Click to Confirm"
                                    : "Reset Password"}
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setDropdownOpen(false);
                                onEdit?.(dispatcher);
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-surface-raised transition-colors"
                        >
                            Update User
                        </button>
                        {dispatcher.mfaEnabled && (
                            <button
                            onClick={(e) => {
                                e.stopPropagation();
                                handleResetMFA(dispatcher)
                            }}
                            onMouseLeave={()=> setConfirmResetMFA(false)}
                            disabled={isResetingMFA}
                            className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
                                confirmResetMFA
                                    ? "bg-error hover:bg-error-strong text-on-primary"
                                    : "text-text-primary hover:bg-surface-raised hover:text-error-text"
                                } disabled:opacity-40 disabled:cursor-not-allowed`}
                            >
                                {isResetingMFA
                                    ? "Reseting MFA..."
                                    : confirmResetMFA
                                        ? "Click Again to Confirm"
                                        : "Reset MFA"}
                            </button>
                        )}
                        {MANAGE_DISPATCHER && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (dispatcher.deactivated_at) handleReactivate();
                                    else handleDeactivate();
                                }}
                                onMouseLeave={() => setDeactivateConfirm(false)}
                                disabled={isDeactivating || isReactivating}
                                className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
                                    deactivateConfirm
                                        ? "bg-error hover:bg-error-strong text-on-primary"
                                        : "text-text-primary hover:bg-surface-raised"
                                } disabled:opacity-40 disabled:cursor-not-allowed`}
                            >
                                {dispatcher.deactivated_at
                                    ? isReactivating
                                        ? "Reactivating…"
                                        : "Reactivate"
                                    : isDeactivating
                                        ? "Deactivating…"
                                        : deactivateConfirm
                                            ? "Press again: signs out"
                                            : "Deactivate"}
                            </button>
                        )}
                        {/* Admins have all permissions */}
                        {dispatcher.role !== "admin"  && (
                            <>
                                <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDropdownOpen(false);
                                    onAssignRole?.(dispatcher);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-surface-raised transition-colors"
                                >
                                    Assign Role
                                </button>  
                                <div className="my-1 border-t border-border-subtle" />
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
                                    isDeleting
                                    }
                                    className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
                                    deleteConfirm
                                        ? "bg-error hover:bg-error-strong text-on-primary"
                                        : "text-error-text hover:bg-surface-raised hover:text-error-text"
                                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                                >
                                    <Trash2
                                    size={
                                        16
                                    }
                                    />
                                    {isDeleting
                                    ? "Deleting..."
                                    : deleteConfirm
                                        ? "Click Again to Confirm"
                                        : "Delete Dispatcher"}
                                </button>
                            </>
                        )}
                        
                    </div>
                );

    if (viewMode === "list") {
        return (
            <div 
                onClick={VIEW_DISPATCHER ? onClick : undefined} 
                className="w-full bg-base rounded-lg border border-border shadow-sm px-5 py-3 flex items-center gap-4 cursor-pointer hover:shadow-md transition"
            >
                {/* Avatar */}
                <div className="w-10 h-10 flex-shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-lg">
                    {dispatcher.name.charAt(0).toUpperCase()}
                </div>

                {/* Name */}
                <div className="flex-1 min-w-0">
                    <h3 className="text-text-primary font-semibold text-lg truncate">{displayName}</h3>
                </div>

                {/* Role */}
                <div className="w-36 flex-shrink-0 flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border w-fit">
                            {dispatcher.role.charAt(0).toUpperCase() + dispatcher.role.slice(1)}
                        </span>
                        {mfaBadge}
                        {inactiveBadge}
                    </div>
                    {dispatcher.organization_role && (
                        <span className="text-xs text-text-tertiary truncate">{dispatcher.organization_role.name}</span>
                    )}
                </div>

                {/* Email */}
                <div className="flex-1 min-w-0 hidden sm:flex items-center gap-2 text-sm text-text-secondary">
                    <Mail size={16} className="text-text-tertiary flex-shrink-0" />
                    <span className="truncate">{dispatcher.email}</span>
                </div>

                {/* Title */}
                <div className="flex-1 min-w-0 hidden md:flex items-center gap-2 text-sm text-text-secondary">
                    <Briefcase size={16} className="text-text-tertiary flex-shrink-0" />
                    <span className="truncate">{dispatcher.title}</span>
                </div>

                {/* Last Login */}
                <div className="flex-1 min-w-0 hidden lg:flex items-center gap-2 text-sm text-text-secondary">
                    <Clock size={13} className="opacity-70 flex-shrink-0" />
                    <span className="truncate">Last login: {lastLoginText}</span>
                </div>

                {/* Actions */}
                {MANAGE_DISPATCHER && (
                    <div className="flex-shrink-0 relative" ref={dropdownRef}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setDropdownOpen((prev) => !prev);
                        }}
                        className="flex items-center gap-2 p-2 bg-surface hover:bg-surface-raised text-text-secondary rounded-md transition-colors border border-border"
                    >
                        <MoreHorizontal size={18} />
                        <span className="text-sm font-medium">Options</span>
                    </button>
                    
                    {dropdownOpen && OPTIONS}
                    </div>
                )}
            </div>
        );
    }
    return (
        <div
            className="
            bg-base border border-border rounded-lg p-5
            hover:border-border-strong hover:shadow-lg transition-all
            w-full max-w-[360px] flex flex-col gap-4" 
        >
            <div className="flex items-start gap-3">
                <div className="relative">
                <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold text-lg">
                    {dispatcher.name.charAt(0).toUpperCase()}
                </div>
                
                </div>

                <div className="flex-1 min-w-0">
                    <h3 className="text-text-primary font-semibold text-lg truncate">{displayName}</h3>
                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border">
                            {dispatcher.role.charAt(0).toUpperCase() + dispatcher.role.slice(1)}
                        </span>
                        {mfaBadge}
                        {inactiveBadge}
                        {dispatcher.organization_role && (
                            <span className="text-xs text-text-tertiary">{dispatcher.organization_role.name}</span>
                        )}
                    </div>
                </div>
            </div>

            <div className="space-y-2.5">
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Phone size={16} className="text-text-tertiary flex-shrink-0" />
                <span className="truncate">{dispatcher.phone}</span>
                </div>

                <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Mail size={16} className="text-text-tertiary flex-shrink-0" />
                <span className="truncate">{dispatcher.email}</span>
                </div>

                <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Briefcase size={16} className="text-text-tertiary flex-shrink-0" />
                <span className="truncate">{dispatcher.title}</span>
                </div>
                
                <div className="flex items-start gap-2 text-sm text-text-tertiary min-h-[1.2rem]">
                <div className="w-4 flex-shrink-0" /> 
                <p className="line-clamp-2 text-xs leading-relaxed">
                    {dispatcher.description}
                </p>
                </div>
            </div>

            <div className="flex items-center gap-2 text-xs text-text-tertiary pt-2 border-t border-border-subtle mt-auto">
                <Clock size={13} className="opacity-70" />
                <span>Last login: {lastLoginText}</span>
            </div>

            <div className="flex gap-2 mt-1">
                {VIEW_DISPATCHER && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onClick?.();
                        }}
                        className="flex-1 px-4 py-2 bg-surface hover:bg-surface-raised text-text-secondary text-sm font-medium rounded-md transition-colors border border-border"
                    >
                        View Details
                    </button>
                )}
                {MANAGE_DISPATCHER && (
                    <div className="relative flex" ref={dropdownRef}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setDropdownOpen((prev) => !prev);
                            }}
                            className="flex items-center justify-center h-full px-3 py-2 bg-surface hover:bg-surface-raised text-text-secondary rounded-md transition-colors border border-border"
                        >
                            <MoreHorizontal size={18} />
                        </button>

                        {dropdownOpen && OPTIONS}
                    </div>
                )}
            </div>
        </div>
    );
}