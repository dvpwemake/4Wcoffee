/* node scripts/test_editorial_publish.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const api = require("./editorial-publish.js");

let n = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  n += 1;
}

const live = {
  publishDate: "2026-11-01",
  title: "Market Paradoxes, Micro-Metrics, and Sanctioned Vices",
  paragraphs: ["The morning essay."],
};
const replacement = {
  publishDate: "2026-11-01",
  title: "High Futures, High Drama, and a Single Cigarette",
  paragraphs: ["The afternoon essay."],
};
const revision = {
  publishDate: "2026-11-01",
  title: "  Market Paradoxes, Micro-Metrics, and Sanctioned Vices  ",
  paragraphs: ["A typo fix."],
};
const nextDay = {
  publishDate: "2026-11-02",
  title: "A new day",
  paragraphs: ["Tuesday."],
};

const conflict = api.sameDayConflict(live, replacement);
check(conflict && conflict.date === "2026-11-01", "different title on the same date conflicts");
check(conflict.liveTitle.indexOf("Market Paradoxes") === 0, "conflict names the essay that stays");
check(api.sameDayConflict(live, revision) === null, "same title is a revision");
check(api.sameDayConflict(live, nextDay) === null, "a new date is not a conflict");

const blocked = api.historyForPublish(live, [], replacement, function (ed) {
  return { publishDate: ed.publishDate, title: ed.title, paragraphs: ed.paragraphs };
});
check(blocked.ok === false, "a conflicting publish does not build a history");
check(blocked.history.length === 0, "a conflicting publish writes no history");

const revised = api.historyForPublish(live, [{ publishDate: "2026-10-29", title: "Older" }], revision);
check(revised.ok === true, "revision is allowed");
check(revised.history.length === 1 && revised.history[0].publishDate === "2026-10-29", "revision does not drop the older archive");
check(!revised.history.some(function (h) { return h.publishDate === "2026-11-01"; }), "revision does not duplicate that date");

const moved = api.historyForPublish(live, [{ publishDate: "2026-10-29", title: "Older" }], nextDay, function (ed) {
  return { publishDate: ed.publishDate, title: ed.title };
});
check(moved.ok === true && moved.history[0].title === live.title, "a new date keeps yesterday's essay at the front of history");
check(moved.history[1].publishDate === "2026-10-29", "older history stays behind the essay that just left the homepage");

const bare = '<script src="editorial.data.js"></script>';
const stamped = api.stampEditorialSrc(bare, "111");
check(stamped === '<script src="editorial.data.js?v=111"></script>', "bare script src gets one version");
const restamped = api.stampEditorialSrc(stamped, "222");
check(restamped === '<script src="editorial.data.js?v=222"></script>', "a second stamp replaces the version");
check(api.stampEditorialSrc(bare, "???") === bare, "an unsafe token does not rewrite the page");
const labeled = '<button>Download editorial.data.js</button>\n<script src="editorial.data.js"></script>';
const labeledOut = api.stampEditorialSrc(labeled, "111");
check(labeledOut.indexOf(">Download editorial.data.js</button>") !== -1, "a button label is not a script src");
check(labeledOut.indexOf('src="editorial.data.js?v=111"') !== -1, "only the script src is stamped");

const editor = fs.readFileSync(path.join(__dirname, "..", "editor.js"), "utf8");
const fn = editor.slice(editor.indexOf("async publishEditorial"), editor.indexOf("async armLinkedIn"));
check(fn.indexOf("putGithubFile") === -1, "publishEditorial does not make a contents commit per file");
check(fn.indexOf("putGithubCommit") !== -1, "publishEditorial writes one git commit");
check(fn.indexOf("historyForPublish") !== -1, "publishEditorial uses the shared history rule");
check(editor.indexOf("async putGithubCommit") !== -1, "the one-commit writer exists");

console.log("editorial-publish tests ok " + n);
