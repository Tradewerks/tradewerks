import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, ChevronDown } from "lucide-react";
import type { DocumentLineage as Lineage, LineageNode } from "../../types/lineage";
import type { LifecycleKind } from "../lifecycle/types";

interface DocumentLineageProps {
	kind: LifecycleKind;
	lineage?: Lineage | null;
}

const routeFor = (kind: LifecycleKind, id: string) =>
	kind === "quote" ? `/dispatch/quotes/${id}` : `/dispatch/invoices/${id}`;

/**
 * The header pill's geometry, shared with the status pill and exported so the
 * Overdue and QuickBooks badges opposite hold the same line.
 */
export const HEADER_PILL =
	"inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium transition-colors duration-150 ease-out";

/** A chain row: version, number, status — three columns so the numbers stack. */
function ChainRow({
	kind,
	node,
	isSelf,
}: {
	kind: LifecycleKind;
	node: LineageNode;
	isSelf: boolean;
}) {
	const cells = (
		<>
			<span className="tabular-nums text-text-muted">v{node.version}</span>
			<span className={isSelf ? "text-text-primary" : "text-primary-text"}>
				{node.number}
			</span>
			<span className="justify-self-end text-xs text-text-muted">
				{isSelf ? "This version" : node.status}
			</span>
		</>
	);

	const grid = "grid grid-cols-[2rem_1fr_auto] items-center gap-2 rounded-md px-2 py-1.5";

	// The viewed row is a marker, not a target: a link to the page you are on.
	return isSelf ? (
		<div aria-current="true" className={`${grid} bg-surface font-medium`}>
			{cells}
		</div>
	) : (
		<Link
			to={routeFor(kind, node.id)}
			className={`${grid} transition-colors duration-150 ease-out hover:bg-surface`}
		>
			{cells}
		</Link>
	);
}

/** A linked document number, for the adjustment rows that have no version axis. */
function NodeLink({ kind, node }: { kind: LifecycleKind; node: LineageNode }) {
	return (
		<Link
			to={routeFor(kind, node.id)}
			className="rounded-md px-1.5 py-0.5 font-medium text-primary-text transition-colors duration-150 ease-out hover:bg-surface"
		>
			{node.number}
		</Link>
	);
}

/**
 * Where this document sits in its revision chain, and one click to the document
 * that counts.
 *
 * Rendered into DetailHeader's `badges` slot rather than a band of its own:
 * version is a property of the document number, so it sits beside the number
 * and costs no vertical space. Two pills whatever the depth — only the chain
 * list inside the panel grows.
 *
 * It never prints the viewed document's status; every status here belongs to
 * another document and sits beside that document's number.
 */
export default function DocumentLineage({ kind, lineage }: DocumentLineageProps) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const close = useCallback((restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) close(false);
		};
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [open, close]);

	if (!lineage) return null;

	const { chain, truncated_before, final, final_is_live, adjusts, adjustments } = lineage;

	const hasChain = chain.length > 1 || truncated_before;
	const hasAdjustments = adjusts != null || adjustments.length > 0;
	// The common case — a first version nobody has revised — costs no pixels.
	if (!hasChain && !hasAdjustments) return null;

	const isTail = final.id === lineage.self_id;
	const adjustmentCount = adjustments.length + (adjusts ? 1 : 0);
	const triggerLabel = hasChain
		? `Version ${lineage.self_version} of ${lineage.latest_version}`
		: adjusts && adjustments.length === 0
			? `Adjusts ${adjusts.number}`
			: `${adjustmentCount} adjustment${adjustmentCount === 1 ? "" : "s"}`;
	const superseded = hasChain && !isTail;

	return (
		<>
			<div className="relative" ref={wrapRef}>
				<button
					ref={triggerRef}
					type="button"
					aria-expanded={open}
					aria-controls={open ? panelId : undefined}
					onClick={() => (open ? close(false) : setOpen(true))}
					className={`${HEADER_PILL} cursor-pointer ${
						superseded
							? "border-warning/30 bg-warning/20 text-warning-text hover:border-warning/60"
							: "border-border bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary"
					}`}
				>
					{superseded && <AlertTriangle size={13} />}
					{triggerLabel}
					{/* Rotation, not a swapped glyph: the chevron is answering
					    the click, so it travels the way the panel does. */}
					<ChevronDown
						size={13}
						className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${
							open ? "rotate-180" : ""
						}`}
					/>
				</button>

				{open && (
					<div
						id={panelId}
						/* role, because an aria-label on a generic div isn't
						   reliably exposed: the panel would reach a screen
						   reader as an unnamed run of links. */
						role="group"
						aria-label="Version history"
						className="absolute left-0 z-50 mt-2 w-72 rounded-lg border border-border-subtle bg-base p-1.5 text-sm shadow-xl"
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								close(true);
							}
						}}
					>
						{truncated_before && (
							<p className="px-2 py-1.5 text-xs text-text-muted">
								Earlier versions were deleted.
							</p>
						)}

						{hasChain && (
							/* Every version, newest first — the rows either
							   side of this one are its "replaces" and
							   "replaced by". */
							<ol>
								{[...chain].reverse().map((n) => (
									<li key={n.id}>
										<ChainRow
											kind={kind}
											node={n}
											isSelf={
												n.id ===
												lineage.self_id
											}
										/>
									</li>
								))}
							</ol>
						)}

						{superseded && !final_is_live && (
							<p className="px-2 py-1.5 text-xs text-text-muted">
								No active version in this chain.
							</p>
						)}

						{hasAdjustments && (
							<div
								className={`flex flex-col gap-1 px-2 py-1.5 text-xs ${
									hasChain
										? "mt-1 border-t border-border-subtle pt-2"
										: ""
								}`}
							>
								{adjusts && (
									<span className="flex items-center gap-2">
										<span className="text-text-tertiary">
											Adjusts
										</span>
										<NodeLink
											kind={kind}
											node={
												adjusts
											}
										/>
									</span>
								)}
								{adjustments.length > 0 && (
									<span className="flex flex-wrap items-center gap-2">
										<span className="text-text-tertiary">
											Adjusted by
										</span>
										{adjustments.map(
											(n) => (
												<NodeLink
													key={
														n.id
													}
													kind={
														kind
													}
													node={
														n
													}
												/>
											)
										)}
									</span>
								)}
							</div>
						)}
					</div>
				)}
			</div>

			{superseded && (
				/* A pill rather than a row: from an old version the next move
				   is almost always the document that counts. */
				<Link
					to={routeFor(kind, final.id)}
					className={`${HEADER_PILL} border-border bg-surface text-primary-text hover:border-border-strong`}
				>
					{final_is_live ? "Current" : "Latest"} {final.number}
					<ArrowUpRight size={13} />
				</Link>
			)}
		</>
	);
}
