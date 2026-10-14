import { useRef, useState, useEffect } from "react";
import { Tag, ChevronDown, X, Plus, Pencil } from "lucide-react";
import type { InventoryTag } from "../../types/inventory";
import { useCreateInventoryTagMutation } from "../../hooks/useInventory";

interface TagPickerProps {
	tags: InventoryTag[];
	selectedIds: string[];
	onChange: (ids: string[]) => void;
	/** Opens the full tag editor (rename + delete-with-confirm) — this picker
	    only filters and creates, so both renaming and deleting live one level up. */
	onManage: () => void;
}

export default function TagPicker({ tags, selectedIds, onChange, onManage }: TagPickerProps) {
	const [open, setOpen] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const createMutation = useCreateInventoryTagMutation();

	useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	const toggle = (id: string) => {
		onChange(selectedIds.includes(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id]);
	};

	const clearAll = (e: React.MouseEvent) => {
		e.stopPropagation();
		onChange([]);
	};

	const handleCreate = async () => {
		const label = newLabel.trim();
		if (!label || createMutation.isPending) return;
		try {
			await createMutation.mutateAsync(label);
			setNewLabel("");
			inputRef.current?.focus();
		} catch {
			// ignore duplicate/validation errors silently in picker
		}
	};

	const hasFilter = selectedIds.length > 0;

	return (
		<div ref={ref} className="relative">
			<button
				onClick={() => setOpen((o) => !o)}
				className={`inline-flex items-center gap-1.5 h-9 px-2.5 rounded-md border text-sm font-medium transition-colors ${
					hasFilter
						? "bg-primary-bg border-primary-border text-primary-text"
						: "bg-surface hover:bg-surface-raised border-border text-text-secondary"
				}`}
			>
				<Tag size={13} />
				<span>Tags</span>
				{hasFilter ? (
					<span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-primary text-on-primary text-xs font-medium leading-none">
						{selectedIds.length}
					</span>
				) : (
					<ChevronDown size={12} className="text-text-muted" />
				)}
				{hasFilter && (
					<span
						onClick={clearAll}
						className="ml-0.5 p-0.5 rounded hover:bg-primary-bg transition-colors cursor-pointer"
					>
						<X size={11} />
					</span>
				)}
			</button>

			{open && (
				<div className="absolute top-full mt-1 left-0 z-50 bg-surface border border-border rounded-lg shadow-xl flex flex-col min-w-[200px] w-max max-w-[280px]">
					{/* Rename lives in the full editor, not here — this row is
					    the one way from filtering into managing. */}
					<div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle">
						<span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
							Filter by tag
						</span>
						<button
							onClick={() => {
								setOpen(false);
								onManage();
							}}
							aria-label="Edit tags"
							title="Edit tags"
							className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
						>
							<Pencil size={12} />
						</button>
					</div>

					{/* Scrollable tag list */}
					<div className="overflow-y-auto max-h-[200px] py-1">
						{tags.length === 0 ? (
							<p className="px-3 py-2 text-xs text-text-muted">No tags yet — create one below.</p>
						) : (
							tags.map((tag) => {
								const checked = selectedIds.includes(tag.id);
								return (
									<button
										key={tag.id}
										onClick={() => toggle(tag.id)}
										className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-surface-raised transition-colors min-w-0"
									>
										<span
											className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
												checked ? "bg-primary border-primary" : "border-border-strong"
											}`}
										>
											{checked && (
												<svg viewBox="0 0 10 8" fill="none" className="w-2 h-2">
													<path
														d="M1 4l3 3 5-6"
														stroke="white"
														strokeWidth="1.5"
														strokeLinecap="round"
														strokeLinejoin="round"
													/>
												</svg>
											)}
										</span>
										<span className={`truncate ${checked ? "text-text-primary font-medium" : "text-text-secondary"}`}>
											{tag.label}
										</span>
									</button>
								);
							})
						)}
					</div>

					{/* Always-visible create row */}
					<div className="border-t border-border-subtle p-2 flex gap-1.5">
						<input
							ref={inputRef}
							type="text"
							value={newLabel}
							onChange={(e) => setNewLabel(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleCreate()}
							placeholder="New tag..."
							className="flex-1 min-w-0 h-7 px-2 rounded bg-surface-inset border border-input text-xs text-primary placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-primary-border"
						/>
						<button
							onClick={handleCreate}
							disabled={!newLabel.trim() || createMutation.isPending}
							className="h-7 w-7 flex items-center justify-center rounded bg-primary hover:bg-primary-hover disabled:opacity-40 transition-colors flex-shrink-0"
						>
							<Plus size={13} className="text-on-primary" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
