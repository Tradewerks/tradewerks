import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LogOut, Monitor, Moon, Palette, Sun } from "lucide-react";
import { usePlatformAuth } from "../store";
import { useThemeStore } from "../../stores/themeStore";

const THEMES = [
	["system", Monitor, "System"],
	["light", Sun, "Light"],
	["dark", Moon, "Dark"],
] as const;

export default function StaffUserMenu({ onSignOut }: { onSignOut: () => void }) {
	const staff = usePlatformAuth((s) => s.staff);
	const { theme, setTheme } = useThemeStore();
	const [open, setOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const initial = (staff?.name || staff?.email || "?").charAt(0).toUpperCase();

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={wrapperRef} className="relative">
			<button
				type="button"
				aria-label="Account menu"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={`w-9 h-9 rounded-lg bg-avatar-bg flex items-center justify-center pt-[3px] text-avatar-fg font-semibold text-sm border-b-[3px] transition-colors ${
					open ? "border-primary" : "border-transparent hover:border-primary/40"
				}`}
			>
				{initial}
			</button>

			{open && (
				<div
					className="absolute top-full right-0 mt-2 w-54 bg-surface-raised border border-border rounded-lg shadow-lg z-50 overflow-hidden"
				>
					<div className="px-4 py-3 flex items-start gap-3">
						<span className="w-10 h-10 shrink-0 rounded-lg bg-avatar-bg flex items-center justify-center text-avatar-fg font-semibold text-sm">
							{initial}
						</span>
						<div className="min-w-0">
							<p className="text-sm font-semibold text-text-primary truncate">{staff?.name}</p>
							<p className="text-xs text-text-muted truncate">{staff?.email}</p>
							<p className="text-xs text-text-muted mt-0.5">TradeWerks staff</p>
						</div>
					</div>

					<div className="border-t border-border" />
					<div className="p-2 flex flex-col">
						<button
							type="button"
							aria-expanded={themeOpen}
							className="w-full flex items-center gap-1 px-3 py-2 text-sm text-text-primary rounded-md hover:bg-surface transition-colors"
							onClick={() => setThemeOpen((o) => !o)}
						>
							<Palette size={16} />
							Theme
							<ChevronDown
								size={13}
								className={`ml-auto transition-transform duration-200 ${themeOpen ? "rotate-180" : ""}`}
							/>
						</button>
						{themeOpen && (
							<div className="flex flex-col pb-0.5">
								{THEMES.map(([value, Icon, label]) => (
									<button
										type="button"
										key={value}
										onClick={() => setTheme(value)}
										className={`w-full flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm rounded-md transition-colors ${
											theme === value
												? "text-primary hover:bg-surface"
												: "text-text-muted hover:text-text-primary hover:bg-surface"
										}`}
									>
										<Icon size={14} />
										{label}
										{theme === value && <Check size={12} className="ml-auto" />}
									</button>
								))}
							</div>
						)}
					</div>

					<div className="border-t border-border" />
					<div className="p-2">
						<button
							type="button"
							onClick={() => {
								setOpen(false);
								onSignOut();
							}}
							className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error-text rounded-md hover:bg-error-bg hover:text-error transition-colors"
						>
							<LogOut size={16} />
							Sign out
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
