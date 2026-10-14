// The rules the register and reset pages already enforced inline; the backend checks length only.
export function passwordProblem(password: string, confirm: string): string | null {
	if (password !== confirm) return "Passwords do not match.";
	if (password.length < 8) return "Password must be at least 8 characters.";
	if (!/[A-Z]/.test(password)) return "Password must contain at least one capital letter.";
	if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
	if (!/[^A-Za-z0-9]/.test(password)) return "Password must contain at least one special character.";
	return null;
}
