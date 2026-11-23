import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/smsAccount";
import { socket } from "../lib/socket";
import type { DispatcherNotification } from "../types/notifications";
import { moduleQuery } from "./moduleQuery";

const useModuleQuery = moduleQuery("sms");
const SMS_ACCOUNT_KEY = ["sms-account"] as const;
const SETTINGS_KEY = ["customer-comms", "settings"] as const;
const PENDING: api.SmsAccountStatus[] = ["submitted", "brand_pending", "campaign_pending"];

export const useSmsAccount = (enabled = true) => {
	const qc = useQueryClient();

	// The poller notifies on every outcome; refresh the card and the Text switches.
	useEffect(() => {
		if (!enabled) return;
		const handler = (notif: DispatcherNotification) => {
			if (notif.type !== "sms_registration_update") return;
			qc.invalidateQueries({ queryKey: SMS_ACCOUNT_KEY });
			qc.invalidateQueries({ queryKey: SETTINGS_KEY });
		};
		socket.on("notification:new", handler);
		return () => {
			socket.off("notification:new", handler);
		};
	}, [enabled, qc]);

	return useModuleQuery({
		queryKey: SMS_ACCOUNT_KEY,
		queryFn: api.getSmsAccount,
		enabled,
		// Slow fallback for a missed socket event while the carriers decide.
		refetchInterval: (query: { state: { data?: api.SmsAccount } }) =>
			query.state.data && PENDING.includes(query.state.data.status)
				? 60_000
				: false,
	});
};

export const useSaveSmsRegistration = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.saveSmsRegistration,
		onSuccess: (acct) => qc.setQueryData(SMS_ACCOUNT_KEY, acct),
	});
};

export const useSubmitSmsRegistration = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.submitSmsRegistration,
		onSuccess: (acct) => {
			qc.setQueryData(SMS_ACCOUNT_KEY, acct);
			// sms_available on each message row follows the account status.
			qc.invalidateQueries({ queryKey: SETTINGS_KEY });
		},
	});
};
