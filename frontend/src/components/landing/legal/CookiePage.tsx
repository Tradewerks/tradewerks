import LegalLayout from "./LegalLayout";

export default function CookiePage() {
	return (
		<LegalLayout title="Cookie Policy">
			<div {...{ name: "termly-embed" }} data-id="fb84fa9b-bb35-434e-8b46-5a0281d8d752" />
			<script src="https://app.termly.io/embed-policy.min.js" async />
		</LegalLayout>
	);
}
