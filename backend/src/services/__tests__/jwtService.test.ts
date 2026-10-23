import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";

vi.hoisted(() => {
	process.env.JWT_ACCESS_SECRET = "test-access-secret";
});

import { generateAccessToken, verifyToken } from "../jwtService.js";
import { signQbOAuthState } from "../qb/qbOAuthState.js";

describe("jwtService verifyToken", () => {
	it("accepts a normal access token", () => {
		const token = generateAccessToken(
			{ id: "u1", organization_id: "org1", email: "a@b.c" },
			"dispatcher",
		);
		expect(verifyToken(token)).toMatchObject({ uid: "u1", organization_id: "org1" });
	});

	it("an OAuth state token is rejected as an access token", () => {
		expect(() => verifyToken(signQbOAuthState("org1", "u1"))).toThrow();
	});

	it("rejects any token carrying an audience claim", () => {
		const token = jwt.sign({ uid: "u1" }, process.env.JWT_ACCESS_SECRET!, {
			audience: "anything",
			expiresIn: "15m",
		});
		expect(() => verifyToken(token)).toThrow();
	});
});
