import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BarChart3 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import DateRangeFilter from "../ui/DateRangeFilter";
import PageSummary from "./PageSummary";
import BreakdownPicker from "./BreakdownPicker";
import type { PageReportState } from "./usePageReport";

export default function PageReportButton({ report }: { report: PageReportState }) {
	const {
		canView,
		open,
		setOpen,
		label,
		options,
		groupBy,
		setGroupBy,
		range,
		setRange,
		query,
		presets,
	} = report;
	const navigate = useNavigate();
	const wrapperRef = useRef<HTMLDivElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	// The KPI line opens this too; Escape hands focus back to whichever opened it.
	const openerRef = useRef<HTMLElement | null>(null);
	// Right-anchored to a trigger that may not sit at the header's right edge, and
	// <main> clips overflow, so on narrow screens the popover would start outside
	// the content area. Fit it inside (via right/max-width, never a transform).
	const [place, setPlace] = useState<{ shift: number; maxWidth?: number }>({ shift: 0 });

	useLayoutEffect(() => {
		if (!open) {
			setPlace({ shift: 0 });
			return;
		}
		const wrapper = wrapperRef.current;
		if (!wrapper || !popoverRef.current) return;
		const area = wrapper.closest("main")?.getBoundingClientRect();
		const minLeft = (area?.left ?? 0) + 16;
		const maxWidth = (area?.right ?? window.innerWidth) - 16 - minLeft;
		const width = Math.min(popoverRef.current.getBoundingClientRect().width, maxWidth);
		const left = wrapper.getBoundingClientRect().right - width;
		setPlace({ shift: left < minLeft ? minLeft - left : 0, maxWidth });
	}, [open]);

	useEffect(() => {
		if (!open) return;
		openerRef.current = document.activeElement as HTMLElement | null;
		popoverRef.current?.focus();
		const onDown = (e: MouseEvent) => {
			const target = e.target as Element;
			if (wrapperRef.current?.contains(target)) return;
			// Controls that change which report this is (Jobs/Plans) keep it open.
			if (target.closest?.("[data-report-context]")) return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// An open menu inside (the date range) owns this Escape.
			if (popoverRef.current?.querySelector('[aria-expanded="true"]')) return;
			setOpen(false);
			const opener = openerRef.current;
			(opener?.isConnected && opener !== document.body ? opener : triggerRef.current)?.focus();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, setOpen]);

	if (!canView) return null;

	return (
		<div ref={wrapperRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen(!open)}
				aria-haspopup="dialog"
				aria-expanded={open}
				className="flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
			>
				<BarChart3 size={16} />
				Report
			</button>
			{/* No transform here or on ancestors: the custom-range calendar is position: fixed. */}
			{open && (
				<div
					ref={popoverRef}
					role="dialog"
					aria-label={label}
					tabIndex={-1}
					style={{ right: -place.shift, maxWidth: place.maxWidth }}
					className="absolute right-0 top-full z-50 mt-2 w-[min(40rem,calc(100vw-2rem))] rounded-lg border border-border-strong bg-canvas shadow-2xl shadow-black/50 outline-none"
				>
					<div className="flex flex-wrap items-center gap-2 px-3 py-2">
						<span className="flex-1 text-sm font-medium text-text-primary">{label}</span>
						{options.length > 1 && (
							<BreakdownPicker value={groupBy} options={options} onChange={setGroupBy} />
						)}
						{report.ranged && (
							<DateRangeFilter value={range} onChange={setRange} presets={presets} />
						)}
					</div>
					<div className="border-t border-border-subtle p-3">
						{query.error ? (
							<div className="py-6 text-center text-sm text-text-faint">
								Failed to load report.
							</div>
						) : query.isLoading || !query.data ? (
							<div className="min-h-40 animate-pulse rounded-md bg-surface-raised" />
						) : (
							<PageSummary
								data={query.data}
								chart={report.chart}
								onBarClick={
									report.canDrill
										? (l) => {
												const href = report.hrefFor(l);
												if (!href) return;
												setOpen(false);
												navigate(href);
											}
										: undefined
								}
							/>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
