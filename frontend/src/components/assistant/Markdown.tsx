import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * Assistant prose, rendered as markdown.
 *
 * The model reaches for bold, lists and tables on its own — a stock rate table
 * or a run of visits is genuinely easier to read as a table — so shipping the
 * raw asterisks and pipes was costing readability on every answer.
 *
 * Three deliberate choices:
 *  - GFM, for tables and strikethrough. Anything less and the model's tables
 *    arrive as a wall of pipes.
 *  - Soft line breaks are kept (remark-breaks). Markdown would otherwise fold
 *    "Visit 1\nVisit 2" onto one line, which is how the panel used to read.
 *  - No raw HTML. react-markdown drops it by default and we leave it that way:
 *    tool results carry client-supplied text, and none of it should become
 *    markup.
 *
 * Job numbers survive: `#1234` needs a trailing space to be a heading, and
 * `_` inside a word is not emphasis in CommonMark, so JOB_12_34 stays intact.
 */
function Markdown({ children }: { children: string }) {
	return (
		<div className="text-sm text-text-primary break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				components={COMPONENTS}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}

/**
 * Inline, not `font-mono`: index.css sets `* { font-family: "Inter" }` outside
 * any cascade layer, and unlayered CSS beats every Tailwind utility no matter
 * its specificity. A style attribute is the one thing that still wins, and code
 * is the one place here where a monospace stack actually matters.
 */
const MONO = { fontFamily: "var(--font-mono)" };

/**
 * Tailwind rather than a typography plugin: the panel is a 400px drawer, and
 * prose defaults are tuned for an article column.
 */
const COMPONENTS: NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]> = {
	p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,

	strong: ({ children }) => (
		<strong className="font-semibold text-text-primary">{children}</strong>
	),
	em: ({ children }) => <em className="italic">{children}</em>,
	del: ({ children }) => <del className="text-text-muted line-through">{children}</del>,

	a: ({ children, href }) => (
		<a
			href={href}
			target="_blank"
			rel="noreferrer noopener"
			className="text-text-link underline underline-offset-2 hover:opacity-80"
		>
			{children}
		</a>
	),

	ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
	ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
	li: ({ children }) => (
		<li className="leading-relaxed marker:text-text-muted">{children}</li>
	),

	// Headings in a drawer this narrow are weight and spacing, not size.
	h1: ({ children }) => (
		<h2 className="mt-4 mb-2 text-base font-semibold text-text-primary">{children}</h2>
	),
	h2: ({ children }) => (
		<h2 className="mt-4 mb-2 text-base font-semibold text-text-primary">{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className="mt-3 mb-1.5 text-sm font-semibold text-text-primary">{children}</h3>
	),
	h4: ({ children }) => (
		<h4 className="mt-3 mb-1.5 text-sm font-semibold text-text-secondary">
			{children}
		</h4>
	),
	h5: ({ children }) => (
		<h5 className="mt-3 mb-1.5 text-sm font-semibold text-text-secondary">
			{children}
		</h5>
	),
	h6: ({ children }) => (
		<h6 className="mt-3 mb-1.5 text-sm font-semibold text-text-secondary">
			{children}
		</h6>
	),

	blockquote: ({ children }) => (
		<blockquote className="my-2 border-l-2 border-border pl-3 text-text-secondary">
			{children}
		</blockquote>
	),
	hr: () => <hr className="my-3 border-border-subtle" />,

	code: ({ children }) => (
		<code style={MONO} className="rounded bg-surface-inset px-1 py-0.5 text-[0.85em] text-text-primary">
			{children}
		</code>
	),
	// The inner <code> resets itself here — a fenced block is one panel, not a
	// run of inline chips.
	pre: ({ children }) => (
		<pre
			style={MONO}
			className="my-2 overflow-x-auto rounded-md border border-border-subtle bg-surface-inset p-2.5 text-xs [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs"
		>
			{children}
		</pre>
	),

	// A table wider than the drawer scrolls itself rather than the panel.
	table: ({ children }) => (
		<div className="my-2 overflow-x-auto rounded-md border border-border-subtle">
			<table className="w-full border-collapse text-xs">{children}</table>
		</div>
	),
	thead: ({ children }) => <thead className="bg-surface-inset">{children}</thead>,
	tr: ({ children }) => (
		<tr className="border-b border-border-subtle last:border-b-0">{children}</tr>
	),
	th: ({ children }) => (
		<th className="px-2.5 py-1.5 text-left font-semibold whitespace-nowrap text-text-secondary">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="px-2.5 py-1.5 align-top text-text-primary">{children}</td>
	),

	img: ({ src, alt }) => (
		<img
			src={typeof src === "string" ? src : undefined}
			alt={alt}
			className="my-2 max-w-full rounded-md"
		/>
	),
};

/**
 * Streaming re-renders this on every delta; the parse is only worth doing when
 * the text actually changed.
 */
export default memo(Markdown);
