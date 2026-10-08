// POST /api/upload/sign — generate Cloudinary signed upload params
// Client uses these to upload directly to Cloudinary (no secret exposed)
import { NextRequest } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import { requireAuth, badRequestResponse } from "@/lib/auth";
import { limitUser, UPLOAD_FOLDER_PATTERN } from "@/lib/rate-limit";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request, ["super_admin", "warehouse_staff"]);
  if (authResult instanceof Response) return authResult;
  const limited = limitUser(authResult.user.id, "upload-sign", 30);
  if (limited) return limited;

  try {
    const { folder = "movezz/items" } = await request.json().catch(() => ({}));
    // The client can only choose among our own folders; arbitrary paths ("../..") were signed before.
    if (typeof folder !== "string" || !UPLOAD_FOLDER_PATTERN.test(folder)) {
      return badRequestResponse("Invalid upload folder");
    }
    const timestamp = Math.round(Date.now() / 1000);

    const signature = cloudinary.utils.api_sign_request(
      { timestamp, folder },
      process.env.CLOUDINARY_API_SECRET!
    );

    return Response.json({
      success: true,
      data: {
        signature,
        timestamp,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        folder,
      },
    });
  } catch {
    return Response.json({ success: false, error: "Failed to sign upload" }, { status: 500 });
  }
}
