import { describe, it, expect } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import pino from "pino";
import pinoHttp from "pino-http";
import { httpLogRedact } from "../httpLogRedact.js";

describe("httpLogRedact (audit #12)", () => {
	it("drops query strings, auth headers and Set-Cookie but keeps the path", async () => {
		const lines: string[] = [];
		const logger = pino({}, { write: (s: string) => void lines.push(s) });
		const mw = pinoHttp({ logger, redact: httpLogRedact });

		const server = http.createServer((req, res) => {
			mw(req, res);
			res.setHeader("set-cookie", "refreshToken=rt-secret; HttpOnly");
			res.end("ok");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		await fetch(`http://127.0.0.1:${port}/integrations/postmark/webhook?secret=pm-secret`, {
			headers: { authorization: "Bearer at-secret", cookie: "refreshToken=old-secret" },
		});
		await new Promise<void>((r) => server.close(() => r()));

		const out = lines.join("");
		expect(out).toContain('"url":"/integrations/postmark/webhook"');
		for (const secret of ["pm-secret", "rt-secret", "at-secret", "old-secret"]) {
			expect(out).not.toContain(secret);
		}
	});
});
