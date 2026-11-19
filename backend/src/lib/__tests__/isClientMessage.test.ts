import { describe, it, expect } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { isClientMessage } from "../../types/responses.js";

describe("isClientMessage", () => {
	it("passes our own thrown messages through", () => {
		expect(isClientMessage(new Error("Client not found"))).toBe(true);
	});

	it("keeps Prisma's errors away from the client", () => {
		const known = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
			code: "P2002",
			clientVersion: "7",
		});
		const validation = new Prisma.PrismaClientValidationError("Invalid `prisma.quote.create()`", {
			clientVersion: "7",
		});
		expect(isClientMessage(known)).toBe(false);
		expect(isClientMessage(validation)).toBe(false);
	});

	it("ignores things that aren't errors", () => {
		expect(isClientMessage("oops")).toBe(false);
	});
});
