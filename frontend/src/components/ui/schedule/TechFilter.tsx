import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { ChevronDown, Check, Users } from "lucide-react";
import type { Technician } from "../../../types/technicians";
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE, TOOLBAR_BTN_IDLE } from "./toolbarButton";

interface TechFilterProps {
	technicians: Technician[];
	selected: Set<string>;          // empty = All
	onChange: (next: Set<string>) => void;
	techColorMap: Map<string, string>;
}

export default function TechFilter({ technicians, selected, onChange, techColorMap }: TechFilterProps) {
	const [dropdownOpen, setDropdownOpen] = useState(false);
	const [mode, setMode] = useState<"pills" | "dropdown">("pills");
	const [menuMaxH, setMenuMaxH] = useState<number | undefined>(undefined);

	const wrapRef     = useRef<HTMLDivElement>(null);
	const probeRef    = useRef<HTMLDivElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const triggerRef  = useRef<HTMLButtonElement>(null);

	// Auto-detect: measure whether pills fit in available container width
	useEffect(() => {
		const wrap  = wrapRef.current;
		const probe = probeRef.current;
		if (!wrap || !probe) return;
		const check = () => {
			setMode(probe.scrollWidth > wrap.clientWidth ? "dropdown" : "pills");
		};
		const ro = new ResizeObserver(check);
		ro.observe(wrap);
		check();
		return () => ro.disconnect();
	}, [technicians]);

	// Close dropdown on outside click
	useEffect(() => {
		if (!dropdownOpen) return;
		function handleClick(e: MouseEvent) {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setDropdownOpen(false);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [dropdownOpen]);

	// used to avoid the selction from overflowing 
	useLayoutEffect(() => {
		if (!dropdownOpen) return;
		const compute = () => {
			const btn = triggerRef.current;
			if (!btn) return;
			let el: HTMLElement | null = btn.parentElement;
			let bound = window.innerHeight;
			while (el) {
				const s = getComputedStyle(el);
				if (s.overflowY === "hidden" || s.overflow === "hidden") {
					bound = Math.min(bound, el.getBoundingClientRect().bottom);
					break;
				}
				el = el.parentElement;
			}
			const btnBottom = btn.getBoundingClientRect().bottom;
			// Never exceed the space left in the card
			setMenuMaxH(Math.max(96, bound - btnBottom - 10));
		};
		compute();
		window.addEventListener("resize", compute);
		return () => window.removeEventListener("resize", compute);
	}, [dropdownOpen]);

	function toggleTech(id: string) {
		const next = new Set(selected);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
			if (next.size === technicians.length) {
				onChange(new Set());
				return;
			}
		}
		onChange(next);
	}

	function selectAll() {
		onChange(new Set());
		setDropdownOpen(false);
	}

	const isFiltered  = selected.size > 0;
	const selectedArr = technicians.filter((t) => selected.has(t.id));

	// ── Pill styles ───────────────────────────────────────────────────────────

	function renderPills() {
		return (
			<div className="flex items-center gap-1.5">
				<button
					onClick={selectAll}
					className={`${TOOLBAR_BTN_BASE} px-2.5 shrink-0 ${
						selected.size === 0 ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_IDLE
					}`}
				>
					All
				</button>
				{technicians.map((tech) => {
					const color     = techColorMap.get(tech.id) ?? "var(--color-tech-unassigned)";
					const isSel     = selected.has(tech.id);
					return (
						<button
							key={tech.id}
							onClick={() => toggleTech(tech.id)}
							className={`${TOOLBAR_BTN_BASE} px-2.5 shrink-0 flex items-center gap-1.5 ${isSel ? "" : TOOLBAR_BTN_IDLE}`}
							style={
								isSel
									? { backgroundColor: color + "22", borderColor: color + "55", color }
									: undefined
							}
						>
							<span
								className="w-1.5 h-1.5 rounded-full flex-shrink-0"
								style={{ backgroundColor: color }}
							/>
							{tech.name}
						</button>
					);
				})}
			</div>
		);
	}

	// ── Dropdown mode ─────────────────────────────────────────────────────────

	function renderDropdown() {
		return (
			<div className="relative min-w-0" ref={dropdownRef}>
				<button
					ref={triggerRef}
					onClick={() => setDropdownOpen((v) => !v)}
					title="Technicians"
					className={`${TOOLBAR_BTN_BASE} flex items-center gap-1.5 px-2.5 min-w-0 w-full ${
						isFiltered ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_IDLE
					}`}
				>
					<Users size={11} className="shrink-0" />

					{/* Color dots for selected techs */}
					{isFiltered && (
						<span className="flex items-center gap-0.5 shrink-0">
							{selectedArr.slice(0, 4).map((t) => (
								<span
									key={t.id}
									className="w-1.5 h-1.5 rounded-full flex-shrink-0"
									style={{ backgroundColor: techColorMap.get(t.id) ?? "var(--color-tech-unassigned)" }}
								/>
							))}
						</span>
					)}

					{/* Label truncates so the button can shrink to just the icon when the toolbar is tight */}
					<span className="truncate">
						{isFiltered ? `${selected.size} of ${technicians.length}` : "Technicians"}
					</span>

					<ChevronDown
						size={10}
						className="shrink-0 text-text-muted"
						style={{ transform: dropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
					/>
				</button>

				{dropdownOpen && (
					<div
						className="absolute right-0 top-full mt-1 z-50 w-52 flex flex-col bg-base border border-border-subtle rounded-lg shadow-2xl overflow-hidden"
						style={{ maxHeight: menuMaxH }}
					>
						{/* All technicians */}
						<div className="p-1 shrink-0">
							<button
								onClick={selectAll}
								className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-left transition-colors hover:bg-surface"
							>
								<span
									className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
										selected.size === 0
											? "bg-primary border-primary"
											: "border-border-strong"
									}`}
								>
									{selected.size === 0 && <Check size={9} strokeWidth={3} className="text-white" />}
								</span>
								<span className={selected.size === 0 ? "text-primary-text font-medium" : "text-text-secondary"}>
									All technicians
								</span>
							</button>
						</div>

						<div className="h-px bg-surface shrink-0" />

						{/* Scrollable tech list — flexes so the header + footer stay pinned/visible */}
						<div className="p-1 flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: 272 }}>
							{technicians.map((tech) => {
								const color = techColorMap.get(tech.id) ?? "var(--color-tech-unassigned)";
								const isSel = selected.has(tech.id);
								return (
									<button
										key={tech.id}
										onClick={() => toggleTech(tech.id)}
										className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[11px] text-left transition-colors hover:bg-surface text-text-secondary"
									>
										<span
											className="w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
											style={
												isSel
													? { backgroundColor: color, borderColor: color }
													: { borderColor: "var(--color-text-faint)" }
											}
										>
											{isSel && <Check size={9} strokeWidth={3} className="text-white" />}
										</span>
										<span
											className="w-2 h-2 rounded-full flex-shrink-0"
											style={{ backgroundColor: color }}
										/>
										<span className="truncate">{tech.name}</span>
									</button>
								);
							})}
						</div>

						{/* Footer: clear selection */}
						{isFiltered && (
							<>
								<div className="h-px bg-surface shrink-0" />
								<div className="p-1 shrink-0">
									<button
										onClick={selectAll}
										className="w-full px-2.5 py-1.5 rounded text-[10px] text-text-muted hover:text-text-secondary hover:bg-surface text-left transition-colors"
									>
										Clear selection
									</button>
								</div>
							</>
						)}
					</div>
				)}
			</div>
		);
	}

	return (
		<div ref={wrapRef} className={`relative flex items-center min-w-0 ${mode === "pills" ? "overflow-hidden" : ""}`}>
			{/* Invisible probe: measures how wide pills would actually be */}
			<div
				ref={probeRef}
				className="absolute top-0 left-0 flex items-center gap-1.5 pointer-events-none"
				style={{ visibility: "hidden", whiteSpace: "nowrap" }}
				aria-hidden="true"
			>
				<span className="h-7 px-2.5 text-[11px]">All</span>
				{technicians.map((tech) => (
					<span key={tech.id} className="h-7 px-2.5 text-[11px] flex items-center gap-1.5">
						<span className="w-1.5 h-1.5 rounded-full" />
						{tech.name}
					</span>
				))}
			</div>

			{mode === "pills" ? renderPills() : renderDropdown()}
		</div>
	);
}
