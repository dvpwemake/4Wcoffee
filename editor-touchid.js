/**
 * Touch ID unlock for the editor (GitHub Pages, no server).
 *
 * The GitHub token is encrypted in this browser with a key that only a Touch ID check on this device can produce
 * (WebAuthn passkey + the PRF extension). Nothing secret is stored in clear text, and nothing is sent anywhere.
 * Unlocking with Touch ID replaces typing the editor password and pasting the token.
 *
 * Fallback: if the browser or device does not support PRF, the password gate and the token field work as before.
 * If the passkey is deleted, the saved token cannot be recovered: use the password and paste the token once more.
 */
(function (global) {
  "use strict";

  var VAULT_KEY = "fw_touchid_vault_v1";
  var SALT = new TextEncoder().encode("fourthwave-editor-vault-v1");
  var INFO = new TextEncoder().encode("fourthwave-editor-aes-gcm");

  function b64u(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64u(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function readVault() {
    try {
      var raw = localStorage.getItem(VAULT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeVault(v) {
    localStorage.setItem(VAULT_KEY, JSON.stringify(v));
  }

  function enrolled() {
    var v = readVault();
    return !!(v && v.id && v.iv && v.ct);
  }

  async function supported() {
    try {
      if (!global.PublicKeyCredential || !navigator.credentials) return false;
      if (!global.isSecureContext) return false;
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }

  async function aesKeyFrom(prfBytes) {
    var base = await crypto.subtle.importKey("raw", prfBytes, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  // One Touch ID check that returns the PRF secret for an existing passkey.
  async function prfFor(idBytes) {
    var cred = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        allowCredentials: [{ type: "public-key", id: idBytes }],
        userVerification: "required",
        timeout: 60000,
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    var ext = cred && cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    var first = ext.prf && ext.prf.results && ext.prf.results.first;
    if (!first) throw new Error("prf_unavailable");
    return new Uint8Array(first);
  }

  async function createPasskey() {
    var cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Fourth Wave editor", id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "editor", displayName: "Editor" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
        timeout: 60000,
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    if (!ext.prf || !ext.prf.enabled) throw new Error("prf_unavailable");
    return new Uint8Array(cred.rawId);
  }

  async function seal(prfBytes, secret) {
    var key = await aesKeyFrom(prfBytes);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(secret)));
    return { iv: b64u(iv), ct: b64u(ct) };
  }

  /** Save (or replace) the token. One Touch ID check when already set up, two the first time. */
  async function save(pat) {
    pat = String(pat || "").trim();
    if (!/^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(pat)) {
      return { ok: false, message: "Paste the GitHub token into a token field first." };
    }
    if (!(await supported())) {
      return { ok: false, message: "Touch ID is not available in this browser. The password and token field still work." };
    }
    try {
      var vault = readVault();
      var idBytes;
      if (vault && vault.id) {
        idBytes = fromB64u(vault.id);
      } else {
        idBytes = await createPasskey();
      }
      var prf = await prfFor(idBytes);
      var sealed = await seal(prf, { pat: pat });
      writeVault({ v: 1, id: b64u(idBytes), iv: sealed.iv, ct: sealed.ct });
      return { ok: true };
    } catch (e) {
      if (e && e.message === "prf_unavailable") {
        return { ok: false, message: "This browser or device cannot use Touch ID to protect the token (no PRF support). Keep using the password." };
      }
      if (e && e.name === "NotAllowedError") return { ok: false, message: "Touch ID was cancelled." };
      return { ok: false, message: "Touch ID setup failed: " + (e && e.message ? e.message : e) };
    }
  }

  /** One Touch ID check. Returns { ok, pat }. */
  async function unlock() {
    var vault = readVault();
    if (!vault) return { ok: false, message: "Touch ID is not set up on this browser." };
    try {
      var prf = await prfFor(fromB64u(vault.id));
      var key = await aesKeyFrom(prf);
      var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(vault.iv) }, key, fromB64u(vault.ct));
      var data = JSON.parse(new TextDecoder().decode(plain));
      if (!data || !data.pat) return { ok: false, message: "Saved token is empty. Unlock with the password and save it again." };
      return { ok: true, pat: data.pat };
    } catch (e) {
      if (e && e.name === "NotAllowedError") return { ok: false, message: "Touch ID was cancelled." };
      return { ok: false, message: "Touch ID could not open the saved token. Use the password and save it again." };
    }
  }

  function forget() {
    try {
      localStorage.removeItem(VAULT_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  global.FourthWaveTouchID = { supported: supported, enrolled: enrolled, save: save, unlock: unlock, forget: forget };
})(window);

// Editor panel: shown only where Touch ID is available.
document.addEventListener("DOMContentLoaded", async function () {
  var box = document.getElementById("touchIdBox");
  if (!box || !(await window.FourthWaveTouchID.supported())) return;
  var T = window.FourthWaveTouchID;
  var state = document.getElementById("touchIdState");
  var saveBtn = document.getElementById("touchIdSave");
  var forgetBtn = document.getElementById("touchIdForget");
  function paint(msg) {
    var on = T.enrolled();
    state.textContent = msg || (on ? "On. Unlock the editor with Touch ID; no password or token paste needed." : "Off. Paste your GitHub token in a token field, then save it here once.");
    saveBtn.textContent = on ? "Replace saved token (Touch ID)" : "Save GitHub token to Touch ID";
    forgetBtn.hidden = !on;
    box.hidden = false;
  }
  saveBtn.addEventListener("click", async function () {
    var typed = "";
    document.querySelectorAll(".gh-pat").forEach(function (el) {
      if (!typed && el.value) typed = String(el.value).trim();
    });
    if (!typed) {
      try {
        typed = sessionStorage.getItem("fw_gh_pat") || "";
      } catch (e) {
        typed = "";
      }
    }
    var res = await T.save(typed);
    paint(res.ok ? "Saved. Next time, unlock with Touch ID." : res.message);
  });
  forgetBtn.addEventListener("click", function () {
    T.forget();
    paint("Touch ID removed from this browser. Use the password and token field.");
  });
  paint();
});
