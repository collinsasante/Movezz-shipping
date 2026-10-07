// ============================================================
// PASSWORD POLICY — shared by the signup/activation UI and the server.
// Firebase stores and checks the password; this only decides what we accept.
// ============================================================

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES: { id: string; label: string; test: (p: string) => boolean }[] = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { id: "letter", label: "At least one letter", test: (p) => /[A-Za-z]/.test(p) },
  { id: "number", label: "At least one number", test: (p) => /\d/.test(p) },
];

/** Returns a user-facing error, or null when the password is acceptable. */
export function passwordPolicyError(password: string): string | null {
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  const failed = PASSWORD_RULES.find((r) => !r.test(password));
  return failed ? `Password needs: ${failed.label.toLowerCase()}` : null;
}
