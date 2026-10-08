// STAGING HARNESS ONLY. Preloaded into the Next server (NODE_OPTIONS=--require): sends server-side calls to Google identity hosts to the local stand-in.
const target = `http://127.0.0.1:${process.env.FAKE_IDENTITY_PORT || 9199}`;
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/^https:\/\/(identitytoolkit|securetoken|oauth2)\.googleapis\.com|^https:\/\/www\.googleapis\.com\/oauth2/.test(url)) return real(target + new URL(url).pathname.replace(/^\/v1\/projects\/[^/]+/, "/v1") + new URL(url).search, init);
  return real(input, init);
};
