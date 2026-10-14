// Gets the user's current location and returns null if it cannot be retrieved from the user
export function getDeviceCoords(): Promise<{ lat: number; lon: number } | null> {
	return new Promise((resolve) => {
		if (typeof navigator === "undefined" || !navigator.geolocation) {
			resolve(null);
			return;
		}
		navigator.geolocation.getCurrentPosition(
			(pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
			() => resolve(null),
			{ timeout: 5_000, maximumAge: 60_000 },
		);
	});
}
