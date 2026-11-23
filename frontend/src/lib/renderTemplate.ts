// ============================================================================
// Minimal Mustache-compatible template renderer — FRONTEND MIRROR.
//
// This is a byte-for-byte mirror of backend/src/services/templateRenderer.ts.
// The live preview in the template editor renders with this; the actual email
// send renders with the backend copy. They MUST stay in sync so what an org
// previews is exactly what their client receives. If you change one, change both.
// ============================================================================

type Model = Record<string, unknown>;

type Node =
	| { type: "text"; value: string }
	| { type: "var"; name: string; raw: boolean }
	| { type: "section"; name: string; inverted: boolean; children: Node[] };

const TAG_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([#^/!])?\s*([\w.]*?)\s*\}\}/g;

function parse(template: string): Node[] {
	const root: Node[] = [];
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
		if (sigil === "!") continue;
		if (sigil === "#" || sigil === "^") {
			stack.push({ name, inverted: sigil === "^", children: [] });
			continue;
		}
		if (sigil === "/") {
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
		push({ type: "var", name, raw: false });
	}
	if (lastIndex < template.length) {
		push({ type: "text", value: template.slice(lastIndex) });
	}
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

/** Unique variable/section names referenced by a template, in first-seen order. */
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
