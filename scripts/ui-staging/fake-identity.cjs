// STAGING HARNESS ONLY. A local stand-in for Google Identity Toolkit so the real UI and real API routes can be exercised without a Firebase project.
// Tokens are "header.payload.sig" JWT-shaped strings whose payload carries {user_id,email,email_verified}; they are NOT signed and mean nothing outside this harness.
const http = require("node:http");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const users = JSON.parse(process.env.FAKE_USERS || "{}");   // { "<email>": { uid, password } }
const mint = (u, email) => `${b64({ alg: "none" })}.${b64({ iss: "fake", aud: "fake", user_id: u.uid, sub: u.uid, email, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })}.sig`;
const decode = (t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); } catch { return null; } };
http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { j = Object.fromEntries(new URLSearchParams(body)); } const send = (c, o) => { res.writeHead(c, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(o)); };
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" }); return res.end(); }
    if (req.url.includes("accounts:signInWithPassword")) {
      const u = users[(j.email || "").toLowerCase()]; if (!u || u.password !== j.password) return send(400, { error: { code: 400, message: "INVALID_LOGIN_CREDENTIALS" } });
      const t = mint(u, j.email.toLowerCase());
      return send(200, { kind: "identitytoolkit#VerifyPasswordResponse", localId: u.uid, email: j.email, idToken: t, refreshToken: "r-" + u.uid, expiresIn: "3600", registered: true });
    }
    if (req.url.includes("accounts:lookup")) {
      const p = j.idToken ? decode(j.idToken) : null;
      if (j.idToken) { if (!p) return send(400, { error: { message: "INVALID_ID_TOKEN" } }); return send(200, { users: [{ localId: p.user_id, email: p.email, emailVerified: true }] }); }
      const out = (j.localId || []).map((id) => { const e = Object.entries(users).find(([, u]) => u.uid === id); return e ? { localId: id, email: e[0], emailVerified: true } : null; }).filter(Boolean);
      return send(200, { users: out });
    }
    if (req.url.includes("token")) {   // securetoken refresh: refresh_token is "r-<uid>"
      const uid = String(j.refresh_token || "").replace(/^r-/, ""); const e = Object.entries(users).find(([, u]) => u.uid === uid);
      if (!e) return send(200, { access_token: "fake-access", expires_in: "3600" });   // service-account OAuth exchange used by the admin helpers
      const t = mint(e[1], e[0]);
      return send(200, { access_token: t, id_token: t, refresh_token: "r-" + uid, expires_in: "3600", token_type: "Bearer", user_id: uid, project_id: "fake" });
    }
    send(404, { error: { message: "not handled by the harness" } });
  });
}).listen(Number(process.env.FAKE_IDENTITY_PORT || 9199), "127.0.0.1");
