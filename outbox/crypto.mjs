// Outbox envelope encryption. The repo is public, so recipient lists and app passwords are committed
// only as ciphertext: a fresh AES-256-GCM key per file, wrapped with the repo's RSA-OAEP-256 public
// key (outbox/public-key.pem). Only GitHub Actions holds the private key (secret OUTBOX_PRIVATE_KEY).
// Runs in the browser and in Node 20+ (WebCrypto in both). No dependencies.

const ALG = "RSA-OAEP-256+A256GCM";

function b64(bytes) {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(str) {
  const bin = atob(String(str));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemBody(pem, label) {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(String(pem));
  if (!m) throw new Error("bad_pem:" + label);
  return unb64(m[1].replace(/\s+/g, ""));
}

const RSA = { name: "RSA-OAEP", hash: "SHA-256" };

export async function importPublicKey(pem) {
  return crypto.subtle.importKey("spki", pemBody(pem, "PUBLIC KEY"), RSA, false, ["encrypt"]);
}

export async function importPrivateKey(pem) {
  return crypto.subtle.importKey("pkcs8", pemBody(pem, "PRIVATE KEY"), RSA, false, ["decrypt"]);
}

/** Encrypt any JSON value for the repo. Returns the envelope as a JSON string (safe to commit). */
export async function seal(publicKeyPem, value) {
  const pub = await importPublicKey(publicKeyPem);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(value)));
  const key = await crypto.subtle.encrypt(RSA, pub, raw);
  return JSON.stringify({ v: 1, alg: ALG, key: b64(key), iv: b64(iv), ct: b64(ct) });
}

/** Decrypt an envelope (GitHub Actions only: it needs the private key). */
export async function open(privateKeyPem, envelopeJson) {
  const env = typeof envelopeJson === "string" ? JSON.parse(envelopeJson) : envelopeJson;
  if (env?.v !== 1 || env.alg !== ALG) throw new Error("bad_envelope");
  const priv = await importPrivateKey(privateKeyPem);
  const raw = await crypto.subtle.decrypt(RSA, priv, unb64(env.key));
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, aes, unb64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
