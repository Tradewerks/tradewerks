import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRequestGrant } from "../../../hooks/useFieldPurchases";
import { useToast } from "../../ui/useToast";
import { errorMessage } from "../../../util/util";

/**
 * The way out for a technician who holds `request_field_purchase` but no active
 * grant. Two surfaces reach that state — the visit and the purchases list — and
 * both need a button to press, not just a sentence saying no.
 *
 * Layout stays with the caller; only the asking is shared.
 */
export default function AskForAccessButton({ className }: { className?: string }) {
	const [asked, setAsked] = useState(false);
	const requestGrant = useRequestGrant();
	const toast = useToast();
	const { t } = useTranslation();

	if (asked) {
		return <p className="text-xs text-text-muted">{t("procure.asked")}</p>;
	}

	return (
		<button
			type="button"
			disabled={requestGrant.isPending}
			onClick={async () => {
				try {
					await requestGrant.mutateAsync();
					setAsked(true);
					toast.success(t("procure.askedToast"));
				} catch (err) {
					toast.error(errorMessage(err, t("purchase.sendFailed")));
				}
			}}
			className={
				className ??
				"inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-40"
			}
		>
			{t("procure.askAccess")}
		</button>
	);
}
