import crypto from "node:crypto";

// Independent RFC 6238 implementation so tests do not grade the TOTP code with itself.
export function totpCodeAt(secret: string, step: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const ch of secret) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
	const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(step));
	const mac = crypto.createHmac("sha1", key).update(msg).digest();
	const o = mac[mac.length - 1] & 0xf;
	return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export const currentTotpStep = () => Math.floor(Date.now() / 1000 / 30);
