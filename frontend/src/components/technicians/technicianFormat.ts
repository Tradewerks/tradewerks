import type { VisitTechnician } from "../../types/technicians";

export function capitalizeWords(str: string) {
	return str.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export function formatLastLogin(raw: unknown, now: number = Date.now()) {
	if (!raw) return "Never";
	const d = raw instanceof Date ? raw : new Date(String(raw));
	if (isNaN(d.getTime())) return "Never";

	const diffMins = Math.floor((now - d.getTime()) / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 5) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function initials(name: string) {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	const first = parts[0][0] ?? "";
	const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
	return (first + last).toUpperCase();
}

export function formatTime(value: Date | string) {
	return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function visitLabel(vt: VisitTechnician) {
	return (
		[vt.visit.job?.name, vt.visit.job?.client?.name].filter(Boolean).join(" · ") ||
		"Visit"
	);
}

export function formatAbsolute(raw: unknown): string {
	if (!raw) return "Never";
	const d = raw instanceof Date ? raw : new Date(String(raw));
	if (isNaN(d.getTime())) return "Never";
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

// Only reshapes digit strings the formatter fully understands; anything else
// (international, extensions) is shown as entered rather than mangled.
export function formatPhone(value: string | null | undefined): string | null {
	if (!value) return null;
	const digits = value.replace(/\D/g, "");
	if (digits.length === 10)
		return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
	if (digits.length === 11 && digits.startsWith("1"))
		return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
	return value;
}

export function formatHireDate(hireDate: Date | string): string {
	return new Date(hireDate).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function formatTenure(hireDate: Date | string, now: Date = new Date()): string {
	const hired = new Date(hireDate);
	let years = now.getFullYear() - hired.getFullYear();
	const anniversaryPassed =
		now.getMonth() > hired.getMonth() ||
		(now.getMonth() === hired.getMonth() && now.getDate() >= hired.getDate());
	if (!anniversaryPassed) years -= 1;
	if (years < 1) return "< 1 yr";
	return years === 1 ? "1 yr" : `${years} yrs`;
}

/**
 * "2021 Ford Transit", falling back to the freetext type ("Van") when no
 * year/make/model was recorded — the embedded current_vehicle carries only type.
 */
export function vehicleSpec(v: {
	type: string;
	year?: number | null;
	make?: string | null;
	model?: string | null;
}): string {
	const spec = [v.year, v.make, v.model].filter(Boolean).join(" ");
	return spec || (v.type ? capitalizeWords(v.type) : "");
}
