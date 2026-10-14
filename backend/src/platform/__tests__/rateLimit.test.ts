import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { upgradeRequestLimiter } from "../rateLimit.js";

let server: Server;
let base: string;

beforeAll(async () => {
	const app = express();
	app.use((req, _res, next) => {
		req.user = { uid: req.header("x-user") ?? "" } as typeof req.user;
		next();
	});
	app.post("/", upgradeRequestLimiter, (req, res) => {
		res.status(Number(req.header("x-status"))).end();
	});
	server = app.listen(0);
	await new Promise((resolve) => server.once("listening", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
	server.close();
});

const post = (user: string, status: number) =>
	fetch(base, {
		method: "POST",
		headers: { "x-user": user, "x-status": String(status) },
	}).then((r) => r.status);

describe("upgradeRequestLimiter", () => {
	it("allows 5 filed requests an hour per user", async () => {
		for (let i = 0; i < 5; i++) expect(await post("u-ok", 201)).toBe(201);
		expect(await post("u-ok", 201)).toBe(429);
		expect(await post("u-other", 201)).toBe(201);
	});

	it("does not count refused attempts toward the limit", async () => {
		for (let i = 0; i < 6; i++)
			expect(await post("u-refused", 409)).toBe(409);
		expect(await post("u-refused", 201)).toBe(201);
	});
});
