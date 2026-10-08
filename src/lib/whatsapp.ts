// WhatsApp Business API sender (Meta Graph API). Independent of the data backend; used by both the PostgreSQL and the
// (temporary) Airtable routes. Best effort: failures never fail the business operation.
export const whatsAppApi = {
  async _send(phone: string, message: string): Promise<void> {
    const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] as { env?: Record<string, string> } | undefined;
    const cfEnv = ctx?.env ?? {};
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? cfEnv["WHATSAPP_ACCESS_TOKEN"];
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? cfEnv["WHATSAPP_PHONE_NUMBER_ID"];
    if (!accessToken || !phoneNumberId) {
      console.warn("[WhatsApp] WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID not configured — skipping send");
      return;
    }
    const phoneNumber = phone.replace(/\D/g, "");
    const res = await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8000),   // a slow provider must not hold the request open
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phoneNumber,
        type: "text",
        text: { body: message },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[WhatsApp] send failed (${res.status}):`, body);
    }
  },

  async sendNotification(payload: {
    phone: string;
    customerName: string;
    orderRef: string;
    newStatus: string;
    message: string;
  }): Promise<void> {
    try {
      await whatsAppApi._send(payload.phone, payload.message);
    } catch {
      // non-critical
    }
  },

  async sendWelcome(phone: string, name: string, shippingMark: string, resetUrl: string): Promise<void> {
    const firstName = name.trim().split(/\s+/)[0];
    const message =
      `Hello ${firstName}! 👋 Welcome to *De-MOVEZZ LOGISTICS*.\n\n` +
      `Your account has been created.\n` +
      `🔖 Shipping Mark: *${shippingMark}*\n\n` +
      `Set up your password using the link below so you can log in and track your shipments:\n` +
      `${resetUrl}\n\n` +
      `_This link expires in 24 hours. Contact us if you need a new one._`;
    try {
      await whatsAppApi._send(phone, message);
    } catch {
      // non-critical
    }
  },
};
