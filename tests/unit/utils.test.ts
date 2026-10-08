// Characterization of src/lib/utils.ts: shipping marks, reference formats, status order, helpers.
import { describe, it, expect } from "vitest";
import {
  generateShippingMark,
  generateShippingAddress,
  generateItemRef,
  generateOrderRef,
  generateContainerId,
  generateSupplierId,
  generateCartonRef,
  ITEM_STATUS_STEPS,
  getStatusStepIndex,
  normalizePhoneNumber,
  buildWhatsAppMessage,
  formatCurrency,
} from "@/lib/utils";
import { KNOWN_BUG, PRESERVE } from "../helpers/known";

describe(PRESERVE("generateShippingMark: MOVEZZ-{first initial}{second-word initial}{last 4 phone digits}"), () => {
  it("builds the mark from the first two WORDS of the name and the last 4 phone digits", () => {
    expect(generateShippingMark("Ada Mensah", "0244001234")).toBe("MOVEZZ-AM1234");
  });
  it("upper-cases initials from lower-case or mixed-case names", () => {
    expect(generateShippingMark("kofi boateng", "0200005678")).toBe("MOVEZZ-KB5678");
    expect(generateShippingMark("kOFI bOATENG", "0200005678")).toBe("MOVEZZ-KB5678");
  });
  it("uses X for a missing second word (single-word name)", () => {
    expect(generateShippingMark("Kwame", "0244001234")).toBe("MOVEZZ-KX1234");
  });
  it("uses X X for an empty name", () => {
    expect(generateShippingMark("", "0244001234")).toBe("MOVEZZ-XX1234");
    expect(generateShippingMark("   ", "0244001234")).toBe("MOVEZZ-XX1234");
  });
  it("collapses runs of spaces and trims", () => {
    expect(generateShippingMark("  Ada    Mensah  ", "0244001234")).toBe("MOVEZZ-AM1234");
  });
  it("uses the SECOND word as the 'last' initial, not the last word (middle names change the mark)", () => {
    expect(generateShippingMark("Ada Esi Mensah", "0244001234")).toBe("MOVEZZ-AE1234");
  });
  it("strips punctuation inside a word before taking the initial", () => {
    expect(generateShippingMark("O'Brien Jane", "0244001234")).toBe("MOVEZZ-OJ1234");
    expect(generateShippingMark("-Ada Mensah", "0244001234")).toBe("MOVEZZ-AM1234");
  });
  it("takes the last 4 DIGITS of any phone format", () => {
    expect(generateShippingMark("Ada Mensah", "+233 24 400 1234")).toBe("MOVEZZ-AM1234");
    expect(generateShippingMark("Ada Mensah", "(024) 400-1234")).toBe("MOVEZZ-AM1234");
    expect(generateShippingMark("Ada Mensah", "+1 415 555 2671")).toBe("MOVEZZ-AM2671");
  });
  it("uses fewer than 4 digits when the phone has fewer than 4 digits, and none when it has no digits", () => {
    expect(generateShippingMark("Ada Mensah", "12")).toBe("MOVEZZ-AM12");
    expect(generateShippingMark("Ada Mensah", "n/a")).toBe("MOVEZZ-AM");
  });
});

describe(PRESERVE("the pure shipping-mark generator is NOT unique by itself"), () => {
  // Uniqueness is enforced by customersApi (numeric suffix on collision) - see references.test.ts (FIXED).
  it("documents that two different people can generate an identical base mark", () => {
    const a = generateShippingMark("Ada Mensah", "0244001234");
    const b = generateShippingMark("Alice Mills", "0200001234");
    expect(a).toBe(b);
    expect(a).toBe("MOVEZZ-AM1234");
  });
  it("documents that accents/non-ASCII letters are silently dropped (initial becomes the next ASCII letter)", () => {
    expect(generateShippingMark("Ési Mensah", "0244001234")).toBe("MOVEZZ-SM1234");
    expect(generateShippingMark("Ñandú Mensah", "0244001234")).toBe("MOVEZZ-AM1234");
  });
  it("documents that a name with no ASCII letters falls back to X", () => {
    expect(generateShippingMark("张伟 李", "0244001234")).toBe("MOVEZZ-XX1234");
  });
});

describe(PRESERVE("generateShippingAddress"), () => {
  it("embeds the mark in the fixed warehouse address", () => {
    expect(generateShippingAddress("MOVEZZ-AM1234")).toBe(
      "MOVEZZ-AM1234, A-Z Bulk Warehouse, Amrahia, Adenta-Dodowa Road"
    );
  });
});

describe(PRESERVE("reference formats"), () => {
  it("ITM-0001 (4 digits)", () => {
    expect(generateItemRef(1)).toBe("ITM-0001");
    expect(generateItemRef(42)).toBe("ITM-0042");
  });
  it("ORD-00001 (5 digits)", () => {
    expect(generateOrderRef(1)).toBe("ORD-00001");
  });
  it("SUP-0001 (4 digits)", () => {
    expect(generateSupplierId(7)).toBe("SUP-0007");
  });
  it("CTN-0001 (4 digits)", () => {
    expect(generateCartonRef(12)).toBe("CTN-0012");
  });
  it("PMX-CON-{current year}-001 (3 digits, year taken from the clock)", () => {
    const year = new Date().getFullYear();
    expect(generateContainerId(1)).toBe(`PMX-CON-${year}-001`);
    expect(generateContainerId(37)).toBe(`PMX-CON-${year}-037`);
  });
  it("grows past the padded width without truncating", () => {
    expect(generateItemRef(10000)).toBe("ITM-10000");
    expect(generateContainerId(1000)).toBe(`PMX-CON-${new Date().getFullYear()}-1000`);
  });
  it("sequence 0 formats as all zeros (no guard)", () => {
    expect(generateItemRef(0)).toBe("ITM-0000");
  });
  it("the container sequence does NOT restart per year inside the generator (year only changes the text)", () => {
    // The yearly restart in the Phase 3 spec is new behavior; today the caller passes count+1 of ALL containers.
    expect(generateContainerId(250)).toMatch(/^PMX-CON-\d{4}-250$/);
  });
});

describe(PRESERVE("item status pipeline"), () => {
  it("has exactly these 7 statuses in this order", () => {
    expect(ITEM_STATUS_STEPS).toEqual([
      "Arrived at Transit Warehouse",
      "Shipped to Ghana",
      "Arrived in Ghana",
      "Awaiting Customs Clearance & Duty Process",
      "Sorting",
      "Ready for Pickup",
      "Completed",
    ]);
  });
  it("getStatusStepIndex returns the position, or -1 for an unknown status", () => {
    expect(getStatusStepIndex("Sorting")).toBe(4);
    expect(getStatusStepIndex("Completed")).toBe(6);
    expect(getStatusStepIndex("Lost in Space" as never)).toBe(-1);
  });
});

describe(PRESERVE("normalizePhoneNumber (display/WhatsApp helper)"), () => {
  it("converts a 10-digit Ghana number starting with 0 to +233", () => {
    expect(normalizePhoneNumber("0244001234")).toBe("+233244001234");
    expect(normalizePhoneNumber("024 400 1234")).toBe("+233244001234");
  });
  it("prefixes + to numbers longer than 10 digits", () => {
    expect(normalizePhoneNumber("233244001234")).toBe("+233244001234");
    expect(normalizePhoneNumber("+1 415 555 2671")).toBe("+14155552671");
  });
  it("returns the input unchanged otherwise (e.g. a 10-digit US number gets NO country code)", () => {
    expect(normalizePhoneNumber("4155552671")).toBe("4155552671");
    expect(normalizePhoneNumber("12345")).toBe("12345");
  });
});

describe(PRESERVE("buildWhatsAppMessage"), () => {
  it("produces the existing customer-facing wording", () => {
    expect(buildWhatsAppMessage("Ada", "ORD-00001", "Sorting")).toBe(
      "Hello Ada, your package ORD-00001 is now *Sorting*. Thank you for choosing De-MOVEZZ LOGISTICS! 📦"
    );
  });
});

describe("formatCurrency", () => {
  it("defaults to USD with en-US formatting and two decimals", () => {
    expect(formatCurrency(1234.5)).toBe("$1,234.50");
    expect(formatCurrency(0)).toBe("$0.00");
  });
  it("formats GHS with the ISO code (not the cedi symbol)", () => {
    const s = formatCurrency(1234.5, "GHS");
    expect(s).toContain("1,234.50");
    expect(s).not.toContain("$");
  });
  it("performs NO rounding beyond Intl's 2-decimal display (display-time rounding only)", () => {
    expect(formatCurrency(0.005)).toBe("$0.01");
    expect(formatCurrency(1.004)).toBe("$1.00");
  });
});
