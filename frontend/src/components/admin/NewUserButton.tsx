import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Headset, Plus, Wrench } from "lucide-react";

interface NewUserButtonProps {
	canCreateTechnician: boolean;
	canCreateDispatcher: boolean;
	onCreateTechnician: () => void;
	onCreateDispatcher: () => void;
}

const PRIMARY =
	"flex items-center gap-2 px-4 py-2 bg-primary-hover hover:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-base";
const ITEM =
	"w-full text-left px-3 py-2 text-sm flex items-center gap-2 text-text-primary transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none";

export default function NewUserButton({
	canCreateTechnician,
	canCreateDispatcher,
	onCreateTechnician,
	onCreateDispatcher,
}: NewUserButtonProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

	useEffect(() => {
		if (!open) return;
		itemRefs.current[0]?.focus();
		const onPointer = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("mousedown", onPointer);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onPointer);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	if (!canCreateTechnician && !canCreateDispatcher) return null;

	if (!canCreateTechnician || !canCreateDispatcher) {
		const onlyTech = canCreateTechnician;
		return (
			<button
				type="button"
				className={PRIMARY}
				onClick={onlyTech ? onCreateTechnician : onCreateDispatcher}
			>
				<Plus size={16} aria-hidden />
				{onlyTech ? "New technician" : "New dispatcher"}
			</button>
		);
	}

	const choose = (create: () => void) => {
		setOpen(false);
		triggerRef.current?.focus();
		create();
	};

	const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const items = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
		items[next]?.focus();
	};

	return (
		<div ref={rootRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={PRIMARY}
			>
				<Plus size={16} aria-hidden />
				New user
				<ChevronDown size={14} aria-hidden className="-mr-1 opacity-80" />
			</button>
			{open && (
				<div
					role="menu"
					aria-label="New user"
					onKeyDown={onMenuKeyDown}
					className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
				>
					<button
						ref={(el) => {
							itemRefs.current[0] = el;
						}}
						type="button"
						role="menuitem"
						className={ITEM}
						onClick={() => choose(onCreateTechnician)}
					>
						<Wrench size={15} aria-hidden className="text-text-tertiary" />
						Technician
					</button>
					<button
						ref={(el) => {
							itemRefs.current[1] = el;
						}}
						type="button"
						role="menuitem"
						className={ITEM}
						onClick={() => choose(onCreateDispatcher)}
					>
						<Headset size={15} aria-hidden className="text-text-tertiary" />
						Dispatcher
					</button>
				</div>
			)}
		</div>
	);
}
