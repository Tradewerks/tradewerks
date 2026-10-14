interface MapboxGeocodeResponse {
	features?: Array<{ center: [number, number] }>;
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
	const token = process.env.MAPBOX_TOKEN;
	if (!token) {
		console.error("Missing MAPBOX_TOKEN; cannot geocode address.");
		return null;
	}
	const url =
		`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json` +
		`?limit=1&access_token=${token}`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 8_000);
	try {
		const resp = await fetch(url, { signal: controller.signal });
		if (!resp.ok) return null;
		const data = (await resp.json()) as MapboxGeocodeResponse;
		const center = data.features?.[0]?.center;
		return center ? { lat: center[1], lon: center[0] } : null;
	} catch { return null; }
	finally { clearTimeout(timeoutId); }
}

// API callers (Zapier, agents) send an address without coords; the web app sends both.
// Fills parsed.coords in place when an address came in without coords. Returns an error
// message only when the address can't be located and the record requires coords.
export async function fillCoords(
	parsed: { address?: string | null; coords?: unknown },
	required: boolean,
): Promise<string | null> {
	if (!parsed.address || parsed.coords) return null;
	const coords = await geocodeAddress(parsed.address);
	if (coords) {
		parsed.coords = coords;
		return null;
	}
	return required ? `Validation failed: Could not find a location for address "${parsed.address}"` : null;
}
