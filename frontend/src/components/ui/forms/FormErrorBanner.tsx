interface FormErrorBannerProps {
	message: string | null | undefined;
	className?: string;
}

/**
 * Submit-failure banner for modal forms. Pair with `errorMessage()` from util —
 * a raw AxiosError.message is only "Request failed with status code 400" and
 * never carries the API's worded refusal.
 */
export function FormErrorBanner({ message, className = "" }: FormErrorBannerProps) {
	if (!message) return null;

	return (
		<div
			role="alert"
			className={`rounded border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text ${className}`}
		>
			{message}
		</div>
	);
}

export default FormErrorBanner;
