// The one spelling of "no location" across the app — not "None", "N/A", or an
// em dash. Exported bare for surfaces that need a string rather than a node.
export const UNASSIGNED_LOCATION = "Unassigned";

export default function LocationValue({ location }: { location: string | null }) {
	return location ?? <span className="text-text-muted">{UNASSIGNED_LOCATION}</span>;
}
