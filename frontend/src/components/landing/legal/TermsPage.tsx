import LegalLayout from "./LegalLayout";
import { LEGAL } from "./legal";

const { company, entity, governingState, legalEmail } = LEGAL;

export default function TermsPage() {
	return (
		<LegalLayout title="Terms of Service">
			<p>
				These Terms of Service ("Terms") govern access to and use of the {company}{" "}
				field service platform, including the web application, technician mobile
				experience, AI assistant, integrations and related services (the "Service"),
				provided by {entity} ("{company}", "we", "us"). By creating an account,
				signing an order form, or using the Service, you agree to these Terms. If you
				accept on behalf of a company, you represent that you have authority to bind
				it, and "you" or "Customer" means that company.
			</p>

			<h2>1. Accounts and users</h2>
			<p>
				You must provide accurate registration information and keep it current. You
				may invite dispatchers, technicians and other users ("Authorized Users") to
				your organization and assign their roles and permissions. You are responsible
				for all activity under your organization's accounts, for your Authorized
				Users' compliance with these Terms, and for keeping credentials, single
				sign-on accounts and multi-factor devices secure. Tell us promptly at{" "}
				<a href={`mailto:${legalEmail}`}>{legalEmail}</a> if you suspect
				unauthorized access.
			</p>

			<h2>2. Using the Service</h2>
			<p>
				Subject to these Terms and payment of applicable fees, we grant you a
				non-exclusive, non-transferable right during your subscription term for your
				Authorized Users to use the Service for your internal business operations.
				You agree not to:
			</p>
			<ul>
				<li>
					resell, sublicense or provide the Service to third parties as a service
					bureau;
				</li>
				<li>
					reverse engineer, decompile or attempt to extract source code, except
					where applicable law forbids this restriction;
				</li>
				<li>
					access the Service to build a competing product, or scrape or bulk
					export it by automated means other than the features and APIs we
					provide;
				</li>
				<li>
					probe, scan or test the Service's security, or interfere with its
					operation or other customers' use;
				</li>
				<li>
					upload malware, or content that is unlawful, infringing, or that you
					lack the right to share;
				</li>
				<li>
					use the Service to send unsolicited or unlawful email, or to track
					individuals without the notice and consent the law requires.
				</li>
			</ul>

			<h2>3. Your data</h2>
			<p>
				"Customer Data" means the information you and your Authorized Users put into
				the Service, including client and contact records, site addresses, requests,
				quotes, jobs, visits, notes, photos, receipts, inventory and financial
				records. You retain all rights to Customer Data. You grant us a limited
				license to host, process, transmit and display Customer Data only as needed to
				provide, secure and support the Service, and as described in our{" "}
				<a href="/privacy">Privacy Policy</a>.
			</p>
			<p>
				You are responsible for the accuracy and lawfulness of Customer Data and for
				having the notices and consents needed to give it to us, including consent
				from your own clients to receive emails you send through the Service and
				notice to your technicians that the Service records their shift times and
				visit locations.
			</p>

			<h2>4. AI assistant and automated features</h2>
			<p>
				The Service includes an AI assistant and automated features such as
				receipt reading, inventory import and client follow-up emails. Their output
				is generated automatically and may be incomplete or wrong. Review it before
				relying on it. The assistant proposes drafts and asks for approval before
				scheduling or changing records on your behalf; you are responsible for the
				actions you approve and for any emails, quotes or invoices sent from your
				account. We do not use Customer Data to train our own or third-party
				general-purpose AI models.
			</p>

			<h2>5. Third-party services</h2>
			<p>
				The Service can connect to third-party products you choose to use, such as
				QuickBooks, Google or Microsoft sign-in, and mapping services. Your use of
				those products is governed by their own terms. When you enable an
				integration, you authorize us to exchange Customer Data with it as needed to
				operate the integration. We are not responsible for third-party products or
				for changes they make that affect an integration.
			</p>

			<h2>6. Fees and payment</h2>
			<p>
				Fees, billing frequency and the number of users or other usage limits are
				set out in your order form or the plan you select. Unless stated otherwise,
				fees are billed in advance, are non-refundable, and exclude taxes, which you
				are responsible for (other than taxes on our income). We may suspend the
				Service if an undisputed amount is more than 30 days overdue after we give
				you notice. We may change fees for a renewal term by giving at least 30 days'
				notice before it starts.
			</p>

			<h2>7. Availability and support</h2>
			<p>
				We work to keep the Service available and to fix problems promptly, but we do
				not guarantee uninterrupted or error-free operation. We may perform scheduled
				maintenance and will try to do so outside normal business hours. We may
				update or improve the Service over time; if we remove a material feature you
				rely on, we will give reasonable notice.
			</p>

			<h2>8. Confidentiality and security</h2>
			<p>
				Each party will protect the other's non-public business information with at
				least reasonable care and use it only to perform under these Terms. We
				maintain administrative, technical and physical safeguards designed to
				protect Customer Data, including encryption in transit, role-based access
				controls and multi-factor authentication support.
			</p>

			<h2>9. Our intellectual property and feedback</h2>
			<p>
				We own the Service, its software, design and documentation, and all
				improvements to them. Except for the rights expressly granted here, no rights
				are transferred to you. If you send us suggestions or feedback, we may use
				them without obligation to you.
			</p>

			<h2>10. Term, cancellation and data export</h2>
			<p>
				These Terms apply for as long as you use the Service. Your subscription
				renews for successive terms of the same length unless either party cancels
				before the renewal date. Either party may terminate for the other's material
				breach that remains uncured 30 days after written notice. We may suspend
				access immediately if needed to prevent harm to the Service, other customers
				or the public.
			</p>
			<p>
				For 30 days after your subscription ends, you may export Customer Data using
				the Service's export features or by asking us. After that period we delete
				Customer Data from our active systems, and from backups on their normal
				rotation, unless the law requires us to keep it.
			</p>

			<h2>11. Warranties and disclaimers</h2>
			<p>
				Each party represents that it has the authority to enter these Terms. EXCEPT
				AS EXPRESSLY STATED IN THESE TERMS, THE SERVICE IS PROVIDED "AS IS" AND "AS
				AVAILABLE", AND WE DISCLAIM ALL OTHER WARRANTIES, EXPRESS OR IMPLIED,
				INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
				NON-INFRINGEMENT. The Service is a business tool; it does not provide
				accounting, tax, legal or safety advice, and you remain responsible for your
				pricing, invoices, tax filings and the work your technicians perform.
			</p>

			<h2>12. Limitation of liability</h2>
			<p>
				TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR ANY
				INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR LOST
				PROFITS, REVENUE OR DATA, EVEN IF ADVISED OF THEIR POSSIBILITY. EACH PARTY'S
				TOTAL LIABILITY ARISING OUT OF THESE TERMS WILL NOT EXCEED THE FEES YOU PAID
				TO US IN THE 12 MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM. These
				limits do not apply to your payment obligations, a party's indemnification
				obligations, or liability that cannot be limited by law.
			</p>

			<h2>13. Indemnification</h2>
			<p>
				We will defend you against third-party claims that the Service, as we provide
				it, infringes their intellectual property rights, and pay resulting damages
				finally awarded. You will defend us against third-party claims arising from
				Customer Data or from your or your Authorized Users' use of the Service in
				violation of these Terms or the law, and pay resulting damages finally
				awarded. The indemnified party must give prompt notice, reasonable
				cooperation, and control of the defense to the indemnifying party.
			</p>

			<h2>14. General</h2>
			<p>
				These Terms are governed by the laws of {governingState}, without regard to
				its conflict-of-laws rules, and the state and federal courts located there
				have exclusive jurisdiction. Neither party may assign these Terms without the
				other's consent, except to a successor in a merger or sale of substantially
				all of its business. Neither party is liable for delays caused by events
				beyond its reasonable control. If any provision is unenforceable, the rest
				remain in effect. These Terms, together with any order form, are the entire
				agreement between the parties on this subject; if they conflict, the order
				form controls.
			</p>

			<h2>15. Changes to these Terms</h2>
			<p>
				We may update these Terms from time to time. We will post the new version
				here with a new effective date and, for material changes, notify account
				administrators by email or in the Service at least 30 days before they take
				effect. Continuing to use the Service after that date means you accept the
				updated Terms.
			</p>

			<h2>16. Contact</h2>
			<p>
				Questions about these Terms can be sent to{" "}
				<a href={`mailto:${legalEmail}`}>{legalEmail}</a>.
			</p>
		</LegalLayout>
	);
}
