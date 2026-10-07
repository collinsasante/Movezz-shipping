import { redirect } from "next/navigation";

// Self-signup lives at /onboard (the link already shared with customers)
export default function SignupPage() {
  redirect("/onboard");
}
