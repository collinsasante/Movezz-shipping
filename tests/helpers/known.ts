// Naming convention for known-wrong behavior (see docs/CHARACTERIZATION-BASELINE.md).
//
// Tests inside a `describe(KNOWN_BUG("..."))` block DOCUMENT CURRENT BEHAVIOR ONLY.
// They do not describe desired behavior. Each one names the future phase that
// must replace or invert it. Never "fix" production code just to make one pass.
export const KNOWN_BUG = (title: string) => `KNOWN BUG - ${title}`;
export const PRESERVE = (title: string) => `PRESERVE - ${title}`;

/** Standard reminder printed in every known-bug block. */
export const REPLACE_NOTE =
  "This test documents current behavior only. It must be replaced or inverted when the phase that fixes the underlying issue lands.";
