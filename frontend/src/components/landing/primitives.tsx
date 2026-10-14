import type { ReactNode } from "react";

export function Eyebrow({
	children,
	className = "text-eyebrow",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`font-mono text-xs uppercase tracking-[0.16em] ${className}`}>
			{children}
		</div>
	);
}

export function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<h2 className="m-0 text-balance text-[length:clamp(32px,4vw,48px)] font-semibold leading-[1.05] tracking-[-0.03em]">
			{children}
		</h2>
	);
}

/** Small uppercase mono label used as a card or panel header. */
export function CardLabel({
	children,
	className = "text-ink-3",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={`font-mono text-xs uppercase tracking-[0.12em] ${className}`}>
			{children}
		</div>
	);
}

/** Title + intro paragraph laid out side by side, wrapping on narrow screens. */
export function SplitIntro({
	title,
	children,
	bodyClassName = "text-ink-2",
}: {
	title: string;
	children: ReactNode;
	bodyClassName?: string;
}) {
	return (
		<div className="flex flex-wrap items-end justify-between gap-x-14 gap-y-6">
			<div className="flex-[1_1_460px]">
				<SectionTitle>{title}</SectionTitle>
			</div>
			<p
				className={`m-0 flex-[1_1_380px] text-pretty text-lg leading-[1.55] ${bodyClassName}`}
			>
				{children}
			</p>
		</div>
	);
}

export function Logo() {
	return (
		<div className="flex size-7 items-center justify-center rounded-[7px] bg-brand">
			<div className="size-2.5 rounded-[2px] bg-lime" />
		</div>
	);
}
