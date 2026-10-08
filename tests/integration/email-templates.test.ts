// The REAL email templates (src/lib/email.ts) rendered against the mocked Resend SDK.
import { describe, it, expect, vi } from "vitest";
import { state } from "../helpers/state";
import { PRESERVE, FIXED } from "../helpers/known";

const load = () => vi.importActual<typeof import("@/lib/email")>("@/lib/email");
const last = () => state().sentEmails.at(-1)!;

describe("transactional email content", () => {
  it(PRESERVE("welcome email shows the shipping mark and is sent from the configured sender"), async () => {
    state().sentEmails.length = 0;
    await (await load()).sendWelcomeEmail("ada@example.invalid", "Ada Mensah", "MOVEZZ-AM1234");
    expect(last().to).toEqual(["ada@example.invalid"]);
    expect(last().from).toBe("Movezz Test <noreply@example.invalid>");
    expect(last().html).toContain("MOVEZZ-AM1234");
    expect(last().html).toContain("De-MOVEZZ LOGISTICS");
  });
  it(PRESERVE("with no currency given the amounts are formatted in USD (callers that charge in GHS must say so)"), async () => {
    state().sentEmails.length = 0;
    const email = await load();
    await email.sendInvoiceCreatedEmail({ to: "ada@example.invalid", customerName: "Ada Mensah", orderRef: "ORD-00001", invoiceAmount: 100, invoiceDate: "2026-03-10", itemCount: 2, keepupLink: "https://keepup.example.invalid/pay" });
    expect(last().subject).toBe("Invoice ORD-00001 — $100.00 due");
    expect(last().html).toContain("https://keepup.example.invalid/pay");
  });
  it(FIXED("invoice, payment and partial-payment emails can state the amount in GHS, the currency the customer pays in"), async () => {
    state().sentEmails.length = 0;
    const email = await load();
    await email.sendInvoiceCreatedEmail({ to: "ada@example.invalid", customerName: "Ada Mensah", orderRef: "ORD-00001", invoiceAmount: 1250, currency: "GHS", invoiceDate: "2026-03-10", itemCount: 2 });
    expect(last().subject).toMatch(/GHS|GH₵/);
    expect(last().subject).not.toContain("$");
    await email.sendPaymentConfirmedEmail({ to: "ada@example.invalid", customerName: "Ada Mensah", orderRef: "ORD-00001", invoiceAmount: 1250, currency: "GHS" });
    expect(last().html).toMatch(/GHS|GH₵/);
    expect(last().html).not.toContain("$1,250");
    await email.sendPartialPaymentEmail({ to: "ada@example.invalid", customerName: "Ada Mensah", orderRef: "ORD-00001", amountPaid: 250, balanceDue: 1000, currency: "GHS" });
    expect(last().subject).toMatch(/GHS|GH₵/);
  });
  it(PRESERVE("partial-payment email formats whatever amounts it is given in USD"), async () => {
    state().sentEmails.length = 0;
    await (await load()).sendPartialPaymentEmail({ to: "ada@example.invalid", customerName: "Ada Mensah", orderRef: "ORD-00001", amountPaid: 40, balanceDue: 60 });
    expect(last().subject).toBe("Partial Payment Received — $60.00 Still Due");
  });
  it(PRESERVE("emails are silently skipped when RESEND_API_KEY is not configured"), async () => {
    const saved = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      state().sentEmails.length = 0;
      await (await load()).sendEmail("a@example.invalid", "s", "<p>x</p>");
      expect(state().sentEmails).toHaveLength(0);
    } finally {
      process.env.RESEND_API_KEY = saved;
    }
  });
});
