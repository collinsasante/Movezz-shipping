// DELETE /api/users/[id]  — delete staff account (super_admin only)
import { NextRequest } from "next/server";
import { usersApi } from "@/lib/airtable";
import { deleteFirebaseUser } from "@/lib/firebase-admin";
import { requireAuth, serverErrorResponse, notFoundResponse, badRequestResponse } from "@/lib/auth";

// DELETE /api/users/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request, ["super_admin"]);
  if (authResult instanceof Response) return authResult;

  try {
    const { id } = await params;

    // The account to delete is looked up server-side. A Firebase UID supplied in the request body is
    // ignored: it used to be deleted blindly, so an admin request could remove any Firebase account.
    const target = (await usersApi.listAll()).find((u) => u.id === id);
    if (!target) return notFoundResponse("User not found");

    if (target.role === "super_admin") {
      const admins = (await usersApi.listAll()).filter((u) => u.role === "super_admin");
      if (admins.length <= 1) return badRequestResponse("The last super admin cannot be deleted");
    }

    if (target.firebaseUid) {
      await deleteFirebaseUser(target.firebaseUid).catch(() => {});
    }

    await usersApi.delete(id);

    return Response.json({ success: true, message: "Account deleted" });
  } catch {
    return serverErrorResponse("Failed to delete account");
  }
}
