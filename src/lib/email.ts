// ============================================================
// PAKKmax Email System — powered by Resend
// ============================================================
// Docs: https://resend.com/docs
// Set RESEND_API_KEY and EMAIL_FROM in your environment.
// If RESEND_API_KEY is missing, emails are skipped (non-fatal).
// ============================================================

const RESEND_API_KEY = () => process.env.RESEND_API_KEY;
const EMAIL_FROM = () =>
  process.env.EMAIL_FROM ?? "PAKKmax <noreply@pakkmaxx.com>";

// ---- Core send helper ----
export async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  const key = RESEND_API_KEY();
  if (!key) {
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: EMAIL_FROM(), to, subject, html }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Resend ${res.status}: ${JSON.stringify(data)}`);
  }
}

// ============================================================
// BASE LAYOUT
// ============================================================
function baseLayout(content: string, previewText = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  ${previewText ? `<span style="display:none;max-height:0;overflow:hidden;">${previewText}&nbsp;</span>` : ""}
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f7;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background-color:#6d28d9;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
            <span style="display:inline-block;background-color:rgba(255,255,255,0.15);border-radius:8px;padding:6px 14px;">
              <span style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.5px;">PAKKmax</span>
            </span>
            <p style="margin:8px 0 0;font-size:12px;color:rgba(255,255,255,0.7);letter-spacing:0.5px;text-transform:uppercase;">USA → Ghana Freight Forwarding</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="background-color:#fff;padding:40px 40px 32px;">
            ${content}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color:#fff;border-radius:0 0 12px 12px;padding:0 40px 32px;text-align:center;border-top:1px solid #f3f4f6;">
            <p style="margin:20px 0 4px;font-size:12px;color:#9ca3af;">This email was sent automatically by <strong style="color:#6b7280;">PAKKmax</strong>. Please do not reply.</p>
            <p style="margin:0;font-size:11px;color:#d1d5db;">&copy; ${new Date().getFullYear()} PAKKmax. All rights reserved.</p>
          </td>
        </tr>

        <tr><td style="padding:20px 0;text-align:center;">
          <p style="margin:0;font-size:11px;color:#9ca3af;">PAKKmax &mdash; USA to Ghana Freight Forwarding</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
    <tr>
      <td style="border-radius:10px;background-color:#6d28d9;">
        <a href="${url}" target="_blank" style="display:inline-block;padding:13px 32px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;border-radius:10px;">${label}</a>
      </td>
    </tr>
  </table>`;
}

function statusPill(status: string): string {
  const colors: Record<string, string> = {
    "Arrived at Transit Warehouse": "#1d4ed8",
    "Shipped to Ghana": "#4338ca",
    "Arrived in Ghana": "#7c3aed",
    "Sorting": "#d97706",
    "Ready for Pickup": "#15803d",
    "Completed": "#374151",
    "Pending": "#b45309",
    "Partial": "#c2410c",
    "Paid": "#15803d",
  };
  const bg: Record<string, string> = {
    "Arrived at Transit Warehouse": "#dbeafe",
    "Shipped to Ghana": "#e0e7ff",
    "Arrived in Ghana": "#ede9fe",
    "Sorting": "#fef3c7",
    "Ready for Pickup": "#dcfce7",
    "Completed": "#f3f4f6",
    "Pending": "#fef3c7",
    "Partial": "#ffedd5",
    "Paid": "#dcfce7",
  };
  const color = colors[status] ?? "#374151";
  const bgColor = bg[status] ?? "#f3f4f6";
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${color};background-color:${bgColor};">${status}</span>`;
}

function infoRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:12px;color:#9ca3af;width:140px;vertical-align:top;padding-right:12px;">${label}</td>
          <td style="font-size:13px;color:#111827;font-weight:500;vertical-align:top;">${value}</td>
        </tr>
      </table>
    </td>
  </tr>`;
}

// ============================================================
// TEMPLATE 1: Welcome / Account Created
// ============================================================
export async function sendWelcomeEmail(
  to: string,
  customerName: string,
  shippingMark: string
): Promise<void> {
  const firstName = customerName.split(" ")[0];
  const html = baseLayout(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background-color:#ede9fe;border-radius:50%;width:56px;height:56px;text-align:center;vertical-align:middle;">
          <span style="font-size:28px;line-height:56px;">🎉</span>
        </td></tr>
      </table>
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Welcome to PAKKmax, ${firstName}!</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center;">Your account is ready. Here's your unique shipping mark — use it on every package you send to our warehouse in the USA.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td style="background-color:#f5f3ff;border:2px dashed #8b5cf6;border-radius:12px;padding:20px;text-align:center;">
          <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.5px;">Your Shipping Mark</p>
          <p style="margin:0;font-size:22px;font-weight:800;color:#4c1d95;font-family:monospace;letter-spacing:2px;">${shippingMark}</p>
          <p style="margin:8px 0 0;font-size:12px;color:#7c3aed;">Write this on every package you ship to us</p>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;background-color:#f9fafb;border-radius:10px;padding:16px;">
        <tr><td>
          <p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;">How it works:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:5px 0;font-size:13px;color:#4b5563;">📦 &nbsp;Write your shipping mark on each package</td></tr>
            <tr><td style="padding:5px 0;font-size:13px;color:#4b5563;">✈️ &nbsp;Ship to our USA warehouse address</td></tr>
            <tr><td style="padding:5px 0;font-size:13px;color:#4b5563;">📍 &nbsp;We receive, log, and ship to Ghana</td></tr>
            <tr><td style="padding:5px 0;font-size:13px;color:#4b5563;">🔔 &nbsp;Track your packages on your dashboard</td></tr>
          </table>
        </td></tr>
      </table>`,
    `Welcome to PAKKmax! Your shipping mark is ${shippingMark}`
  );
  await sendEmail(to, "Welcome to PAKKmax 🎉 — Here's your shipping mark", html);
}

// ============================================================
// TEMPLATE 2: Invoice Created
// ============================================================
export async function sendInvoiceCreatedEmail(opts: {
  to: string;
  customerName: string;
  orderRef: string;
  invoiceAmount: number;
  invoiceDate: string;
  itemCount: number;
  keepupLink?: string;
  notes?: string;
}): Promise<void> {
  const { to, customerName, orderRef, invoiceAmount, invoiceDate, itemCount, keepupLink, notes } = opts;
  const firstName = customerName.split(" ")[0];
  const amountStr = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(invoiceAmount);

  const html = baseLayout(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background-color:#fef3c7;border-radius:50%;width:56px;height:56px;text-align:center;vertical-align:middle;">
          <span style="font-size:28px;line-height:56px;">🧾</span>
        </td></tr>
      </table>
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Invoice Ready</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center;">Hi ${firstName}, an invoice has been created for your shipment. Please review and complete payment at your earliest convenience.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#6d28d9;padding:14px 20px;">
          <p style="margin:0;font-size:11px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.5px;">Invoice Reference</p>
          <p style="margin:4px 0 0;font-size:18px;font-weight:800;color:#fff;font-family:monospace;">${orderRef}</p>
        </td></tr>
        <tr><td style="padding:0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${infoRow("Invoice Date", invoiceDate)}
            ${infoRow("Items", `${itemCount} item${itemCount !== 1 ? "s" : ""}`)}
            ${infoRow("Status", statusPill("Pending"))}
            ${infoRow("Amount Due", `<span style="font-size:18px;font-weight:800;color:#6d28d9;">${amountStr}</span>`)}
            ${notes ? infoRow("Notes", notes) : ""}
          </table>
        </td></tr>
      </table>

      ${keepupLink ? ctaButton(keepupLink, "View & Pay Invoice") : ""}

      <p style="margin:0;font-size:13px;color:#6b7280;text-align:center;">Have questions? Contact us via WhatsApp and reference <strong>${orderRef}</strong>.</p>`,
    `Invoice ${orderRef} — ${amountStr} due`
  );
  await sendEmail(to, `Invoice ${orderRef} — ${amountStr} due`, html);
}

// ============================================================
// TEMPLATE 3: Payment Confirmed
// ============================================================
export async function sendPaymentConfirmedEmail(opts: {
  to: string;
  customerName: string;
  orderRef: string;
  invoiceAmount: number;
}): Promise<void> {
  const { to, customerName, orderRef, invoiceAmount } = opts;
  const firstName = customerName.split(" ")[0];
  const amountStr = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(invoiceAmount);

  const html = baseLayout(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background-color:#dcfce7;border-radius:50%;width:56px;height:56px;text-align:center;vertical-align:middle;">
          <span style="font-size:28px;line-height:56px;">✅</span>
        </td></tr>
      </table>
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Payment Confirmed</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center;">Hi ${firstName}, we've received your payment. Thank you!</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#15803d;padding:14px 20px;">
          <p style="margin:0;font-size:11px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.5px;">Payment Receipt</p>
          <p style="margin:4px 0 0;font-size:18px;font-weight:800;color:#fff;font-family:monospace;">${orderRef}</p>
        </td></tr>
        <tr><td style="padding:0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${infoRow("Reference", orderRef)}
            ${infoRow("Amount Paid", `<span style="font-size:18px;font-weight:800;color:#15803d;">${amountStr}</span>`)}
            ${infoRow("Status", statusPill("Paid"))}
            ${infoRow("Date", new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }))}
          </table>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background-color:#f0fdf4;border-radius:10px;padding:16px;">
        <tr><td style="font-size:13px;color:#166534;text-align:center;">
          Your shipment is on its way to Ghana. We'll notify you as your packages progress through the pipeline. 🚢
        </td></tr>
      </table>`,
    `Payment of ${amountStr} confirmed for ${orderRef}`
  );
  await sendEmail(to, `Payment Confirmed — ${orderRef}`, html);
}

// ============================================================
// TEMPLATE 4: Item Status Update
// ============================================================
export async function sendItemStatusEmail(opts: {
  to: string;
  customerName: string;
  itemRef: string;
  description: string;
  status: string;
  trackingNumber?: string;
}): Promise<void> {
  const { to, customerName, itemRef, description, status, trackingNumber } = opts;
  const firstName = customerName.split(" ")[0];

  const statusMessages: Record<string, { emoji: string; headline: string; body: string }> = {
    "Arrived at Transit Warehouse": {
      emoji: "📦",
      headline: "Package Arrived at Our Warehouse",
      body: "Great news! Your package has arrived at our USA transit warehouse. We've logged it and it'll be shipped to Ghana soon.",
    },
    "Shipped to Ghana": {
      emoji: "🚢",
      headline: "Your Package is on Its Way to Ghana!",
      body: "Your package has been loaded and is now en route to Ghana. Estimated arrival is 4–6 weeks.",
    },
    "Arrived in Ghana": {
      emoji: "🇬🇭",
      headline: "Package Arrived in Ghana",
      body: "Your package has landed in Ghana and is being processed through our facility.",
    },
    "Sorting": {
      emoji: "🔍",
      headline: "Package Being Sorted",
      body: "Your package is currently being sorted and prepared for pickup.",
    },
    "Ready for Pickup": {
      emoji: "🎁",
      headline: "Your Package is Ready for Pickup!",
      body: "Exciting news! Your package is ready and waiting for you at our Ghana facility. Please come collect it at your convenience.",
    },
    "Completed": {
      emoji: "✅",
      headline: "Package Delivered — All Done!",
      body: "Your package has been successfully delivered. Thanks for shipping with PAKKmax!",
    },
  };

  const msg = statusMessages[status] ?? {
    emoji: "📦",
    headline: `Package Status: ${status}`,
    body: `Your package status has been updated to: ${status}.`,
  };

  const html = baseLayout(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background-color:#ede9fe;border-radius:50%;width:56px;height:56px;text-align:center;vertical-align:middle;">
          <span style="font-size:28px;line-height:56px;">${msg.emoji}</span>
        </td></tr>
      </table>
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;">${msg.headline}</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center;">Hi ${firstName}, ${msg.body}</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#6d28d9;padding:14px 20px;">
          <p style="margin:0;font-size:11px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.5px;">Package Details</p>
          <p style="margin:4px 0 0;font-size:16px;font-weight:800;color:#fff;font-family:monospace;">${itemRef}</p>
        </td></tr>
        <tr><td style="padding:0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${infoRow("Description", description || "—")}
            ${trackingNumber ? infoRow("Tracking #", `<span style="font-family:monospace;">${trackingNumber}</span>`) : ""}
            ${infoRow("Current Status", statusPill(status))}
          </table>
        </td></tr>
      </table>`,
    `${msg.emoji} ${status} — ${itemRef}`
  );
  await sendEmail(to, `${msg.emoji} ${status} — ${itemRef}`, html);
}

// ============================================================
// TEMPLATE 5: Password Reset (for manual trigger)
// Firebase Auth sends its own reset email automatically.
// Use this if you build a custom reset flow.
// ============================================================
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string
): Promise<void> {
  const html = baseLayout(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background-color:#ede9fe;border-radius:50%;width:56px;height:56px;text-align:center;vertical-align:middle;">
          <span style="font-size:28px;line-height:56px;">🔐</span>
        </td></tr>
      </table>
      <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Reset Your Password</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center;">We received a request to reset your PAKKmax account password. Click the button below to choose a new one.</p>
      <p style="margin:0 0 28px;font-size:13px;line-height:1.6;color:#6b7280;text-align:center;">This link expires in <strong style="color:#374151;">1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
      ${ctaButton(resetUrl, "Reset Password")}
      <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Or copy this link: <a href="${resetUrl}" style="color:#6d28d9;word-break:break-all;">${resetUrl}</a></p>`,
    "Reset your PAKKmax password"
  );
  await sendEmail(to, "Reset Your PAKKmax Password", html);
}

// ============================================================
// TEMPLATE 6: Partial Payment Received
// ============================================================
export async function sendPartialPaymentEmail(opts: {
  to: string;
  customerName: string;
  orderRef: string;
  amountPaid: number;
  balanceDue: number;
  keepupLink?: string;
}): Promise<void> {
  const { to, customerName, orderRef, amountPaid, balanceDue, keepupLink } = opts;
  const firstName = customerName.split(" ")[0];
  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  const html = baseLayout(
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
        <tr><td style="background-color:#ffedd5;border-radius:50%;width:56px;height:56px;text-align:center;vertical-align:middle;">
          <span style="font-size:28px;line-height:56px;">🧩</span>
        </td></tr>
      </table>
      <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#111827;text-align:center;">Partial Payment Received</h1>
      <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:#4b5563;text-align:center;">Hi ${firstName}, we've received a partial payment for invoice <strong>${orderRef}</strong>. Please complete the remaining balance.</p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#c2410c;padding:14px 20px;">
          <p style="margin:0;font-size:11px;font-weight:600;color:rgba(255,255,255,0.7);text-transform:uppercase;letter-spacing:0.5px;">Invoice ${orderRef}</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:700;color:#fff;">Balance remaining</p>
        </td></tr>
        <tr><td style="padding:0 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${infoRow("Amount Paid", `<span style="color:#15803d;font-weight:700;">${fmt(amountPaid)}</span>`)}
            ${infoRow("Balance Due", `<span style="font-size:18px;font-weight:800;color:#c2410c;">${fmt(balanceDue)}</span>`)}
            ${infoRow("Status", statusPill("Partial"))}
          </table>
        </td></tr>
      </table>

      ${keepupLink ? ctaButton(keepupLink, "Pay Remaining Balance") : ""}`,
    `Partial payment received for ${orderRef} — ${fmt(balanceDue)} still due`
  );
  await sendEmail(to, `Partial Payment Received — ${fmt(balanceDue)} Still Due`, html);
}
