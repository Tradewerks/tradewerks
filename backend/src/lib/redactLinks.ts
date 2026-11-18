// A customer link is a bearer credential: once a message is settled, nothing
// that stores or shows its body may keep a working one.
const LINK = /\/app\/c\/[^\s"<)]+/g;

export function redactLinks(text: string): string;
export function redactLinks(text: string | null | undefined): string | null;
export function redactLinks(text: string | null | undefined): string | null {
	return text == null ? null : text.replace(LINK, "/app/c/…");
}
