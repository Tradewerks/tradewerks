import LegalLayout from "./LegalLayout";
import { LEGAL } from "./legal";

const { company, entity, privacyEmail } = LEGAL;

// Keep in step with the processors the backend actually calls (backend/.env.example).
const PROCESSORS = [
	["Cloud hosting and database", "Running the application and storing records"],
	["Wasabi", "Storing uploaded files such as visit photos, receipts and attachments"],
	["Postmark", "Sending account, quote, invoice and follow-up emails"],
	["Mapbox", "Maps, address search and drive-distance calculations"],
	["OpenAI", "Powering the AI assistant and AI-assisted inventory import"],
	["Mindee", "Reading totals and line items from receipt photos"],
	["Grafana Cloud", "Application logs and performance monitoring"],
	["Google and Microsoft", "Single sign-on, when you choose to use it"],
	["Intuit QuickBooks", "Accounting sync, when your organization connects it"],
];

export default function PrivacyPage() {
	return (
		<LegalLayout title="Privacy Policy">
			<p>
				This Privacy Policy explains how {entity} ("{company}", "we", "us")
				collects, uses and shares personal information through our website and our
				field service platform (the "Service"). It applies to visitors to our
				website, to the businesses that subscribe to the Service ("Customers"), and
				to their dispatchers, technicians and other users.
			</p>

			<h2>Our role</h2>
			<p>
				Customers use {company} to manage their own clients, sites and jobs. For
				that information (for example, a homeowner's name, address and service
				history) the Customer decides what is collected and why, and we process it
				on the Customer's behalf and under its instructions. If you are a client of
				a business that uses {company}, please contact that business about your
				information; we will help it respond. For account, billing and website
				information, we decide how it is used, as described below.
			</p>

			<h2>Information we collect</h2>
			<h3>Information you give us</h3>
			<ul>
				<li>
					<strong>Account information:</strong> name, email address, phone
					number, role, password (stored only as a salted hash) and
					multi-factor authentication settings.
				</li>
				<li>
					<strong>Organization and billing information:</strong> company name,
					address, logo, tax settings and billing contacts.
				</li>
				<li>
					<strong>Customer Data:</strong> clients, contacts, site addresses,
					requests, quotes, jobs, visits, notes, photos, receipts, inventory,
					purchases and invoices that users enter or upload.
				</li>
				<li>
					<strong>Messages to us:</strong> demo requests, support emails and
					feedback.
				</li>
				<li>
					<strong>Assistant conversations:</strong> the prompts users send to the
					AI assistant and its responses, kept so the conversation can continue
					and so actions it proposes can be reviewed.
				</li>
			</ul>

			<h3>Information collected as the Service is used</h3>
			<ul>
				<li>
					<strong>Technician activity and location:</strong> when a technician
					clocks in, updates a visit status or photographs a receipt, the
					Service records the time and, if the device grants permission, the
					device's location at that moment. It is used for timesheets, mileage
					logs, purchase records and showing visit progress to dispatchers. We do not track location in the
					background between those actions.
				</li>
				<li>
					<strong>Usage and device information:</strong> IP address, browser and
					device type, pages and features used, and error logs, collected to
					keep the Service secure and working.
				</li>
				<li>
					<strong>Email events:</strong> whether emails sent through the Service
					were delivered, opened or bounced, so follow-ups can stop once a client
					has responded.
				</li>
			</ul>

			<h3>Information from third parties</h3>
			<p>
				If you sign in with Google or Microsoft, we receive your name, email address
				and account identifier from that provider. If your organization connects
				QuickBooks, we exchange customer, item, invoice and payment records with it.
			</p>

			<h2>How we use information</h2>
			<ul>
				<li>To provide, maintain and support the Service.</li>
				<li>
					To authenticate users, prevent fraud and abuse, and secure accounts.
				</li>
				<li>
					To send service messages such as verification codes, password resets,
					alerts and billing notices.
				</li>
				<li>
					To send emails that Customers ask the Service to send on their behalf,
					such as quotes, invoices and follow-ups.
				</li>
				<li>
					To understand how the Service is used and improve it, using aggregated
					or de-identified information where practical.
				</li>
				<li>
					To reply to demo requests and, where permitted, tell you about products
					and features. You can opt out of marketing email at any time.
				</li>
				<li>To comply with law and enforce our Terms.</li>
			</ul>
			<p>
				We do not sell personal information, share it for cross-context behavioral
				advertising, or use Customer Data to train general-purpose AI models.
			</p>

			<h2>How we share information</h2>
			<p>
				We share personal information only with service providers that help us run
				the Service, under contracts that limit their use of it to providing their
				services to us:
			</p>
			<ul>
				{PROCESSORS.map(([name, purpose]) => (
					<li key={name}>
						<strong>{name}:</strong> {purpose}
					</li>
				))}
			</ul>
			<p>
				We may also share information within a Customer's organization according
				to the roles and permissions it sets, with integrations a Customer chooses
				to connect, with a successor in a merger or acquisition, and when required
				by law or needed to protect the rights, safety or property of anyone.
			</p>

			<h2>Cookies and local storage</h2>
			<p>
				The Service stores sign-in tokens and display preferences in your browser's
				local storage so you stay signed in and your views are remembered. We do not
				use advertising cookies or third-party ad trackers. Our website loads fonts
				from Google Fonts, which receives your IP address when your browser fetches
				them.
			</p>

			<h2>Retention</h2>
			<p>
				We keep Customer Data for as long as the Customer's subscription is active
				and for 30 days afterwards so it can be exported, then delete it from active
				systems and from backups on their normal rotation. Logs are kept for a
				limited period for security and troubleshooting. We keep billing records as
				long as tax and accounting laws require.
			</p>

			<h2>Security</h2>
			<p>
				We protect information with encryption in transit, encrypted storage of
				sensitive secrets, role-based access controls, audit logging and support for
				multi-factor authentication. No system is perfectly secure; if we learn of a
				breach affecting your information, we will notify affected Customers as the
				law requires.
			</p>

			<h2>Your choices and rights</h2>
			<p>
				You can review and update your profile in the Service at any time.
				Depending on where you live, you may have the right to access, correct,
				delete or receive a copy of your personal information, and to object to or
				limit certain processing. To make a request, email{" "}
				<a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>. If your information
				is held on behalf of a Customer, we will pass your request to that
				Customer. We will not discriminate against you for exercising these rights.
				Technicians can decline location permission on their device; the Service
				still works, without location on those events.
			</p>

			<h2>Children</h2>
			<p>
				The Service is for businesses and is not directed to children under 16. We
				do not knowingly collect their personal information.
			</p>

			<h2>International transfers</h2>
			<p>
				We and our service providers operate primarily in the United States. If you
				use the Service from elsewhere, your information will be transferred to and
				processed in the United States.
			</p>

			<h2>Changes to this policy</h2>
			<p>
				We may update this policy from time to time. We will post the new version
				here with a new effective date and, for material changes, notify account
				administrators before they take effect.
			</p>

			<h2>Contact</h2>
			<p>
				Questions or requests about privacy can be sent to{" "}
				<a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>.
			</p>
		</LegalLayout>
	);
}
