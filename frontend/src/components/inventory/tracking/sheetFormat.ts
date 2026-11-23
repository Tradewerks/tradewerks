// Date formatter shared by the field-side tracking sheets (SerialSheet, LotSheet).
// Lives apart from the shared components so sheetShared.tsx only exports
// components (keeps React fast-refresh working for it).

import i18n from "../../../i18n";

export function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(i18n.language, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
