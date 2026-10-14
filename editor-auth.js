/**
 * Editor gate for static hosting (GitHub Pages).
 * Compares SHA-256 of the entered password to passwordSha256.
 * Deterrence layer — not equivalent to server auth.
 * Rotate: python3 -c "import hashlib; print(hashlib.sha256(b'NEW').hexdigest())"
 */
(function (global) {
  "use strict";

  var CONFIG = {
    passwordSha256: "79370dbdb3ebaaa571811e05ea70484e747725317f72f41ce4cb43ee80069251",
    sessionKey: "fw_editor_session_v1",
    failKey: "fw_editor_fails_v1",
    maxFails: 8,
    lockMinutes: 15,
  };

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(function (b) {
        return b.toString(16).padStart(2, "0");
      })
      .join("");
  }

  async function sha256(text) {
    var data = new TextEncoder().encode(text);
    var dig = await crypto.subtle.digest("SHA-256", data);
    return bufToHex(dig);
  }

  function failState() {
    try {
      return JSON.parse(sessionStorage.getItem(CONFIG.failKey) || '{"n":0,"until":0}');
    } catch (e) {
      return { n: 0, until: 0 };
    }
  }

  function setFails(s) {
    sessionStorage.setItem(CONFIG.failKey, JSON.stringify(s));
  }

  function isLocked() {
    var s = failState();
    return s.until && Date.now() < s.until;
  }

  function recordFail() {
    var s = failState();
    s.n = (s.n || 0) + 1;
    if (s.n >= CONFIG.maxFails) {
      s.until = Date.now() + CONFIG.lockMinutes * 60 * 1000;
      s.n = 0;
    }
    setFails(s);
    return s;
  }

  function clearFails() {
    sessionStorage.removeItem(CONFIG.failKey);
  }

  function hasSession() {
    try {
      return sessionStorage.getItem(CONFIG.sessionKey) === CONFIG.passwordSha256;
    } catch (e) {
      return false;
    }
  }

  function setSession() {
    sessionStorage.setItem(CONFIG.sessionKey, CONFIG.passwordSha256);
    clearFails();
  }

  function clearSession() {
    sessionStorage.removeItem(CONFIG.sessionKey);
  }

  async function checkPassword(plain) {
    if (isLocked()) {
      var s = failState();
      var mins = Math.ceil((s.until - Date.now()) / 60000);
      return { ok: false, locked: true, message: "Locked. Try again in " + mins + " min." };
    }
    var hex = await sha256(String(plain || ""));
    if (hex === CONFIG.passwordSha256) {
      setSession();
      return { ok: true };
    }
    var fails = recordFail();
    if (fails.until && Date.now() < fails.until) {
      return { ok: false, locked: true, message: "Too many attempts. Locked for " + CONFIG.lockMinutes + " min." };
    }
    return { ok: false, message: "Incorrect password." };
  }

  function mountGate(opts) {
    var gate = document.getElementById("editorGate");
    var app = document.getElementById("editorApp");
    var form = document.getElementById("gateForm");
    var err = document.getElementById("gateErr");
    function showApp() {
      if (gate) gate.hidden = true;
      if (app) app.hidden = false;
      if (typeof opts.onUnlock === "function") opts.onUnlock();
    }
    function showGate() {
      if (gate) gate.hidden = false;
      if (app) app.hidden = true;
    }
    if (hasSession()) {
      showApp();
      return;
    }
    showGate();
    // Touch ID: one touch replaces the password and the token paste (editor-touchid.js).
    var tidBtn = document.getElementById("gateTouchId");
    var tid = global.FourthWaveTouchID;
    if (tidBtn && tid && tid.enrolled()) {
      // Enrolled: Touch ID is the sign-in; the password form waits behind a link.
      tidBtn.hidden = false;
      var other = document.getElementById("gateOther");
      if (form && other) {
        form.hidden = true;
        other.hidden = false;
        other.addEventListener("click", function () {
          other.hidden = true;
          form.hidden = false;
          var pass = document.getElementById("gatePass");
          if (pass) pass.focus();
        });
      }
      tidBtn.addEventListener("click", function () {
        tid.unlock().then(function (res) {
          if (res.ok) {
            try {
              sessionStorage.setItem("fw_gh_pat", res.pat);
            } catch (e) {
              /* private mode: the token field stays empty */
            }
            setSession();
            if (err) err.textContent = "";
            showApp();
          } else if (err) {
            err.textContent = res.message || "Touch ID failed.";
          }
        });
      });
    }
    if (!form) return;

    // First password sign-in on a Touch ID Mac: offer "Use Touch ID next time" right here (the
    // sidebar box still works too). "Not now" is remembered in this browser.
    var SKIP_KEY = "fw_touchid_skip_v1";
    var setup = document.getElementById("gateSetup");
    var setupPat = document.getElementById("gateSetupPat");
    var setupBtn = document.getElementById("gateSetupBtn");
    var setupSkip = document.getElementById("gateSetupSkip");
    function skipped() {
      try {
        return localStorage.getItem(SKIP_KEY) === "1";
      } catch (e) {
        return false;
      }
    }
    function setSkipped() {
      try {
        localStorage.setItem(SKIP_KEY, "1");
      } catch (e) {
        /* private mode: asked again next time */
      }
    }
    function afterPassword() {
      if (!tid || !setup || !setupBtn || tid.enrolled() || skipped()) return showApp();
      tid.supported().then(function (ok) {
        if (!ok) return showApp();
        form.hidden = true;
        var otherLink = document.getElementById("gateOther");
        if (otherLink) otherLink.hidden = true;
        if (tidBtn) tidBtn.hidden = true;
        setup.hidden = false;
        var have = "";
        try {
          have = sessionStorage.getItem("fw_gh_pat") || "";
        } catch (e) {
          have = "";
        }
        if (setupPat) {
          setupPat.value = have;
          setupPat.focus();
        }
      });
    }
    if (setupBtn && tid) {
      setupBtn.addEventListener("click", function () {
        var pat = setupPat ? String(setupPat.value || "").trim() : "";
        if (err) err.textContent = "Touch ID…";
        setupBtn.disabled = true;
        tid.save(pat).then(function (res) {
          setupBtn.disabled = false;
          if (res.ok) {
            try {
              sessionStorage.setItem("fw_gh_pat", pat);
            } catch (e) {
              /* private mode: the token field stays empty */
            }
            if (setupPat) setupPat.value = "";
            if (err) err.textContent = "";
            showApp();
            return;
          }
          if (/PRF|not available/i.test(res.message || "")) {
            setSkipped();
            setupBtn.hidden = true;
            if (setupSkip) setupSkip.textContent = "Continue to the editor";
          }
          if (err) err.textContent = res.message || "Touch ID setup failed.";
        });
      });
    }
    if (setupSkip) {
      setupSkip.addEventListener("click", function () {
        setSkipped();
        if (setupPat) setupPat.value = "";
        if (err) err.textContent = "";
        showApp();
      });
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var input = document.getElementById("gatePass");
      var val = input ? input.value : "";
      checkPassword(val).then(function (res) {
        if (res.ok) {
          if (err) err.textContent = "";
          if (input) input.value = "";
          afterPassword();
        } else if (err) {
          err.textContent = res.message || "Denied.";
        }
      });
    });
  }

  global.FourthWaveEditorAuth = {
    hasSession: hasSession,
    clearSession: clearSession,
    checkPassword: checkPassword,
    mountGate: mountGate,
  };
})(window);
