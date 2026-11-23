import i18n from "../i18n";
import { formatCurrency, formatDateTime, formatShortDate, formatTime } from "../util/util";
import type { TechnicianNotification } from "../types/notifications";

const t = i18n.t as unknown as (key: string, opts: Record<string, unknown>) => string;

/** Title and body in the technician's language. Rows without vars (older ones, dispatch messages) show as saved. */
export function notificationText(n: TechnicianNotification, tz: string): { title: string; body: string } {
	const v = n.vars;
	if (!v) return { title: n.title, body: n.body };
	const opts = {
		...v,
		at: v.at && formatDateTime(String(v.at), tz),
		day: v.day && formatShortDate(String(v.day), tz),
		due: v.due && formatTime(String(v.due), tz),
		eta: v.eta && formatTime(String(v.eta), tz),
		amount: typeof v.amount === "number" ? formatCurrency(v.amount) : v.amount,
	};
	const key = `notifications.types.${n.type}.${v.variant ?? "default"}`;
	const title = t(`${key}.title`, { ...opts, defaultValue: n.title });
	if (v.keep_body) return { title, body: n.body };
	let body = t(`${key}.body`, { ...opts, defaultValue: n.body });
	if (v.traffic_min) body += " " + t("notifications.types.traffic", { count: v.traffic_min, defaultValue: "" });
	return { title, body };
}
