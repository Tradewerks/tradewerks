import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getBuffer, uploadFile } from "../wasabiService.js";

export interface StoredImportSource {
	url: string;
	key: string;
}

function remoteStorageConfigured(): boolean {
	return Boolean(process.env.WASABI_ACCESS && process.env.WASABI_SECRET && process.env.WASABI_BUCKET);
}

function localRoot(): string {
	return path.resolve(process.env.INVENTORY_IMPORT_STORAGE_DIR ?? path.join(process.cwd(), ".data", "inventory-imports"));
}

export async function storeImportSource(
	buffer: Buffer,
	mimeType: string,
	filename: string,
): Promise<StoredImportSource> {
	if (remoteStorageConfigured()) {
		const url = await uploadFile(buffer, mimeType, filename, "inventory-imports");
		return { url, key: url.split("?")[0] };
	}

	const extension = path.extname(filename).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 12);
	const key = `${randomUUID()}${extension}`;
	const root = localRoot();
	await mkdir(root, { recursive: true, mode: 0o700 });
	await writeFile(path.join(root, key), buffer, { flag: "wx", mode: 0o600 });
	return { url: `local-import://${key}`, key };
}

const LOCAL_PREFIX = "local-import://";

export const isLocalImportSource = (url: string): boolean => url.startsWith(LOCAL_PREFIX);

export async function loadImportSource(url: string, key: string): Promise<Buffer> {
	if (isLocalImportSource(url)) return readFile(path.join(localRoot(), key));
	return (await getBuffer(url)).buffer;
}

/** Removes a locally stored source; one that is already gone counts as removed. */
export async function deleteImportSource(url: string): Promise<void> {
	if (!isLocalImportSource(url)) throw new Error("not a local import source");
	// The key is a generated file name; refuse anything that could leave the root.
	const key = url.slice(LOCAL_PREFIX.length);
	if (!key || key !== path.basename(key)) throw new Error("invalid local import source");
	try {
		await unlink(path.join(localRoot(), key));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}
