// pino-http redaction: bearer tokens, cookies (incl. refresh-token Set-Cookie),
// and query strings (Postmark secret, OAuth codes). The url keeps its path.
export const httpLogRedact = {
	paths: [
		"req.headers.authorization",
		"req.headers.cookie",
		"req.query",
		"req.url",
		'res.headers["set-cookie"]',
	],
	censor: (value: unknown, path: string[]) =>
		path[path.length - 1] === "url" && typeof value === "string" ? value.split("?")[0] : "[Redacted]",
};
