#!/usr/bin/env node
'use strict';
/**
 * Post one Fourth Wave editorial to the LinkedIn company page.
 * The workflow is armed by Publish editorial, waits 10 minutes, then runs this script.
 * Source: https://fourthwavecoffee.org/e/YYYY-MM-DD.html
 * Author: urn:li:organization:144003245
 *
 * Access path: one GET of that day's page, one GET of the latest 20 company
 * posts, optional image download plus two LinkedIn upload calls, one POST
 * to create the post. No database. Timeout 20s on every outbound call.
 *
 * Token: env LINKEDIN_ACCESS_TOKEN. Never written to disk or logs.
 * Ledger: data/linkedin-posts.json (date, permalink, title, post URN).
 * This file reads Fourth Wave pages only.
 *
 * Usage:
 *   node scripts/linkedin-editorial.js
 *   EDITORIAL_DATE=2026-09-20 node scripts/linkedin-editorial.js
 *   node scripts/linkedin-editorial.js --check-ledger
 *   node scripts/linkedin-editorial.js --self-test
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'linkedin-posts.json');
const SITE = 'https://fourthwavecoffee.org';
const ORG_ID = /^\d+$/.test(String(process.env.LINKEDIN_ORG_ID || ''))
  ? String(process.env.LINKEDIN_ORG_ID)
  : '144003245';
const LINKEDIN_VERSION = '202609';
const COMMENTARY_MAX = 2900;
const IMAGE_MAX_BYTES = 8000000;
const TIMEOUT_MS = 20000;

function pacificDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now || new Date());
  const pick = (type) => parts.find((part) => part.type === type).value;
  return pick('year') + '-' + pick('month') + '-' + pick('day');
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function decode(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripTags(value) {
  return decode(String(value || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, key) {
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]+content=["\']([^"\']*)["\']', 'i'),
    new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:name|property)=["\']' + name + '["\']', 'i')
  ];
  for (const pattern of patterns) {
    const found = html.match(pattern);
    if (found) return decode(found[1]);
  }
  return '';
}

function parseEditorialHtml(html, date) {
  const page = String(html || '');
  const h2 = stripTags((page.match(/<h2>([\s\S]*?)<\/h2>/i) || [])[1] || '');
  const title = metaContent(page, 'og:title') || h2;
  const dek = stripTags((page.match(/<p class="ed-dek">([\s\S]*?)<\/p>/i) || [])[1] || metaContent(page, 'description'));
  const prose = (page.match(/<div class="ed-prose">([\s\S]*?)<\/div>/i) || [])[1] || '';
  const paragraphs = [...prose.matchAll(/<p>([\s\S]*?)<\/p>/gi)]
    .map((found) => stripTags(found[1]))
    .filter(Boolean);
  const canonical = metaContent(page, 'og:url') || (SITE + '/e/' + date + '.html');
  const hero = metaContent(page, 'og:image')
    || decode((page.match(/<div class="ed-hero">[\s\S]*?<img[^>]*\ssrc="([^"]+)"/i) || [])[1] || '');
  return {
    date,
    title,
    dek,
    paragraphs,
    permalink: SITE + '/e/' + date + '.html',
    canonical,
    hero: /^https:\/\//i.test(hero) ? hero : ''
  };
}

function escapeCommentary(value) {
  return String(value || '').replace(/[\\()[\]{}@|~*_<>#]/g, (ch) => '\\' + ch);
}

function clip(value, max) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function buildCommentary(editorial) {
  const head = [editorial.title, editorial.dek].filter(Boolean).join('\n\n');
  let body = editorial.paragraphs.join('\n\n');
  const link = '\n\n' + editorial.permalink;
  let commentary = escapeCommentary(head + (body ? '\n\n' + body : '')) + link;
  if (commentary.length <= COMMENTARY_MAX) return commentary;
  const room = COMMENTARY_MAX - escapeCommentary(head).length - link.length - 4;
  body = clip(body, Math.max(0, room));
  commentary = escapeCommentary(head + (body ? '\n\n' + body : '')) + link;
  return clip(commentary, COMMENTARY_MAX);
}

function buildPost(editorial, orgId, imageUrn) {
  const article = {
    source: editorial.permalink,
    title: clip(editorial.title, 400),
    description: clip(editorial.dek || editorial.title, 1000)
  };
  if (imageUrn) article.thumbnail = imageUrn;
  return {
    author: 'urn:li:organization:' + orgId,
    commentary: editorial.commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    content: { article },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };
}

function loadLedger(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      orgId: String(data.orgId || ORG_ID),
      page: 'https://www.linkedin.com/company/' + ORG_ID + '/',
      posts: Array.isArray(data.posts) ? data.posts : []
    };
  } catch (e) {
    return { orgId: ORG_ID, page: 'https://www.linkedin.com/company/' + ORG_ID + '/', posts: [] };
  }
}

function alreadyPosted(ledger, date, permalink) {
  return (ledger.posts || []).some((row) => row && (row.date === date || row.permalink === permalink));
}

function ledgerAction(ledger, date) {
  const permalink = SITE + '/e/' + date + '.html';
  return alreadyPosted(ledger, date, permalink) ? 'skip' : 'continue';
}

function recordResultKind(alreadyOnPage) {
  return alreadyOnPage ? 'recorded' : 'posted';
}

function recentContains(elements, permalink) {
  return (elements || []).some((row) => {
    const source = row && row.content && row.content.article && row.content.article.source;
    const text = (row && row.commentary) || '';
    return source === permalink || text.indexOf(permalink) !== -1;
  });
}

function remember(ledger, record) {
  const posts = (ledger.posts || []).filter((row) => row && row.date !== record.date);
  posts.unshift({
    date: record.date,
    permalink: record.permalink,
    title: record.title,
    linkedinUrn: record.linkedinUrn || '',
    postedAt: record.postedAt
  });
  return {
    orgId: ORG_ID,
    page: 'https://www.linkedin.com/company/' + ORG_ID + '/',
    posts: posts.slice(0, 120)
  };
}

function publicError(value) {
  return String(value || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .slice(0, 500);
}

function localPage(date) {
  const file = path.join(ROOT, 'e', date + '.html');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

async function fetchText(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'FourthWave-LinkedIn-Editorial/1.0' },
      redirect: 'follow'
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function loadEditorial(date, eventName) {
  const url = SITE + '/e/' + date + '.html';
  let live = await fetchText(url);
  if (!live.ok && eventName === 'workflow_dispatch') {
    for (let i = 0; i < 3 && !live.ok; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20000));
      live = await fetchText(url);
    }
  }
  if (live.ok && live.text) {
    const editorial = parseEditorialHtml(live.text, date);
    editorial.source = 'site';
    return editorial;
  }
  const file = localPage(date);
  if (!file) return null;
  const editorial = parseEditorialHtml(file, date);
  editorial.source = 'repo';
  return editorial;
}

function linkedInHeaders(token, json) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0'
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

async function linkedIn(token, url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || linkedInHeaders(token, !!options.body),
      body: options.body,
      signal: ctrl.signal,
      redirect: 'follow'
    });
  } finally {
    clearTimeout(timer);
  }
}

async function recentPosts(token, orgId) {
  const author = encodeURIComponent('urn:li:organization:' + orgId);
  const url = 'https://api.linkedin.com/rest/posts?q=author&author=' + author + '&count=20&sortBy=LAST_MODIFIED';
  const res = await linkedIn(token, url, { method: 'GET', headers: linkedInHeaders(token, false) });
  if (!res.ok) {
    console.log('Recent-post check skipped (' + res.status + '). The ledger still prevents a second post.');
    return [];
  }
  const data = await res.json();
  return data.elements || [];
}

async function uploadHero(token, orgId, heroUrl) {
  if (!heroUrl) return '';
  const downloaded = await fetch(heroUrl, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'FourthWave-LinkedIn-Editorial/1.0' },
    redirect: 'follow'
  });
  if (!downloaded.ok) return '';
  const type = String(downloaded.headers.get('content-type') || '').toLowerCase();
  if (!/^image\/(jpeg|jpg|png|gif|pjpeg)/.test(type)) return '';
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) return '';
  const init = await linkedIn(token, 'https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    body: JSON.stringify({ initializeUploadRequest: { owner: 'urn:li:organization:' + orgId } })
  });
  if (!init.ok) {
    console.log('Hero upload was skipped (' + init.status + '). The post still goes out with the link.');
    return '';
  }
  const value = (await init.json()).value || {};
  if (!value.uploadUrl || !value.image) return '';
  const put = await linkedIn(token, value.uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream'
    },
    body: bytes
  });
  if (!put.ok) {
    console.log('Hero upload was skipped (' + put.status + '). The post still goes out with the link.');
    return '';
  }
  return value.image;
}

async function createPost(token, post) {
  const res = await linkedIn(token, 'https://api.linkedin.com/rest/posts', {
    method: 'POST',
    body: JSON.stringify(post)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('LinkedIn post failed (' + res.status + '): ' + publicError(text));
  }
  return res.headers.get('x-restli-id') || '';
}

function resultLine(kind, date) {
  console.log('LINKEDIN_RESULT=' + kind + (date ? ' ' + date : ''));
}

function checkLedger() {
  const requested = String(process.env.EDITORIAL_DATE || '').trim();
  if (requested && !isDate(requested)) {
    throw new Error('EDITORIAL_DATE must be YYYY-MM-DD');
  }
  const date = requested || pacificDate(new Date());
  const action = ledgerAction(loadLedger(LEDGER_PATH), date);
  if (action === 'skip') {
    console.log(date + ' is already in the ledger. Nothing posted.');
  } else {
    console.log(date + ' is not in the ledger.');
  }
  resultLine(action, date);
}

async function run() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const requested = String(process.env.EDITORIAL_DATE || '').trim();
  if (requested && !isDate(requested)) {
    throw new Error('EDITORIAL_DATE must be YYYY-MM-DD');
  }
  const date = requested || pacificDate(new Date());
  const token = String(process.env.LINKEDIN_ACCESS_TOKEN || '').trim();
  if (eventName === 'workflow_dispatch' && !token) {
    throw new Error('LINKEDIN_ACCESS_TOKEN is not set on the GitHub repo');
  }

  const editorial = await loadEditorial(date, eventName);
  if (!editorial || !editorial.title) {
    if (eventName === 'workflow_dispatch') {
      throw new Error('No editorial is published for ' + date);
    }
    console.log('No editorial for ' + date + '. Nothing posted.');
    resultLine('skip', date);
    return;
  }
  if (editorial.canonical && editorial.canonical.indexOf(SITE + '/e/' + date) !== 0) {
    throw new Error('Refusing a page whose canonical URL is not this editorial');
  }
  editorial.commentary = buildCommentary(editorial);

  const ledger = loadLedger(LEDGER_PATH);
  if (alreadyPosted(ledger, date, editorial.permalink)) {
    console.log(date + ' is already in the ledger. Nothing posted.');
    resultLine('skip', date);
    return;
  }
  if (!token) {
    throw new Error('LINKEDIN_ACCESS_TOKEN is not set on the GitHub repo');
  }

  const recent = await recentPosts(token, ORG_ID);
  if (recentContains(recent, editorial.permalink)) {
    console.log(date + ' is already on the company page. Nothing posted.');
    const next = remember(ledger, {
      date,
      permalink: editorial.permalink,
      title: editorial.title,
      linkedinUrn: '',
      postedAt: new Date().toISOString()
    });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(next, null, 2) + '\n');
    resultLine(recordResultKind(true), date);
    return;
  }

  console.log('Posting ' + date + ' from ' + editorial.source + ' · ' + editorial.title);
  let imageUrn = '';
  try {
    imageUrn = await uploadHero(token, ORG_ID, editorial.hero);
  } catch (e) {
    console.log('Hero upload was skipped. The post still goes out with the link.');
  }
  const urn = await createPost(token, buildPost(editorial, ORG_ID, imageUrn));
  const next = remember(ledger, {
    date,
    permalink: editorial.permalink,
    title: editorial.title,
    linkedinUrn: urn,
    postedAt: new Date().toISOString()
  });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log('Posted ' + date + (urn ? ' · ' + urn : ''));
  resultLine(recordResultKind(false), date);
}

function selfTest() {
  const fixture = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Og Title">
<meta property="og:image" content="https://example.com/hero.jpg">
<meta property="og:url" content="https://fourthwavecoffee.org/e/2026-10-14.html">
</head><body>
<h1>Editorials.</h1>
<p class="ed-byline">By Dr. Wallace Lynch<span class="ed-role"> Editor in Chief</span></p>
<h2>A cup &amp; a room</h2>
<p class="ed-dek">A dek with (parens).</p>
<div class="ed-prose"><p>First paragraph.</p><p>Second (note) paragraph.</p></div>
</body></html>`;
  const editorial = parseEditorialHtml(fixture, '2026-10-14');
  if (editorial.title !== 'Og Title') throw new Error('title');
  if (editorial.dek !== 'A dek with (parens).') throw new Error('dek');
  if (editorial.paragraphs.length !== 2) throw new Error('paragraphs');
  if (editorial.paragraphs.join(' ').indexOf('Editor in Chief') !== -1) throw new Error('byline leaked');
  if (editorial.permalink !== SITE + '/e/2026-10-14.html') throw new Error('permalink');
  if (editorial.hero !== 'https://example.com/hero.jpg') throw new Error('hero');
  editorial.commentary = buildCommentary(editorial);
  if (editorial.commentary.length > COMMENTARY_MAX) throw new Error('commentary length');
  if (editorial.commentary.indexOf(editorial.permalink) === -1) throw new Error('link missing');
  if (editorial.commentary.indexOf('\\(parens\\)') === -1) throw new Error('parens not escaped');
  const long = parseEditorialHtml(fixture, '2026-10-14');
  long.paragraphs = [new Array(800).fill('word').join(' ')];
  const clipped = buildCommentary(long);
  if (clipped.length > COMMENTARY_MAX) throw new Error('clip failed');
  if (!clipped.endsWith(long.permalink)) throw new Error('clip dropped the link');
  const post = buildPost(Object.assign({}, editorial, { commentary: editorial.commentary }), '144003245', 'urn:li:image:abc');
  const keys = Object.keys(post).sort().join(',');
  if (keys !== 'author,commentary,content,distribution,isReshareDisabledByAuthor,lifecycleState,visibility') {
    throw new Error('post keys ' + keys);
  }
  if (post.author !== 'urn:li:organization:144003245') throw new Error('author');
  if (post.content.article.thumbnail !== 'urn:li:image:abc') throw new Error('thumbnail');
  if (post.content.article.source !== editorial.permalink) throw new Error('source');
  const ledger = { posts: [{ date: '2026-10-14', permalink: editorial.permalink }] };
  if (!alreadyPosted(ledger, '2026-10-14', editorial.permalink)) throw new Error('ledger hit');
  if (alreadyPosted(ledger, '2026-10-13', SITE + '/e/2026-10-13.html')) throw new Error('ledger miss');
  if (ledgerAction(ledger, '2026-10-14') !== 'skip') throw new Error('check-ledger skip');
  if (ledgerAction({ posts: [] }, '2026-10-14') !== 'continue') throw new Error('check-ledger continue');
  if (ledgerAction({ posts: [{ date: '2026-09-01', permalink: editorial.permalink }] }, '2026-10-14') !== 'skip') {
    throw new Error('check-ledger permalink');
  }
  if (recordResultKind(true) !== 'recorded') throw new Error('recorded kind');
  if (recordResultKind(false) !== 'posted') throw new Error('posted kind');
  if (!recentContains([{ content: { article: { source: editorial.permalink } } }], editorial.permalink)) {
    throw new Error('recent source');
  }
  const saved = remember({ posts: [] }, {
    date: '2026-10-14',
    permalink: editorial.permalink,
    title: editorial.title,
    linkedinUrn: 'urn:li:share:1',
    postedAt: '2026-10-14T15:00:00.000Z'
  });
  if (saved.posts.length !== 1 || saved.posts[0].linkedinUrn !== 'urn:li:share:1') throw new Error('remember');
  if (saved.posts[0].commentary) throw new Error('ledger stored the essay');
  if (saved.orgId !== '144003245') throw new Error('org');
  if (publicError('Bearer abc.def access_token=zzz').indexOf('abc.def') !== -1) throw new Error('redact');
  if (pacificDate(new Date('2026-10-14T07:00:00Z')) !== '2026-10-14') throw new Error('pacific date');
  if (pacificDate(new Date('2026-10-14T06:00:00Z')) !== '2026-10-13') throw new Error('pacific previous');
  const live = localPage('2026-09-20');
  if (live) {
    const parsed = parseEditorialHtml(live, '2026-09-20');
    if (parsed.title !== 'The first lot from Vietnam') throw new Error('live title');
    if (!parsed.paragraphs.length) throw new Error('live body');
    if (parsed.paragraphs.join(' ').indexOf('Editor in Chief') !== -1) throw new Error('live byline');
    if (parsed.hero.indexOf('https://') !== 0) throw new Error('live hero');
    if (parsed.canonical.indexOf(SITE + '/e/2026-09-20') !== 0) throw new Error('live canonical');
  }
  const current = localPage('2026-10-13');
  if (current) {
    const parsed = parseEditorialHtml(current, '2026-10-13');
    if (parsed.title !== 'Craft, Convergence, and the Mindful Cup') throw new Error('current title');
    if (parsed.paragraphs.length < 2) throw new Error('current body');
    if (parsed.paragraphs.join(' ').indexOf('Editor in Chief') !== -1) throw new Error('current byline');
    if (parsed.hero.indexOf('https://') !== 0) throw new Error('current hero');
    if (parsed.canonical.indexOf(SITE + '/e/2026-10-13') !== 0) throw new Error('current canonical');
    if (!buildCommentary(parsed).endsWith(parsed.permalink)) throw new Error('current link');
  }
  console.log('self_test passed');
}

if (require.main === module) {
  if (process.argv.indexOf('--self-test') !== -1) {
    selfTest();
  } else if (process.argv.indexOf('--check-ledger') !== -1) {
    try {
      checkLedger();
    } catch (err) {
      console.error(publicError(err && err.message ? err.message : err));
      process.exit(1);
    }
  } else {
    run().catch((err) => {
      console.error(publicError(err && err.message ? err.message : err));
      process.exit(1);
    });
  }
}

module.exports = {
  pacificDate,
  parseEditorialHtml,
  buildCommentary,
  buildPost,
  alreadyPosted,
  ledgerAction,
  recordResultKind,
  recentContains,
  remember,
  publicError
};
