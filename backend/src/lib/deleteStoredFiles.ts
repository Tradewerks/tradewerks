import { deleteFile } from "../services/wasabiService.js";
import { log } from "../services/appLogger.js";

/**
 * Best-effort storage cleanup, run after the DB change commits: a failure is
 * logged, never thrown, so it can't fail a request whose rows are already gone.
 */
export const deleteStoredFiles = (urls: readonly string[], context: Record<string, unknown>) => {
	for (const url of urls) {
		deleteFile(url).catch((err) =>
			log.warn({ err, url, ...context }, "Failed to delete file from storage"),
		);
	}
};
