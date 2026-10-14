import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { useToastStore, type ToastKind } from "../../stores/toastStore";

const TOAST_CONFIG: Record<
	ToastKind,
	{
		Icon: React.ComponentType<{ size?: number; className?: string }>;
		iconClass: string;
		borderClass: string;
	}
> = {
	success: {
		Icon: CheckCircle2,
		iconClass: "text-success-text",
		borderClass: "border-success-border",
	},
	error: {
		Icon: AlertCircle,
		iconClass: "text-error-text",
		borderClass: "border-error-border",
	},
	warning: {
		Icon: AlertTriangle,
		iconClass: "text-warning-text",
		borderClass: "border-warning-border",
	},
	info: {
		Icon: Info,
		iconClass: "text-primary",
		borderClass: "border-border",
	},
};

// Fixed-corner toast stack — the single shared notification surface for the
// whole app. Any fixed-position toast/banner (restock-shortfall alerts, the
// label-queue confirmation) goes through useToast()/toastStore instead of
// rolling its own, so there's one set of position/motion/a11y rules, not
// a separate one per surface.
//
// `inset="above-nav"` lifts the stack clear of a fixed bottom nav (TechnicianLayout's
// is h-16); without it a toast paints over the tab bar on phones. Below `sm` the stack
// spans left-4→right-4 — at 390px a right-anchored max-w-sm box would clip off-screen
// left. At `sm`+ (where dispatch always sits) both revert to the original geometry.
export default function ToastViewport({ inset = "default" }: { inset?: "default" | "above-nav" }) {
	const toasts = useToastStore((s) => s.toasts);
	const dismiss = useToastStore((s) => s.dismiss);

	if (toasts.length === 0) return null;

	return (
		<div
			role="status"
			aria-live="polite"
			className={`fixed z-50 flex flex-col gap-2 left-4 right-4 sm:left-auto sm:w-full sm:max-w-sm ${
				inset === "above-nav" ? "bottom-20" : "bottom-4"
			}`}
		>
			{toasts.map((toast) => {
				const { Icon, iconClass, borderClass } = TOAST_CONFIG[toast.kind];
				return (
					<div
						key={toast.id}
						className={`bg-surface border rounded-lg shadow-lg px-4 py-3 flex gap-3 transition duration-200 ease-out starting:opacity-0 starting:translate-y-2 motion-reduce:transition-none ${
							toast.leaving ? "opacity-0 translate-x-4 pointer-events-none" : ""
						} ${borderClass}`}
					>
						{toast.icon ?? (
							<Icon size={16} className={`${iconClass} flex-shrink-0 mt-0.5`} />
						)}
						<div className="flex-1 min-w-0 text-sm text-text-primary">
							{toast.message}
						</div>
						{toast.action && (
							<button
								onClick={() => {
									toast.action?.onClick();
									dismiss(toast.id);
								}}
								className="text-sm font-semibold text-primary hover:underline flex-shrink-0"
							>
								{toast.action.label}
							</button>
						)}
						<button
							onClick={() => dismiss(toast.id)}
							aria-label="Dismiss notification"
							className="text-text-faint hover:text-text-secondary flex-shrink-0"
						>
							<X size={14} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
