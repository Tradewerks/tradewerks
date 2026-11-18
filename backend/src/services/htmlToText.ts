export const htmlToText = (html: string): string =>
	html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<head[\s\S]*?<\/head>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.replace(/&middot;/g, "\u00b7")
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
