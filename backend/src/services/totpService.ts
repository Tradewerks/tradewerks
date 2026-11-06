import crypto from "crypto";

const STEP = 30; // 30 seconds per code window
const DIGITS = 6; 
const WINDOW = 1; // allow 1 window grace period
function getKey(): Buffer {
    const keyHex = process.env.MFA_ENCRYPTION_KEY;
    if (!keyHex) {
        throw new Error("MFA_ENCRYPTION_KEY is not set in environment variables");
    }
    const keyBuffer = Buffer.from(keyHex, "hex");
    if (keyBuffer.length !== 32) {
        throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
    }
    return keyBuffer;
}
export const KEY = getKey();

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
    let encoded = "";
    let bits = 0;
    let bitlen = 0;
    
    for (let i = 0; i < buffer.length; i++) {
        bits = (bits << 8) | buffer[i];
        bitlen += 8;
        while (bitlen >= 5) {
            bitlen -= 5;
            const index = (bits >> bitlen) & 31;
            encoded += B32_ALPHABET[index];
        }
    }
    if (bitlen > 0) {
        const index = (bits << (5 - bitlen)) & 31;
        encoded += B32_ALPHABET[index];
    }
    while (encoded.length % 8 !== 0) { // padding
        encoded += "=";
    }
    return encoded;
}

function base32Decode(base32: string): Buffer {
    let decoded = [];
    let bits = 0;
    let bitlen = 0;
    for (let i = 0; i < base32.length; i++) {
        const char = base32[i];
        if (char === "=") break;
        const index = B32_ALPHABET.indexOf(char.toUpperCase());
        if (index === -1) throw new Error("Invalid base32 character");
        bits = (bits << 5) | index;
        bitlen += 5;
        if (bitlen >= 8) {
            bitlen -= 8;
            decoded.push((bits >> bitlen) & 255);
        }
    }
    return Buffer.from(decoded);
}

function counterToBuffer(counter: bigint): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(counter);
    return buffer;
}

function hmacSha1(key: Buffer, message: Buffer): Buffer {
    return crypto.createHmac("sha1", key).update(message).digest();
}

function hotp(secret: Buffer, counter: bigint): string {
    const mac = hmacSha1(secret, counterToBuffer(counter));
    const offset = mac[mac.length - 1] & 0xf;
    const truncated = Buffer.from(mac.subarray(offset, offset + 4));
    truncated[0] &= 0x7f; // remove the sign bit
    const code = truncated.readUInt32BE(0) % 10 ** DIGITS;
    return code.toString().padStart(DIGITS, "0");
}

export function generateSecret(): string {
    return base32Encode(crypto.randomBytes(20)).replace(/=+$/, ""); // 160 bits
}

export function buildOtpAuthUri(secret: string, email: string, orgName: string): string {
    const issuer = encodeURIComponent(orgName || "EpicIT");
    const account = encodeURIComponent(email);
    return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// Returns the matched time step so the caller can refuse a replay of the same code.
export function matchTotpStep(secret: string, token: string): number | null {
    if (!/^\d{6}$/.test(token)) return null;
    const key = base32Decode(secret);
    const current = Math.floor(Date.now() / 1000 / STEP);
    for (let w = -WINDOW; w <= WINDOW; w++) {
        const step = current + w;
        if (crypto.timingSafeEqual(Buffer.from(hotp(key, BigInt(step))), Buffer.from(token))) {
            return step;
        }
    }
    return null;
}

/*export function encryptSecret(secret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
    const encrypted = cipher.update(secret, "utf8");
    cipher.final();
    const tag = cipher.getAuthTag();
    return [iv, tag, encrypted].map((b) => b.toString('hex')).join(':'); // iv:tag:encrypted
}

export function decryptSecret(encrypted: string): string {
    const [ivHex, tagHex, encryptedHex] = encrypted.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encryptedBuffer = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = decipher.update(encryptedBuffer, undefined, 'utf8');
    decipher.final();
    return decrypted;
}*/

export function generateRecoveryCodes(): { codes: string[], hashed_codes: string[] } {
    const codes: string[] = [];
    const hashed_codes: string[] = [];
    for (let i = 0; i < 10; i++) {
        const code = crypto.randomBytes(4).toString('hex');
        codes.push(code);
        hashed_codes.push(hashRecoveryCode(code));
    }
    return { codes, hashed_codes };
}

export function hashRecoveryCode(code: string): string {
    const normalized = code.trim().toLowerCase().replace(/[\s-]/g, "");
    return crypto.createHash("sha256").update(normalized).digest("hex");
}