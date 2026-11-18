// ============================================================================
// Minimal Mustache-compatible template renderer.
//
// Used for BOTH the live preview (frontend mirror at frontend/src/lib/renderTemplate.ts)
// and the actual send (followupScheduler). Keep the two implementations in sync —
// what an org previews must be byte-for-byte what their client receives.
//
// Supports the subset of Mustache our email templates need:
//   {{ name }}          → HTML-escaped interpolation
//   {{{ name }}}        → raw (unescaped) interpolation
//   {{# name }}…{{/ }}  → section: rendered once when `name` is truthy
//                          (arrays render children once per item)
//   {{^ name }}…{{/ }}  → inverted section: rendered when `name` is falsy/empty
//   {{! comment }}      → dropped
// Names may be dotted paths (e.g. brand.logo_url), resolved against the model.
// Missing values render as empty strings (never "undefined").
// ============================================================================

type Model = Record<string, unknown>;

type Node =
	| { type: "text"; value: string }
	| { type: "var"; name: string; raw: boolean }
	| { type: "section"; name: string; inverted: boolean; children: Node[] };

// Matches, in priority order: a triple-stache {{{ raw }}}, then any {{ ... }} tag
// (with an optional leading sigil #, ^, /, or !).
const TAG_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([#^/!])?\s*([\w.]*?)\s*\}\}/g;

function parse(template: string): Node[] {
	const root: Node[] = [];
	// Stack of open sections; we always append to the top frame's children.
	const stack: { name: string; inverted: boolean; children: Node[] }[] = [];
	const push = (node: Node) => (stack.length ? stack[stack.length - 1].children : root).push(node);

	let lastIndex = 0;
	let match: RegExpExecArray | null;
	TAG_RE.lastIndex = 0;
	while ((match = TAG_RE.exec(template)) !== null) {
		if (match.index > lastIndex) {
			push({ type: "text", value: template.slice(lastIndex, match.index) });
		}
		lastIndex = TAG_RE.lastIndex;

		const rawName = match[1];
		if (rawName !== undefined) {
			push({ type: "var", name: rawName, raw: true });
			continue;
		}

		const sigil = match[2];
		const name = match[3] ?? "";
		if (sigil === "!") continue; // comment
		if (sigil === "#" || sigil === "^") {
			stack.push({ name, inverted: sigil === "^", children: [] });
			continue;
		}
		if (sigil === "/") {
			// Close the nearest matching section. If names mismatch we still pop the
			// top frame (defensive — malformed templates shouldn't throw).
			const frame = stack.pop();
			if (frame) {
				push({
					type: "section",
					name: frame.name,
					inverted: frame.inverted,
					children: frame.children,
				});
			}
			continue;
		}
		// Plain interpolation.
		push({ type: "var", name, raw: false });
	}
	if (lastIndex < template.length) {
		push({ type: "text", value: template.slice(lastIndex) });
	}
	// Any unclosed sections: fold their collected children back in as-is.
	while (stack.length) {
		const frame = stack.pop()!;
		push({
			type: "section",
			name: frame.name,
			inverted: frame.inverted,
			children: frame.children,
		});
	}
	return root;
}

function resolve(model: Model, path: string): unknown {
	if (path === ".") return model;
	return path.split(".").reduce<unknown>((acc, key) => {
		if (acc == null || typeof acc !== "object") return undefined;
		return (acc as Record<string, unknown>)[key];
	}, model);
}

function isTruthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (value == null) return false;
	if (typeof value === "string") return value.trim().length > 0;
	return Boolean(value);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function stringify(value: unknown): string {
	if (value == null) return "";
	return String(value);
}

function renderNodes(nodes: Node[], model: Model, escape: boolean): string {
	let out = "";
	for (const node of nodes) {
		if (node.type === "text") {
			out += node.value;
		} else if (node.type === "var") {
			const value = stringify(resolve(model, node.name));
			out += node.raw || !escape ? value : escapeHtml(value);
		} else {
			const value = resolve(model, node.name);
			if (node.inverted) {
				if (!isTruthy(value)) out += renderNodes(node.children, model, escape);
			} else if (isTruthy(value)) {
				if (Array.isArray(value)) {
					for (const item of value) {
						const scope =
							item && typeof item === "object"
								? { ...model, ...(item as Model) }
								: model;
						out += renderNodes(node.children, scope, escape);
					}
				} else {
					out += renderNodes(node.children, model, escape);
				}
			}
		}
	}
	return out;
}

/**
 * Render a template string against a model. Never throws on a malformed template.
 * `escape: false` is for text/plain bodies, where HTML entities would show literally.
 */
export function renderTemplate(
	template: string,
	model: Model,
	opts: { escape?: boolean } = {},
): string {
	try {
		return renderNodes(parse(template), model, opts.escape !== false);
	} catch {
		return template;
	}
}

/**
 * Return the unique variable/section names referenced by a template, in first-seen
 * order. Used by the editor to build the "variables" form. Comments are excluded.
 */
export function extractVariables(template: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	let match: RegExpExecArray | null;
	TAG_RE.lastIndex = 0;
	while ((match = TAG_RE.exec(template)) !== null) {
		const rawName = match[1];
		const sigil = match[2];
		const name = rawName ?? match[3] ?? "";
		if (!rawName && (sigil === "!" || sigil === "/")) continue;
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}
