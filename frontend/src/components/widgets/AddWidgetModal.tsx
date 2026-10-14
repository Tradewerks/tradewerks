import { useState, useMemo } from "react";
import { X, Search, Plus, Minus } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { addWidget, removeWidget, type WidgetCatalog } from "../../lib/gridLayoutEngine";
import { useAuthStore } from "../../auth/authStore";
import { canSeeWidget } from "../../lib/permissionGates";
import { useResolvedTheme } from "../../hooks/useApplyTheme";
import type { Layout, LayoutItem } from "react-grid-layout";

interface AddWidgetModalProps {
	isOpen: boolean;
	onClose: () => void;
	currentLayout: Layout;
	onLayoutChange: (newLayout: Layout) => void;
	catalog: WidgetCatalog & Record<string, { label: string; requiredPermission?: string; requiredAnyPermission?: readonly string[] }>;
}

const widgetHue = (id: string) => {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
	return h;
};

function buildCompactLayout(catalog: AddWidgetModalProps["catalog"], layout: Layout) {
	const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
	const placed: LayoutItem[] = [];
	for (const item of sorted) {
		const h = Math.min(item.h, catalog[item.i]?.maxH ?? item.h);
		let newY = 0;
		for (const p of placed) {
			if (item.x < p.x + p.w && item.x + item.w > p.x)
				newY = Math.max(newY, p.y + p.h);
		}
		placed.push({ ...item, y: newY, h });
	}
	return { norm: placed };
}

function LayoutPreview({
	catalog,
	layout,
	hoveredId,
	proposedId,
}: {
	catalog: AddWidgetModalProps["catalog"];
	layout: Layout;
	hoveredId: string | null;
	proposedId: string | null;
}) {
	const dark = useResolvedTheme() === "dark";
	if (!layout.length) return (
		<div className="w-full h-full flex items-center justify-center text-text-muted text-xs">
			No widgets active
		</div>
	);

	const COLS = 12;
	const { norm } = buildCompactLayout(catalog, layout);
	const totalH = Math.max(1, ...norm.map((item) => item.y + item.h));

	return (
		<div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden" }}>
			{norm.map((item) => {
				const hue = widgetHue(item.i);
				const isProposed = item.i === proposedId;
				const dim = !!hoveredId && item.i !== hoveredId && !isProposed;
				const label = catalog[item.i]?.label ?? item.i;
				const short = label.split(" ").slice(0, 2).join(" ");
				return (
					<div key={item.i} style={{
						position: "absolute",
						left: `${(item.x / COLS) * 100}%`,
						top: `${(item.y / totalH) * 100}%`,
						width: `${(item.w / COLS) * 100}%`,
						height: `${(item.h / totalH) * 100}%`,
						background: `hsla(${hue}, ${dark ? 50 : 62}%, ${dark ? 50 : 52}%, ${dim ? (dark ? 0.08 : 0.12) : isProposed ? (dark ? 0.28 : 0.3) : (dark ? 0.2 : 0.22)})`,
						border: `${isProposed ? "2px dashed" : "1px solid"} hsla(${hue}, ${dark ? 55 : 58}%, ${dark ? 60 : 44}%, ${dim ? 0.25 : 0.7})`,
						borderRadius: 3,
						display: "flex", alignItems: "center", justifyContent: "center",
						overflow: "hidden",
						opacity: dim ? 0.35 : isProposed ? 0.9 : 1,
						transition: "opacity 120ms",
						boxSizing: "border-box",
					}}>
						<span style={{ fontSize: 8, color: dark ? `hsl(${hue},60%,78%)` : `hsl(${hue},55%,30%)`, textAlign: "center", padding: "1px 2px", lineHeight: 1.2, userSelect: "none", pointerEvents: "none" }}>
							{short}{isProposed ? " +" : ""}
						</span>
					</div>
				);
			})}
		</div>
	);
}

const AddWidgetModal = ({ isOpen, onClose, currentLayout, onLayoutChange, catalog }: AddWidgetModalProps) => {
	const [search, setSearch] = useState("");
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const { user } = useAuthStore();

	const activeIds = useMemo(
		() => new Set(currentLayout.map((l) => l.i)),
		[currentLayout]
	);

	const proposedId = hoveredId && !activeIds.has(hoveredId) ? hoveredId : null;

	const previewLayout = useMemo(() => {
		if (!proposedId) return currentLayout;
		return addWidget(catalog, proposedId, currentLayout);
	}, [proposedId, currentLayout, catalog]);

	const filtered = useMemo(() => {
		const q = search.toLowerCase();
		return Object.entries(catalog).filter(([, w]) =>
			canSeeWidget(user, w) && w.label.toLowerCase().includes(q)
		);
	}, [search, user, catalog]);

	const activeWidgets    = filtered.filter(([id]) =>  activeIds.has(id));
	const availableWidgets = filtered.filter(([id]) => !activeIds.has(id));

	const toggle = (id: string) => {
		if (activeIds.has(id)) {
			onLayoutChange(removeWidget(id, currentLayout));
		} else {
			onLayoutChange(addWidget(catalog, id, currentLayout));
		}
	};

	const content = (
		<div className="flex h-full min-h-0">
			{/* Left — list */}
			<div className="flex flex-col w-[42%] min-w-0 border-r border-border shrink-0">
				<div className="flex items-center justify-between px-4 py-4 border-b border-border shrink-0">
					<h2 className="text-base font-semibold text-text-primary">Manage Widgets</h2>
					<button onClick={onClose} className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface transition-colors">
						<X size={16} />
					</button>
				</div>

				<div className="px-4 py-3 border-b border-border shrink-0">
					<div className="relative">
						<Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
						<input
							type="text"
							placeholder="Search widgets..."
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="w-full bg-surface border border-border rounded-md pl-8 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
						/>
					</div>
				</div>

				<div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-4">
					{activeWidgets.length > 0 && (
						<section>
							<p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-2">Active</p>
							<div className="space-y-1">
								{activeWidgets.map(([id, widget]) => (
									<WidgetRow key={id} id={id} label={widget.label} active onToggle={() => toggle(id)} onHover={setHoveredId} />
								))}
							</div>
						</section>
					)}
					{availableWidgets.length > 0 && (
						<section>
							<p className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary mb-2">Available</p>
							<div className="space-y-1">
								{availableWidgets.map(([id, widget]) => (
									<WidgetRow key={id} id={id} label={widget.label} active={false} onToggle={() => toggle(id)} onHover={setHoveredId} />
								))}
							</div>
						</section>
					)}
					{filtered.length === 0 && (
						<p className="text-sm text-text-muted text-center py-6">No widgets match "{search}"</p>
					)}
				</div>

				<div className="px-4 py-4 border-t border-border shrink-0 flex justify-end">
					<button onClick={onClose} className="px-4 py-2 rounded-md bg-primary hover:bg-primary-hover text-on-primary text-sm font-medium transition-colors">
						Done
					</button>
				</div>
			</div>

			{/* Right — interactive preview */}
			<div className="flex flex-col flex-1 min-w-0">
				<div className="px-4 py-4 border-b border-border shrink-0">
					<p className="text-xs font-semibold text-text-tertiary uppercase tracking-widest">Layout Preview</p>
				</div>
				<div className="flex-1 min-h-0 p-4 overflow-hidden">
					<LayoutPreview
						catalog={catalog}
						layout={previewLayout}
						hoveredId={hoveredId}
						proposedId={proposedId}
					/>
				</div>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={isOpen} onClose={onClose} size="lg" />;
};

interface WidgetRowProps {
	id: string;
	label: string;
	active: boolean;
	onToggle: () => void;
	onHover: (id: string | null) => void;
}

const WidgetRow = ({ id, label, active, onToggle, onHover }: WidgetRowProps) => (
	<div
		className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-surface transition-colors"
		onMouseEnter={() => onHover(id)}
		onMouseLeave={() => onHover(null)}
	>
		<div className="flex items-center gap-2 min-w-0">
			<span className="w-2 h-2 rounded-sm shrink-0" style={{ background: `hsl(${widgetHue(id)},55%,55%)` }} />
			<span className="text-sm text-text-primary truncate">{label}</span>
		</div>
		<button
			onClick={onToggle}
			className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
				active ? "text-error-text hover:bg-error/10" : "text-primary-text hover:bg-primary/10"
			}`}
		>
			{active ? <Minus size={12} /> : <Plus size={12} />}
			{active ? "Remove" : "Add"}
		</button>
	</div>
);

export default AddWidgetModal;
