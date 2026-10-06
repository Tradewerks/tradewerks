import { db } from "../db.js";
import { log } from "./appLogger.js";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; active: boolean }>();

export function setUserActive(uid: string, active: boolean): void {
	cache.set(uid, { at: Date.now(), active });
}

export async function isUserActive(
	uid: string,
	role: string,
): Promise<boolean> {
	const hit = cache.get(uid);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.active;
	try {
		const row =
			role === "technician"
				? await db.technician.findUnique({
						where: { id: uid },
						select: { deactivated_at: true },
					})
				: await db.dispatcher.findUnique({
						where: { id: uid },
						select: { deactivated_at: true },
					});
		const active = !!row && row.deactivated_at === null;
		cache.set(uid, { at: Date.now(), active });
		return active;
	} catch (err) {
		// A DB blip must not sign the whole org out (every 401 ends in a logout).
		log.warn(
			{ err, uid },
			"active-user check failed; using last known state",
		);
		return hit?.active ?? true;
	}
}
