// POST /api/auth/send-verification — (re)send the signed-in user's email verification link
// Only ever emails the caller's own address, taken from their Firebase account,
// so it can't be used to probe which emails have accounts.
import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getFirebaseUser, generateEmailVerificationLink } from "@/lib/firebase-admin";
import { sendEmailVerificationEmail } from "@/lib/email";
import { checkRateLimit, rateLimitedResponse, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  if (!checkRateLimit(`send-verification-ip:${ip}`, 10, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  const authResult = await requireAuth(request);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  // One email per minute, five per hour, per account
  if (!checkRateLimit(`send-verification-min:${user.firebaseUid}`, 1, 60_000)) {
    return rateLimitedResponse(60);
  }
  if (!checkRateLimit(`send-verification-hour:${user.firebaseUid}`, 5, 60 * 60_000)) {
    return rateLimitedResponse(3600);
  }

  try {
    const fbUser = await getFirebaseUser(user.firebaseUid);
    if (!fbUser?.email) {
      return Response.json({ success: false, error: "No email address on this account." }, { status: 400 });
    }
    if (fbUser.emailVerified) {
      return Response.json({ success: true, data: { alreadyVerified: true } });
    }

    const url = await generateEmailVerificationLink(fbUser.email);
    await sendEmailVerificationEmail(fbUser.email, user.customerName ?? fbUser.email.split("@")[0], url);
    return Response.json({ success: true, data: { alreadyVerified: false } });
  } catch (err) {
    console.error("[send-verification] failed:", err);
    return Response.json(
      { success: false, error: "We couldn't send the email right now. Please try again in a few minutes." },
      { status: 502 }
    );
  }
}
