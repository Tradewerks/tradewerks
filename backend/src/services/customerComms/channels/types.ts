import type { Channel } from "../../consentService.js";

export type { Channel };

export interface ChannelAdapter {
	channel: Channel;
	send(msg: {
		orgId: string;
		to: string;
		subject?: string;
		html?: string;
		text: string;
		messageRowId: string;
		// Provider headers such as List-Unsubscribe, built by the caller so they
		// carry the same link as the rendered body.
		headers?: { Name: string; Value: string }[];
	}): Promise<{ providerMessageId: string | null; segments?: number }>;
	// throws SendRejected (definitely not sent, retryable or not) — any other throw means outcome unknown
}

/** The provider definitely did not accept the message. */
export class SendRejected extends Error {
	constructor(
		message: string,
		public retryable: boolean,
	) {
		super(message);
		this.name = "SendRejected";
	}
}
