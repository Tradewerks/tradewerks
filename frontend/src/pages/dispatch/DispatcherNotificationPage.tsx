import { useMemo, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import {
	Bell, Clock, CheckCheck, Wrench, MailOpen, Settings, ShoppingCart, Receipt, PenLine, KeyRound,
	AlarmClock, Timer, PackageX, Truck, ShieldAlert, MessageSquare, DollarSign, ThumbsUp, ThumbsDown, Gauge, CreditCard,
} from "lucide-react";
import { useAuthStore } from "../../auth/authStore";
import { useDispatcherNotificationsQuery, useMarkDispatcherNotificationReadMutation, useMarkAllDispatcherNotificationsReadMutation } from "../../hooks/useNotifications";
import type { DispatcherNotification, DispatcherNotificationType } from "../../types/notifications";

function formatRelativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return "Yesterday";
    return `${days}d ago`;
}

function getDateGroup(dateStr: string): string {
    const d = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// The explicit return type makes tsc reject a notification type with no icon.
function NotificationIcon({ type }: { type: DispatcherNotificationType }): ReactElement {
    const cls = "shrink-0 mt-0.5";
    switch (type) {
        case "vehicle_maintenance_due":  return <Wrench size={18} className={`${cls} text-primary-text`} />;
        case "job_finished":   return <Clock size={18} className={`${cls} text-warning-text`} />;
        case "followup_email_opened": return <MailOpen size={18} className={`${cls} text-error-text`} />;
        case "field_purchase_preauth_requested": return <ShoppingCart size={18} className={`${cls} text-warning-text`} />;
        case "field_purchase_submitted": return <Receipt size={18} className={`${cls} text-primary-text`} />;
        case "field_purchase_second_signoff": return <PenLine size={18} className={`${cls} text-warning-text`} />;
        case "field_purchase_grant_requested": return <KeyRound size={18} className={`${cls} text-primary-text`} />;
        case "visit_delayed": return <AlarmClock size={18} className={`${cls} text-warning-text`} />;
        case "tech_running_late": return <Timer size={18} className={`${cls} text-warning-text`} />;
        case "restock_shortfall": return <PackageX size={18} className={`${cls} text-error-text`} />;
        case "vehicle_restock_requested": return <Truck size={18} className={`${cls} text-primary-text`} />;
        case "dispute_opened": return <ShieldAlert size={18} className={`${cls} text-error-text`} />;
        case "tech_note_added": return <MessageSquare size={18} className={`${cls} text-primary-text`} />;
        case "invoice_paid": return <DollarSign size={18} className={`${cls} text-success-text`} />;
        case "quote_accepted": return <ThumbsUp size={18} className={`${cls} text-success-text`} />;
        case "quote_declined": return <ThumbsDown size={18} className={`${cls} text-error-text`} />;
        case "usage_limit_warning": return <Gauge size={18} className={`${cls} text-warning-text`} />;
        case "subscription_changed": return <CreditCard size={18} className={`${cls} text-text-secondary`} />;
        case "upgrade_request_resolved": return <CreditCard size={18} className={`${cls} text-primary-text`} />;
    }
}

function NotificationItem({
    notif,
    onMarkRead,
}: {
    notif: DispatcherNotification;
    onMarkRead: (id: string) => void;
}) {
    const navigate = useNavigate();
    const isUnread = !notif.read_at;

    const handleClick = () => {
        if (isUnread) onMarkRead(notif.id);
        if (notif.action_url) navigate(notif.action_url);
    };

    return (
        <button
            onClick={handleClick}
            className={`w-full text-left flex gap-3 px-4 py-3 border-b border-border-subtle hover:cursor-pointer hover:bg-surface-raised bg-surface transition-colors ${
                isUnread ? "border-l-2 border-l-primary" : ""
            }`}
        >
            <NotificationIcon type={notif.type} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    {isUnread && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                    <p className={`text-sm leading-snug truncate ${isUnread ? "font-semibold text-text-primary" : "text-text-secondary"}`}>
                        {notif.title}
                    </p>
                </div>
                <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{notif.body}</p>
            </div>
            <span className="text-[11px] text-text-faint whitespace-nowrap shrink-0 mt-0.5">
                {formatRelativeTime(notif.created_at)}
            </span>
        </button>
    );
}

export default function DispatcherNotificationsPage() {
    const navigate = useNavigate();
    const { user } = useAuthStore();
    const { data: notifications = [], isLoading } = useDispatcherNotificationsQuery(user?.userId);
    const markRead = useMarkDispatcherNotificationReadMutation();
    const markAllRead = useMarkAllDispatcherNotificationsReadMutation();

    const unreadCount = notifications.filter((n) => !n.read_at).length;
    const hasUnread = unreadCount > 0;

    const handleMarkRead = (notifId: string) => {
        if (!user?.userId) return;
        markRead.mutate({ dispatcherId: user.userId, notifId });
    };

    const handleMarkAllRead = () => {
        if (!user?.userId) return;
        markAllRead.mutate({ dispatcherId: user.userId });
    };

    // Group by date — ordered chronologically (Today first, then descending by date)
    const { groups, groupOrder } = useMemo(() => {
        const groups: Record<string, DispatcherNotification[]> = {};
        for (const n of notifications) {
            const g = getDateGroup(n.created_at);
            (groups[g] ??= []).push(n);
        }
        const groupOrder = ["Today", "Yesterday", ...Object.keys(groups).filter((g) => g !== "Today" && g !== "Yesterday")];
        return { groups, groupOrder };
    }, [notifications]);

    return (
        <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <h1 className="text-lg font-semibold text-text-primary">Notifications</h1>
                    {unreadCount > 0 && (
                        <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-primary/20 text-primary-text border border-primary/30 min-w-[20px]">
                            {unreadCount}
                        </span>
                    )}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={handleMarkAllRead}
                        disabled={!hasUnread || markAllRead.isPending}
                        className="flex items-center gap-1.5 text-xs text-primary-text hover:text-primary-text disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <CheckCheck size={14} />
                        Mark all read
                    </button>
                    <button
                        onClick={() => navigate("/dispatch/profile", { state: { tab: "preferences" } })}
                        className="hover:cursor-pointer rounded-md hover:bg-surface-raised p-2"
                        aria-label="Notification settings"
                        title="Notification settings"
                    >
                       <Settings size={14} />
                    </button>
                </div>
                    
            </div>

            {isLoading && (
                <div className="flex justify-center py-12">
                    <div
                        role="status"
                        aria-label="Loading notifications"
                        className="w-6 h-6 rounded-full border-2 border-border border-t-primary animate-spin"
                    />
                </div>
            )}

            {!isLoading && notifications.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-16 text-text-faint">
                    <Bell size={36} strokeWidth={1.5} />
                    <p className="text-sm">No notifications yet</p>
                </div>
            )}

            {!isLoading && notifications.length > 0 && (
                <div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
                    {groupOrder.map((group) => {
                        const items = groups[group];
                        if (!items?.length) return null;
                        return (
                            <div key={group}>
                                <div className="px-4 py-2 border-b border-border-subtle text-[11px] font-medium text-text-muted uppercase tracking-wide">
                                    {group}
                                </div>
                                {items.map((notif) => (
                                    <NotificationItem
                                        key={notif.id}
                                        notif={notif}
                                        onMarkRead={handleMarkRead}
                                    />
                                ))}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
