// POST /api/auth/signup — REMOVED (Phase 7G). It used to create a Firebase account with a CLIENT-chosen password plus a customer and a
// login immediately, from an unauthenticated request. The approved lifecycle is request -> approval -> activation:
//   POST /api/onboard        submit a registration request
//   POST /api/auth/activate  activate the approved registration with your own verified Firebase login
// This stub answers 410 and touches nothing (no password is read, no account or record is created).
export async function POST() {
  return Response.json(
    { success: false, error: "Self-service signup has been replaced by the registration request process. Submit a request at /onboard." },
    { status: 410 }
  );
}
