/**
 * Lazily-constructed OpenAI client.
 *
 * Lazy because the key is optional: a deployment without OPENAI_API_KEY should
 * boot normally with the assistant switched off, not crash on import.
 */

import OpenAI from "openai";

let client: OpenAI | null = null;

export class AssistantNotConfiguredError extends Error {
	constructor() {
		super("OPENAI_API_KEY is not set");
		this.name = "AssistantNotConfiguredError";
	}
}

export function getOpenAI(): OpenAI {
	if (!process.env.OPENAI_API_KEY) throw new AssistantNotConfiguredError();
	if (!client) {
		client = new OpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			// Set OPENAI_BASE_URL to point at Azure OpenAI or a compatible gateway.
			...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
			maxRetries: 2,
		});
	}
	return client;
}

/** Test seam. */
export function __setOpenAI(stub: OpenAI | null): void {
	client = stub;
}
