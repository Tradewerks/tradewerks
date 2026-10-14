import { useState } from "react";
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

	if (asked) {
		return <p className="text-xs text-text-muted">Dispatch has been asked to enable it.</p>;
	}

	return (
		<button
			type="button"
			disabled={requestGrant.isPending}
			onClick={async () => {
				try {
					await requestGrant.mutateAsync();
					setAsked(true);
					toast.success("Dispatch has been asked to enable it");
				} catch (err) {
					toast.error(errorMessage(err, "Could not send the request"));
				}
			}}
			className={
				className ??
				"inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-40"
			}
		>
			Ask dispatch to enable it
		</button>
	);
}
