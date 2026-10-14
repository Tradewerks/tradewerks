import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type SheetNoticeTone = "warning" | "info" | "neutral";

const TONE: Record<SheetNoticeTone, { box: string; accent: string }> = {
	warning: { box: "border-warning-border bg-warning-bg", accent: "text-warning-text" },
	info: { box: "border-info-border bg-info-bg", accent: "text-info-text" },
	neutral: { box: "border-border bg-surface", accent: "text-text-secondary" },
};

/**
 * Every message the purchase sheet shows above its form — a note from dispatch, a
 * pre-approval answer, a flag — in one shape. They were four shapes, and the
 * difference read as a difference in meaning that was never there. Tone carries
 * the meaning instead: amber only when the technician has something to act on.
 */
export default function SheetNotice({
	tone,
	icon: Icon,
	title,
	children,
}: {
	tone: SheetNoticeTone;
	icon: LucideIcon;
	title: string;
	children: ReactNode;
}) {
	const t = TONE[tone];
	return (
		<div className={`flex gap-2.5 rounded-lg border p-3 ${t.box}`}>
			<Icon
				aria-hidden
				size={14}
				className={`mt-0.5 flex-shrink-0 ${t.accent}`}
			/>
			<div className="min-w-0 flex-1">
				<p className={`text-xs font-semibold ${t.accent}`}>{title}</p>
				<div className="mt-0.5 text-xs leading-snug text-text-secondary">
					{children}
				</div>
			</div>
		</div>
	);
}
