// A throwaway credential for the Firebase account that backs a newly created user. NOBODY ever sees or
// types it: the person is sent a password-setup link and chooses their own password. It is generated from
// the platform CSPRNG (crypto.getRandomValues - never Math.random), is long, and must never be returned
// from an API, logged, or shown in the UI.
export function generateUnusedInitialPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // base64url, 43 chars, plus classes that satisfy common password policies
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "aA1!";
}
