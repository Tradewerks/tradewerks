import type { Channel, ChannelAdapter } from "./types.js";
import { emailChannel } from "./emailChannel.js";
import { smsChannel } from "./smsChannel.js";

const ADAPTERS: Partial<Record<Channel, ChannelAdapter>> = {
	email: emailChannel,
	sms: smsChannel,
};

export function getChannelAdapter(channel: string): ChannelAdapter | null {
	return ADAPTERS[channel as Channel] ?? null;
}

/** Channels customerNotify may queue for, in a stable order. */
export function registeredChannels(): Channel[] {
	return (["email", "sms"] as const).filter((c) => ADAPTERS[c]);
}
