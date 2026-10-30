import { describe, it, expect, beforeAll } from "vitest";
import jwt from "jsonwebtoken";
import { signQbOAuthState, verifyQbOAuthState } from "../qb/qbOAuthState.js";

beforeAll(() => {
	process.env.JWT_ACCESS_SECRET = "test-access-secret";
});

describe("qbOAuthState", () => {
	it("round-trips org and user", () => {
		expect(verifyQbOAuthState(signQbOAuthState("org1", "u1"))).toEqual({
			orgId: "org1",
			userId: "u1",
		});
	});

	it("rejects a bare org id", () => {
		expect(verifyQbOAuthState("org1")).toBeNull();
	});

	it("rejects after 10 minutes", () => {
		const t = new Date();
		const state = signQbOAuthState("org1", "u1", t);
		expect(verifyQbOAuthState(state, new Date(t.getTime() + 601_000))).toBeNull();
		expect(verifyQbOAuthState(state, new Date(t.getTime() + 599_000))).not.toBeNull();
	});

	it("rejects a tampered payload", () => {
		const [h, p, s] = signQbOAuthState("org1", "u1").split(".");
		const flipped = (p[5] === "A" ? "B" : "A");
		const tampered = [h, p.slice(0, 5) + flipped + p.slice(6), s].join(".");
		expect(verifyQbOAuthState(tampered)).toBeNull();
	});

	it("rejects a token signed for another audience", () => {
		const access = jwt.sign(
			{ uid: "u1", organization_id: "org1", org: "org1" },
			process.env.JWT_ACCESS_SECRET!,
			{ expiresIn: "15m" },
		);
		expect(verifyQbOAuthState(access)).toBeNull();
	});
});
