import type { ReactNode } from "react";
import { Logo } from "../primitives";
import { LEGAL, LEGAL_LINKS } from "./legal";
import "../landing.css";

// Shared shell for the public legal pages. Like the landing page, these render
// outside the app's router (see main.tsx), so every link is a plain anchor.

const container = "mx-auto max-w-[760px] px-6";

// Descendant styles keep the document bodies as plain h2/p/ul markup.
const prose =
	"text-[16px] leading-[1.65] text-ink-2 " +
	"[&_h2]:mb-3 [&_h2]:mt-11 [&_h2]:text-[22px] [&_h2]:font-semibold [&_h2]:leading-tight [&_h2]:tracking-[-0.015em] [&_h2]:text-ink " +
	"[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-[17px] [&_h3]:font-semibold [&_h3]:text-ink " +
	"[&_p]:my-3 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-1.5 " +
	"[&_a]:font-medium [&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 [&_strong]:text-ink";

export default function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="min-h-screen bg-paper font-sans text-ink">
			<title>{`${title} — ${LEGAL.company}`}</title>

			<header className="border-b border-line bg-paper">
				<div className={`${container} flex items-center justify-between py-3.5`}>
					<a href="/" className="flex items-center gap-2.5 text-ink">
						<Logo />
						<div className="text-[19px] font-bold tracking-[-0.02em]">
							{LEGAL.company}
						</div>
					</a>
					<a
						href="/"
						className="px-1 py-2.5 text-[15px] font-medium text-ink-2 hover:text-ink"
					>
						Back to home
					</a>
				</div>
			</header>

			<main className={`${container} pb-20 pt-14`}>
				<h1 className="m-0 text-balance text-[length:clamp(34px,5vw,48px)] font-semibold leading-[1.05] tracking-[-0.03em]">
					{title}
				</h1>
				<p className="mb-0 mt-3 font-mono text-xs uppercase tracking-[0.12em] text-ink-4">
					Effective {LEGAL.effectiveDate}
				</p>
				<div className={`mt-8 ${prose}`}>{children}</div>
			</main>

			<footer
				className={`${container} flex flex-wrap items-center justify-between gap-4 border-t border-line pb-8 pt-5 text-sm text-ink-4`}
			>
				<div>
					© {new Date().getFullYear()} {LEGAL.entity}
				</div>
				<nav className="flex flex-wrap gap-x-4">
					{LEGAL_LINKS.map(([href, label]) => (
						<a key={href} href={href} className="py-2.5 hover:text-ink">
							{label}
						</a>
					))}
				</nav>
			</footer>
		</div>
	);
}
