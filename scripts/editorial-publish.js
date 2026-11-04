/* Pure rules for one editorial publish. No network. */
(function (root) {
  function normTitle(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function dayOf(ed) {
    return String((ed && ed.publishDate) || "").slice(0, 10);
  }

  function hasProse(ed) {
    if (!ed) return false;
    if (ed.paragraphs && ed.paragraphs.length) return true;
    return !!String(ed.body || "").trim();
  }

  /* A different title on a date that already has prose is a second essay.
     Same title is a revision of that day's essay. */
  function sameDayConflict(live, next) {
    if (!hasProse(live) || !next) return null;
    var day = dayOf(next);
    if (!day || day !== dayOf(live)) return null;
    if (normTitle(live.title) === normTitle(next.title)) return null;
    return { date: day, liveTitle: normTitle(live.title) };
  }

  function historyForPublish(live, history, next, slim) {
    var conflict = sameDayConflict(live, next);
    if (conflict) return { ok: false, conflict: conflict, history: [] };
    var nextDay = dayOf(next);
    var hist = (history || []).slice();
    var liveDay = dayOf(live);
    if (hasProse(live) && liveDay && liveDay !== nextDay) {
      hist = hist.filter(function (h) {
        return dayOf(h) !== liveDay;
      });
      hist.unshift(typeof slim === "function" ? slim(live) : live);
    }
    hist = hist.filter(function (h) {
      return dayOf(h) !== nextDay;
    });
    return { ok: true, conflict: null, history: hist.slice(0, 60) };
  }

  function stampEditorialSrc(html, token) {
    var safe = String(token || "").replace(/[^0-9A-Za-z]/g, "");
    if (!safe) return String(html || "");
    return String(html || "").replace(
      /(<script\b[^>]*\ssrc=["'])editorial\.data\.js(?:\?v=[^"']*)?(["'])/g,
      "$1editorial.data.js?v=" + safe + "$2"
    );
  }

  function stampToken(now) {
    return String(now == null ? Date.now() : now);
  }

  var api = {
    normTitle: normTitle,
    sameDayConflict: sameDayConflict,
    historyForPublish: historyForPublish,
    stampEditorialSrc: stampEditorialSrc,
    stampToken: stampToken,
  };
  if (root) root.EditorialPublish = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null);
