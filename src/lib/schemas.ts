// Shared request-body schemas (kept out of route files: Next.js route modules may only export HTTP handlers).
import { z } from "zod";

/** A named special rate: non-negative, bounded USD rates; unknown keys are rejected. */
export const SpecialRateSchema = z
  .object({
    name: z.string().trim().min(1, "Rate name is required").max(100),
    sea: z.coerce.number().finite().min(0).max(100_000).default(0),
    air: z.coerce.number().finite().min(0).max(100_000).default(0),
  })
  .strict();

const TierRates = z
  .object({
    sea: z.number().finite().min(0).max(100_000),
    air: z.number().finite().min(0).max(100_000),
  })
  .strict();

/** Exactly the four known package tiers; anything else is rejected. */
export const PackageRatesSchema = z
  .object({ basic: TierRates, business: TierRates, enterprise: TierRates, special: TierRates })
  .strict();
