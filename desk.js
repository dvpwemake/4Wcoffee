/* Latest Beat desk — Field Signals analogue in Fourth Wave UI.
   Separate feed from Chronicle of Convergence. */
(function (global) {
  "use strict";

  var SITE = "https://fourthwavecoffee.org";
  var PAGE_SIZE = 12;
  var FALLBACK = {
    industry: "image/carosal/cafe-scene-6887.jpg",
    science: "image/carosal/cafe-scene-7252.jpg",
    reviews: "image/carosal/cafe-scene-7473.jpg",
    origin: "image/carosal/cafe-scene-7378.jpg",
    editorial: "image/carosal/cafe-scene-8167.png",
  };
  var CATS = [
    { id: "all", label: "All" },
    { id: "editorial", label: "Editorial" },
    { id: "industry", label: "Industry" },
    { id: "science", label: "Science" },
    { id: "reviews", label: "Reviews" },
    { id: "origin", label: "Origin" },
  ];

  function prefix() {
    return global.SiteChrome && global.SiteChrome.assetPrefix
      ? global.SiteChrome.assetPrefix()
      : "";
  }

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;");
  }

  function plainText(s) {
    return String(s || "")
      .replace(/<cite\b[^>]*>[\s\S]*?<\/cite>/gi, " ")
      .replace(/\[web:\d+\]/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  function dayKey(raw) {
    var s = String(raw || "");
    var m = s.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  function displayDate(raw) {
    var d = dayKey(raw);
    if (!d) return "";
    var parts = d.split("-");
    var months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    var mi = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    if (mi < 0 || mi > 11 || !day) return d;
    return months[mi] + " " + day + ", " + parts[0];
  }

  function paragraphsFrom(ed) {
    if (!ed) return [];
    if (ed.paragraphs && ed.paragraphs.length) {
      return ed.paragraphs.map(plainText).filter(Boolean);
    }
    return String(ed.body || "")
      .split(/\n\n+/)
      .map(plainText)
      .filter(Boolean);
  }

  function isOutline(ed) {
    if (!ed) return true;
    if (ed.draftKind === "outline" || ed.status === "draft") return true;
    var blob = String(ed.title || "") + "\n" + String(ed.body || "");
    if (/EDITORIAL BRIEF\s*\(outline only/i.test(blob)) return true;
    if (/^DRAFT — not live/i.test(blob)) return true;
    return false;
  }

  function hasEditorial(ed) {
    if (!ed || isOutline(ed)) return false;
    if (!plainText(ed.title)) return false;
    return paragraphsFrom(ed).length > 0;
  }

  function permalinkPath(date) {
    var d = dayKey(date);
    return d ? "e/" + d + ".html" : "";
  }

  function permalinkUrl(date) {
    var p = permalinkPath(date);
    return p ? SITE + "/" + p : SITE + "/latestbeat.html#editorial";
  }

  function proxyUrl(url) {
    if (!url || String(url).indexOf("image/") === 0) return "";
    if (!/^https?:\/\//i.test(url)) return "";
    return (
      "https://images.weserv.nl/?url=" +
      encodeURIComponent(String(url).replace(/^https?:\/\//, "")) +
      "&w=1200&h=675&fit=cover&we&output=jpg"
    );
  }

  function imgSrc(url, cat) {
    var raw = String(url || "");
    if (raw.indexOf("image/") === 0) return prefix() + raw;
    if (raw) return raw;
    var fb = FALLBACK[cat] || FALLBACK.editorial;
    return prefix() + fb;
  }

  var Desk = {
    liveEditorial: null,
    activeEditorial: null,
    editorialByDate: {},
    items: [],
    shown: 0,
    cat: "all",
    archiveLoaded: false,

    initLatestBeat: function () {
      Desk.liveEditorial = hasEditorial(global.EDITORIAL) ? global.EDITORIAL : null;
      Desk.indexHistory();
      Desk.items = Desk.seedItems();
      Desk.bindFilters();
      Desk.bindHash();
      Desk.applyRoute(false);
      Desk.drawGrid();
      Desk.fetchArchive();
      var dateEl = document.getElementById("curDate");
      if (dateEl) {
        dateEl.textContent = new Date().toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        });
      }
    },

    indexHistory: function () {
      var map = {};
      function put(ed) {
        if (!hasEditorial(ed)) return;
        var d = dayKey(ed.publishDate || ed.publishedAt || ed.id);
        if (!d) return;
        map[d] = ed;
      }
      put(Desk.liveEditorial);
      (global.EDITORIAL_HISTORY || []).forEach(put);
      Desk.editorialByDate = map;
    },

    seedItems: function () {
      var out = [];
      var seen = {};
      function add(it) {
        if (!it) return;
        var url = String(it.sourceUrl || "").split("?")[0];
        var key = url || String(it.id || it.title || "");
        if (!key || seen[key]) return;
        seen[key] = true;
        out.push(it);
      }
      Object.keys(Desk.editorialByDate)
        .sort()
        .reverse()
        .forEach(function (d) {
          var ed = Desk.editorialByDate[d];
          if (!ed || d === dayKey(Desk.liveEditorial && Desk.liveEditorial.publishDate)) return;
          add({
            id: "editorial-" + d,
            title: plainText(ed.title),
            summary: plainText(ed.dek || paragraphsFrom(ed)[0] || ""),
            image: ed.heroImage || "",
            source: "Fourth Wave Coffee",
            sourceUrl: permalinkPath(d),
            category: "editorial",
            categoryLabel: "Editorial",
            isEditorialArchive: true,
            publishDate: d,
          });
        });
      ((global.SIGNALS && global.SIGNALS.items) || []).forEach(add);
      return out;
    },

    parseHashDate: function () {
      var h = String(location.hash || "").replace(/^#/, "");
      if (!h || h === "editorial") return null;
      var m = h.match(/^editorial[-/](\d{4}-\d{2}-\d{2})$/i);
      return m ? m[1] : null;
    },

    resolveRoute: function () {
      var date = Desk.parseHashDate();
      if (date) {
        if (Desk.editorialByDate[date] && hasEditorial(Desk.editorialByDate[date])) {
          Desk.activeEditorial = Desk.editorialByDate[date];
          return { mode: "archive", date: date };
        }
        Desk.activeEditorial = {
          title: "Editorial not found in archive",
          dek: "The full text for this date is not stored yet.",
          paragraphs: [
            "This Latest Beat card points to a past daily editorial, but the full prose is not in editorial history for " +
              date +
              ".",
            "Return to today’s editorial, or publish that date from the desk if this archive card should be restored.",
          ],
          publishDate: date,
          authorName: "Dr. Wallace Lynch",
          authorTitle: "Editor in Chief",
          wordCount: 0,
        };
        return { mode: "missing", date: date };
      }
      Desk.activeEditorial = Desk.liveEditorial;
      return { mode: "live", date: dayKey(Desk.liveEditorial && Desk.liveEditorial.publishDate) };
    },

    applyRoute: function (scroll) {
      var route = Desk.resolveRoute();
      Desk.renderEditorial();
      if (scroll) {
        var el = document.getElementById("editorial");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return route;
    },

    bindHash: function () {
      window.addEventListener("hashchange", function () {
        Desk.applyRoute(true);
      });
    },

    bindFilters: function () {
      var host = document.getElementById("beat-filters");
      if (!host) return;
      host.innerHTML = CATS.map(function (c) {
        return (
          '<button type="button" data-cat="' +
          c.id +
          '"' +
          (c.id === Desk.cat ? ' class="is-on"' : "") +
          ">" +
          esc(c.label) +
          "</button>"
        );
      }).join("");
      host.addEventListener("click", function (ev) {
        var btn = ev.target.closest("[data-cat]");
        if (!btn) return;
        Desk.cat = btn.getAttribute("data-cat") || "all";
        Desk.shown = 0;
        Array.prototype.forEach.call(host.querySelectorAll("[data-cat]"), function (b) {
          b.classList.toggle("is-on", b.getAttribute("data-cat") === Desk.cat);
        });
        if (Desk.cat === "editorial") {
          if (location.hash !== "#editorial") location.hash = "editorial";
          else Desk.applyRoute(true);
        }
        Desk.drawGrid();
      });
    },

    slidesFor: function (ed) {
      var slides = [];
      var seen = {};
      function push(url, credit, source, sourceUrl, alt) {
        var u = String(url || "").split("?")[0];
        if (!u || seen[u]) return;
        seen[u] = true;
        slides.push({
          url: url,
          credit: plainText(credit || source || ""),
          source: plainText(source || ""),
          sourceUrl: sourceUrl || "",
          alt: plainText(alt || credit || "Editorial image"),
          proxy: proxyUrl(url),
        });
      }
      if (ed) {
        push(ed.heroImage, ed.heroCredit, ed.heroSource, ed.heroSourceUrl, ed.title);
      }
      ((global.SIGNALS && global.SIGNALS.items) || []).forEach(function (it) {
        if (it.image) push(it.image, it.source, it.source, it.sourceUrl, it.title);
      });
      return slides;
    },

    renderEditorial: function (host, ed, opts) {
      var el = host || document.getElementById("editorial");
      if (!el) return;
      opts = opts || {};
      var piece = ed || Desk.activeEditorial;
      if (!hasEditorial(piece)) {
        el.innerHTML =
          '<div class="ed-kicker">Daily editorial</div>' +
          '<div class="ed-card ed-card--empty">The daily editorial publishes with the morning packet.</div>';
        return;
      }
      var archiveDate = opts.archiveDate != null ? opts.archiveDate : Desk.parseHashDate();
      var pieceDate = dayKey(piece.publishDate || piece.publishedAt);
      var isArchive = !!(archiveDate && pieceDate === archiveDate);
      var liveDate = dayKey(Desk.liveEditorial && Desk.liveEditorial.publishDate);
      var paras = paragraphsFrom(piece);
      var prose = paras.map(function (p) {
        return "<p>" + esc(p) + "</p>";
      }).join("");
      var slides = Desk.slidesFor(piece);
      var hero = "";
      if (slides.length) {
        var slidesHtml = slides
          .map(function (s, n) {
            var src = imgSrc(s.url, "editorial");
            return (
              '<div class="ed-hero-slide' +
              (n === 0 ? " is-on" : "") +
              '" data-i="' +
              n +
              '"><img src="' +
              esc(src) +
              '" alt="' +
              esc(s.alt) +
              '" width="1280" height="720" ' +
              (n === 0 ? 'fetchpriority="high"' : 'loading="lazy"') +
              ' decoding="async" referrerpolicy="no-referrer" data-proxy="' +
              esc(s.proxy || "") +
              '" onerror="Desk.heroFail(this)"></div>'
            );
          })
          .join("");
        var nav =
          slides.length > 1
            ? '<button type="button" class="ed-hero-nav ed-hero-prev" aria-label="Previous image">‹</button>' +
              '<button type="button" class="ed-hero-nav ed-hero-next" aria-label="Next image">›</button>' +
              '<div class="ed-hero-dots" role="tablist" aria-label="Hero images"></div>'
            : "";
        hero =
          '<div class="ed-hero' +
          (slides.length > 1 ? " is-carousel" : "") +
          '" id="edHeroCarousel" aria-roledescription="carousel">' +
          '<div class="ed-hero-viewport">' +
          slidesHtml +
          "</div>" +
          nav +
          "</div>" +
          '<p class="ed-credit" id="edHeroCredit"></p>';
      }
      var authorName = plainText(piece.authorName || "Dr. Wallace Lynch");
      var authorTitle = plainText(piece.authorTitle || "Editor in Chief");
      var shownDate = displayDate(pieceDate || archiveDate);
      var kicker = isArchive
        ? "From the archive · " + esc(shownDate || pieceDate || archiveDate)
        : "Daily editorial · " + esc(shownDate || pieceDate || "");
      var permRel = permalinkPath(pieceDate);
      var pfx = prefix();
      var backLink = isArchive
        ? '<p class="ed-footer-links"><a href="#editorial">← Back to today’s editorial' +
          (liveDate ? " (" + esc(liveDate) + ")" : "") +
          "</a></p>"
        : "";
      var share = Desk.shareHtml(piece);
      var homeLink = opts.home
        ? '<p class="ed-footer-links"><a class="btn btn-outline" href="' +
          pfx +
          'latestbeat.html#editorial">Latest Beat</a></p>'
        : '<p class="ed-footer-links">' +
          (permRel
            ? '<a href="' + pfx + permRel + '">Permalink</a>'
            : "") +
          '<a href="' +
          pfx +
          'e/index.html">All editorials</a></p>';
      el.innerHTML =
        '<div class="ed-kicker">' +
        kicker +
        "</div>" +
        '<article class="ed-card" itemscope itemtype="https://schema.org/NewsArticle">' +
        hero +
        '<div class="ed-body">' +
        '<h2 itemprop="headline">' +
        esc(plainText(piece.title) || "Editorial") +
        "</h2>" +
        (piece.dek
          ? '<p class="ed-dek" itemprop="description">' + esc(plainText(piece.dek)) + "</p>"
          : "") +
        '<div class="ed-byline-row">' +
        '<p class="ed-byline">By ' +
        esc(authorName) +
        '<span class="ed-role"> ' +
        esc(authorTitle) +
        "</span></p>" +
        '<p class="ed-meta"><time datetime="' +
        esc(pieceDate || "") +
        '" itemprop="datePublished">' +
        esc(shownDate || pieceDate || "") +
        "</time></p>" +
        "</div>" +
        backLink +
        '<div class="ed-prose" itemprop="articleBody">' +
        prose +
        "</div>" +
        share +
        homeLink +
        "</div></article>";
      Desk.bindCarousel(el, slides);
      Desk.injectLd(piece, isArchive, archiveDate);
      if (global.EditorialShare) global.EditorialShare.bind();
    },

    bindCarousel: function (root, slides) {
      var box = root.querySelector("#edHeroCarousel");
      if (!box || !slides || !slides.length) return;
      var i = 0;
      var credit = root.querySelector("#edHeroCredit");
      function show(n) {
        i = (n + slides.length) % slides.length;
        var nodes = box.querySelectorAll(".ed-hero-slide");
        Array.prototype.forEach.call(nodes, function (node, idx) {
          node.classList.toggle("is-on", idx === i);
        });
        var dots = box.querySelectorAll(".ed-hero-dot");
        Array.prototype.forEach.call(dots, function (dot, idx) {
          dot.setAttribute("aria-current", idx === i ? "true" : "false");
        });
        if (credit) {
          var s = slides[i] || {};
          var label = s.credit || s.source || "";
          credit.innerHTML = label
            ? s.sourceUrl
              ? 'Photo: <a href="' +
                esc(s.sourceUrl) +
                '" target="_blank" rel="noopener">' +
                esc(label) +
                "</a>"
              : "Photo: " + esc(label)
            : "";
        }
      }
      var dotsHost = box.querySelector(".ed-hero-dots");
      if (dotsHost && slides.length > 1) {
        dotsHost.innerHTML = slides
          .map(function (_s, n) {
            return (
              '<button type="button" class="ed-hero-dot" data-i="' +
              n +
              '" aria-label="Image ' +
              (n + 1) +
              '"></button>'
            );
          })
          .join("");
        dotsHost.addEventListener("click", function (ev) {
          var b = ev.target.closest("[data-i]");
          if (b) show(parseInt(b.getAttribute("data-i"), 10) || 0);
        });
      }
      var prev = box.querySelector(".ed-hero-prev");
      var next = box.querySelector(".ed-hero-next");
      if (prev) prev.addEventListener("click", function () { show(i - 1); });
      if (next) next.addEventListener("click", function () { show(i + 1); });
      show(0);
    },

    shareHtml: function (ed) {
      if (global.EditorialShare && global.EditorialShare.html) {
        return global.EditorialShare.html(ed);
      }
      return "";
    },

    injectLd: function (ed, isArchive, archiveDate) {
      document.querySelectorAll("script[data-fw-editorial-ld]").forEach(function (n) {
        n.remove();
      });
      if (!ed || !ed.title) return;
      var date = dayKey(ed.publishDate || archiveDate);
      var url = isArchive && date ? permalinkUrl(date) : SITE + "/latestbeat.html#editorial";
      var ld = document.createElement("script");
      ld.type = "application/ld+json";
      ld.setAttribute("data-fw-editorial-ld", "1");
      ld.textContent = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "NewsArticle",
        headline: plainText(ed.title),
        description: plainText(ed.dek || ""),
        datePublished: ed.publishDate || date,
        author: {
          "@type": "Person",
          name: ed.authorName || "Dr. Wallace Lynch",
          jobTitle: ed.authorTitle || "Editor in Chief",
        },
        publisher: {
          "@type": "NewsMediaOrganization",
          name: "Fourth Wave Coffee",
          url: SITE + "/",
          logo: {
            "@type": "ImageObject",
            url: SITE + "/image/icon-512.png",
          },
        },
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
        image: ed.heroImage ? [ed.heroImage] : undefined,
        isAccessibleForFree: true,
        inLanguage: "en-US",
        wordCount: ed.wordCount || undefined,
      });
      document.head.appendChild(ld);
    },

    heroFail: function (img) {
      if (img.dataset.proxy && !img.dataset.triedProxy) {
        img.dataset.triedProxy = "1";
        img.src = img.dataset.proxy;
        return;
      }
      var wrap = img.parentElement;
      img.remove();
      if (wrap && !wrap.querySelector(".ed-hero-ph")) {
        var ph = document.createElement("div");
        ph.className = "ed-hero-ph";
        ph.textContent = "Fourth Wave Coffee";
        wrap.appendChild(ph);
      }
    },

    thumbFail: function (img) {
      if (img.dataset.proxy && !img.dataset.triedProxy) {
        img.dataset.triedProxy = "1";
        img.src = img.dataset.proxy;
        return;
      }
      if (img.dataset.fallback && img.src.indexOf(img.dataset.fallback) === -1) {
        img.src = img.dataset.fallback;
        img.removeAttribute("data-proxy");
        return;
      }
      var wrap = img.parentElement;
      img.remove();
      var f = document.createElement("div");
      f.className = "fallback";
      f.textContent = img.dataset.cat || "Beat";
      if (wrap) wrap.appendChild(f);
    },

    cardHtml: function (it, usedImages) {
      var internal = !!(it.isEditorialArchive || it.category === "editorial");
      var raw = it.image || "";
      var local = prefix() + (FALLBACK[it.category] || FALLBACK.editorial);
      var key = String(raw).split("?")[0];
      var skipDup = !internal && key && usedImages && usedImages[key];
      var src = skipDup ? local : raw || local;
      if (!internal && key && usedImages && !skipDup) usedImages[key] = true;
      var proxy = proxyUrl(raw);
      var href = it.sourceUrl || "#";
      if (internal && it.publishDate) href = prefix() + permalinkPath(it.publishDate);
      var tgt = internal ? "" : ' target="_blank" rel="noopener"';
      var srcLabel = internal ? "Read full editorial →" : (it.source || "Source") + " →";
      return (
        '<a class="beat-card" href="' +
        esc(href) +
        '"' +
        tgt +
        ">" +
        '<div class="n-img"><img src="' +
        esc(src) +
        '" alt="" width="640" height="400" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-proxy="' +
        esc(proxy) +
        '" data-fallback="' +
        esc(local) +
        '" data-cat="' +
        esc(it.categoryLabel || it.category) +
        '" onerror="Desk.thumbFail(this)"></div>' +
        '<div class="beat-body">' +
        '<span class="tag ' +
        esc(it.category || "") +
        '">' +
        esc(it.category === "editorial" ? "Editorial" : it.categoryLabel || it.category) +
        "</span>" +
        "<h3>" +
        esc(plainText(it.title)) +
        "</h3>" +
        "<p>" +
        esc(plainText(it.summary || it.dek || "").slice(0, 220)) +
        "</p>" +
        '<p class="beat-src">' +
        esc(srcLabel) +
        "</p>" +
        "</div></a>"
      );
    },

    filtered: function () {
      if (Desk.cat === "all") return Desk.items;
      return Desk.items.filter(function (it) {
        return it.category === Desk.cat;
      });
    },

    drawGrid: function () {
      var grid = document.getElementById("beat-grid");
      var empty = document.getElementById("beat-empty");
      var loadWrap = document.getElementById("loadWrap");
      var edHost = document.getElementById("editorial");
      if (!grid) return;
      if (edHost) edHost.hidden = Desk.cat !== "all" && Desk.cat !== "editorial";
      var list = Desk.filtered();
      if (Desk.shown < PAGE_SIZE) Desk.shown = Math.min(PAGE_SIZE, list.length);
      var slice = list.slice(0, Desk.shown);
      var used = {};
      grid.innerHTML = slice.map(function (it) {
        return Desk.cardHtml(it, used);
      }).join("");
      if (empty) empty.hidden = slice.length > 0;
      if (loadWrap) loadWrap.hidden = Desk.shown >= list.length && Desk.archiveLoaded;
      var loadBtn = document.getElementById("loadMore");
      if (loadBtn && !loadBtn._bound) {
        loadBtn._bound = true;
        loadBtn.addEventListener("click", function () {
          Desk.shown += PAGE_SIZE;
          if (!Desk.archiveLoaded) Desk.fetchArchive();
          Desk.drawGrid();
        });
      }
    },

    fetchArchive: function () {
      if (Desk.archiveLoaded) return;
      fetch(prefix() + "data/archive.json", { cache: "no-cache" })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (pack) {
          Desk.archiveLoaded = true;
          if (!pack || !pack.batches) {
            Desk.drawGrid();
            return;
          }
          var seen = {};
          Desk.items.forEach(function (it) {
            seen[String(it.sourceUrl || it.id || "")] = true;
          });
          pack.batches.forEach(function (b) {
            (b.items || []).forEach(function (it) {
              var key = String(it.sourceUrl || it.id || "");
              if (!key || seen[key]) return;
              seen[key] = true;
              Desk.items.push(it);
            });
          });
          Desk.drawGrid();
        })
        .catch(function () {
          Desk.archiveLoaded = true;
          Desk.drawGrid();
        });
    },

    mountHome: function () {
      var host = document.getElementById("home-editorial");
      if (!host) return;
      Desk.liveEditorial = hasEditorial(global.EDITORIAL) ? global.EDITORIAL : null;
      Desk.indexHistory();
      Desk.activeEditorial = Desk.liveEditorial;
      Desk.renderEditorial(host, Desk.liveEditorial, { home: true });
    },
  };

  global.Desk = Desk;
  global.plainText = plainText;

  document.addEventListener("DOMContentLoaded", function () {
    if (document.getElementById("beat-grid")) Desk.initLatestBeat();
  });
})(window);
