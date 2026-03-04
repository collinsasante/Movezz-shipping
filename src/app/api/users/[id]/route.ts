// DELETE /api/users/[id]  — delete staff account (super_admin only)
import { NextRequest } from "next/server";
import { usersApi } from "@/lib/airtable";
import { deleteFirebaseUser } from "@/lib/firebase-admin";
import { requireAuth, serverErrorResponse } from "@/lib/auth";

// DELETE /api/users/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;
    // id could be Airtable record ID or Firebase UID
    await usersApi.getByFirebaseUid(id).catch(() => null);
    const body = await request.json().catch(() => ({}));
    const firebaseUid: string | undefined = body.firebaseUid;

    if (firebaseUid) {
      await deleteFirebaseUser(firebaseUid).catch((e) =>
        console.error("[DELETE /users] deleteFirebaseUser failed (non-fatal):", e)
      );
    }

    await usersApi.delete(id);

    return Response.json({ success: true, message: "Account deleted" });
  } catch (err) {
    console.error("[DELETE /users/[id]] Error:", err);
    return serverErrorResponse("Failed to delete account");
  }
}
