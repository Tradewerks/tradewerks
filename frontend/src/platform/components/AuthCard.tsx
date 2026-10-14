import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

export const inputClass =
	"h-9 w-full rounded-md border border-border bg-surface-inset px-3 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:outline-2 focus-visible:outline-primary";
export const primaryButtonClass =
	"h-9 w-full rounded-md bg-primary text-sm font-medium text-white transition-opacity duration-150 ease-out disabled:opacity-50";
export const labelClass = "mb-1 block text-xs font-medium text-text-secondary";

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="grid min-h-svh place-items-center bg-canvas px-4">
			<div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-6">
				<div>
					<p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
						TradeWerks back office
					</p>
					<h1 className="mt-1 text-lg font-semibold text-text-primary">
						{title}
					</h1>
				</div>
				{children}
			</div>
		</div>
	);
}

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
	const [shown, setShown] = useState(false);
	return (
		<div className="relative">
			<input
				{...props}
				type={shown ? "text" : "password"}
				className={`${inputClass} pr-9`}
			/>
			<button
				type="button"
				onClick={() => setShown((s) => !s)}
				aria-label={shown ? "Hide password" : "Show password"}
				aria-pressed={shown}
				className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
			>
				{shown ? <EyeOff size={16} /> : <Eye size={16} />}
			</button>
		</div>
	);
}
