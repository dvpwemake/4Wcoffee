/* Fourth Wave catalog editor — rescan vendor shops, drop stale SKUs, list new ones. */
(function (global) {
  "use strict";

  var PROXIES = [
    function (url) {
      return url;
    },
    function (url) {
      return "https://corsproxy.io/?" + encodeURIComponent(url);
    },
    function (url) {
      return "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
    },
  ];

  var MERCH = [
    "mug", "shirt", "t-shirt", "hoodie", "hat", "beanie", "sticker",
    "gift card", "giftcard", "kettle", "grinder", "machine", "course",
    "training", "sauce", "pie", "cake", "apparel", "tote", "candle",
    "soap", "subscription box", "sample box",
  ];
  var COFFEE_KEYS = [
    "coffee", "roast", "blend", "bean", "espresso", "yemen", "ethiopia",
    "colombia", "decaf", "arabica", "gesha", "bourbon", "natural", "washed",
  ];
  var OVERSIZE = /\b(2\s*lb|2\.5\s*lb|2,5\s*lb|500\s*g|family bag|first sip kit|4\s*[x×]\s*5|3\s*[x×]\s*12)\b/i;

  class CatalogKey {
    static normUrl(u) {
      return String(u || "")
        .split("?")[0]
        .replace(/\/+$/, "")
        .toLowerCase();
    }
    static slug(s) {
      return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
    }
    static ofProduct(p) {
      var url = CatalogKey.normUrl(p.url);
      if (url) return url;
      return (p.brand || "") + "|" + CatalogKey.slug(p.name);
    }
  }

  class ProductFilter {
    static isCoffee(title, extra) {
      var blob = (title + " " + (extra || "")).toLowerCase();
      if (OVERSIZE.test(blob)) return false;
      var merchHit = MERCH.some(function (x) {
        return blob.indexOf(x) !== -1;
      });
      var coffeeHit = COFFEE_KEYS.some(function (x) {
        return blob.indexOf(x) !== -1;
      });
      if (merchHit && !coffeeHit) return false;
      return coffeeHit || blob.indexOf("coffee") !== -1;
    }
    static money(v) {
      if (v == null || v === "") return "";
      var n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
      if (!n || n <= 0) return "";
      return "$" + n.toFixed(2);
    }
  }

  class Http {
    static async get(url) {
      var lastErr = null;
      for (var i = 0; i < PROXIES.length; i++) {
        var target = PROXIES[i](url);
        try {
          var res = await fetch(target, {
            method: "GET",
            credentials: "omit",
            headers: { Accept: "application/json, text/html;q=0.9,*/*;q=0.8" },
          });
          if (!res.ok) {
            lastErr = new Error("HTTP " + res.status);
            continue;
          }
          var text = await res.text();
          return { text: text, via: i === 0 ? "direct" : "proxy-" + i };
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("fetch failed");
    }
    static parseJson(text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    }
  }

  class VendorScanner {
    constructor(vendor) {
      this.vendor = vendor;
    }

    async scan() {
      if (this.vendor.kind === "static") {
        return { items: [], note: "static — skip auto-scan" };
      }
      if (this.vendor.kind === "shopify") {
        return this.scanShopify();
      }
      if (this.vendor.kind === "squarespace") {
        return this.scanSquarespace();
      }
      return this.scanHtml();
    }

    mapShopify(p) {
      var variant = (p.variants && p.variants[0]) || {};
      var price = ProductFilter.money(variant.price);
      if (!price) return null;
      var extra = [p.product_type, (p.tags || []).join(" "), p.body_html || ""].join(" ");
      if (!ProductFilter.isCoffee(p.title, extra)) return null;
      var img = "";
      if (p.images && p.images[0] && p.images[0].src) img = p.images[0].src;
      var handle = p.handle || "";
      var url = this.vendor.base.replace(/\/+$/, "") + "/products/" + handle;
      return {
        id: this.vendor.id + "-" + CatalogKey.slug(handle || p.title),
        name: p.title,
        price: price,
        priceValue: parseFloat(variant.price) || 0,
        description: "",
        specs: { type: p.product_type || "" },
        image: img,
        url: url,
        brand: this.vendor.brand,
        origin: "Various",
        kind: /blend/i.test(p.title + " " + extra) ? "Blend" : "SOE",
        pin: null,
        vendorId: this.vendor.id,
      };
    }

    async scanShopify() {
      var got = await Http.get(this.vendor.catalog);
      var json = Http.parseJson(got.text);
      var products = (json && json.products) || [];
      var items = [];
      for (var i = 0; i < products.length; i++) {
        var row = this.mapShopify(products[i]);
        if (row) items.push(row);
      }
      return { items: items, via: got.via, raw: products.length };
    }

    async scanSquarespace() {
      var got = await Http.get(this.vendor.catalog);
      var json = Http.parseJson(got.text);
      var items = [];
      var itemsSrc = [];
      if (json && json.items) itemsSrc = json.items;
      else if (json && json.collection && json.collection.items) itemsSrc = json.collection.items;
      for (var i = 0; i < itemsSrc.length; i++) {
        var it = itemsSrc[i];
        var title = it.title || it.name || "";
        var price = "";
        var priceValue = 0;
        if (it.structuredContent && it.structuredContent.variants && it.structuredContent.variants[0]) {
          var cents = it.structuredContent.variants[0].price;
          if (typeof cents === "number") {
            priceValue = cents / 100;
            price = ProductFilter.money(priceValue);
          }
        }
        if (!price && it.price) {
          price = ProductFilter.money(it.price);
          priceValue = parseFloat(String(it.price).replace(/[^0-9.]/g, "")) || 0;
        }
        if (!price) continue;
        if (!ProductFilter.isCoffee(title, it.excerpt || "")) continue;
        var path = it.fullUrl || it.urlId || "";
        var url = path.indexOf("http") === 0 ? path : this.vendor.base.replace(/\/+$/, "") + path;
        items.push({
          id: this.vendor.id + "-" + CatalogKey.slug(title),
          name: title,
          price: price,
          priceValue: priceValue,
          description: "",
          specs: {},
          image: (it.assetUrl || it.image || ""),
          url: url,
          brand: this.vendor.brand,
          origin: "Various",
          kind: /blend/i.test(title) ? "Blend" : "SOE",
          pin: null,
          vendorId: this.vendor.id,
        });
      }
      return { items: items, via: got.via, raw: itemsSrc.length };
    }

    async scanHtml() {
      var got = await Http.get(this.vendor.catalog);
      var html = got.text;
      var items = [];
      var re = /<a[^>]+href=["']([^"']*(?:product-page|products)\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var seen = {};
      var m;
      while ((m = re.exec(html))) {
        var href = m[1].split("?")[0];
        if (href.indexOf("http") !== 0) {
          href = this.vendor.base.replace(/\/+$/, "") + (href.charAt(0) === "/" ? href : "/" + href);
        }
        var key = CatalogKey.normUrl(href);
        if (seen[key]) continue;
        seen[key] = true;
        var text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (!text || text.length < 3 || text.length > 80) continue;
        if (!ProductFilter.isCoffee(text, href)) continue;
        items.push({
          id: this.vendor.id + "-" + CatalogKey.slug(text),
          name: text,
          price: "",
          priceValue: 0,
          description: "",
          specs: {},
          image: "",
          url: href,
          brand: this.vendor.brand,
          origin: "Various",
          kind: "SOE",
          pin: null,
          vendorId: this.vendor.id,
        });
      }
      return { items: items, via: got.via, raw: Object.keys(seen).length };
    }
  }

  class CatalogDiff {
    constructor(current, liveByVendor) {
      this.current = current || [];
      this.liveByVendor = liveByVendor || {};
    }

    vendorOf(p) {
      var brand = String(p.brand || "").toLowerCase();
      if (brand.indexOf("legacy") !== -1) return "legacy";
      if (brand.indexOf("portrait") !== -1) return "portrait";
      if (brand.indexOf("june") !== -1) return "june";
      if (brand.indexOf("qahwah") !== -1) return "qahwah";
      if (brand.indexOf("haraz") !== -1) return "haraz";
      if (brand.indexOf("polite") !== -1) return "polite";
      if (brand.indexOf("palace") !== -1) return "palace";
      if (brand.indexOf("habitat") !== -1) return "habitat";
      if (brand.indexOf("coffeecol") !== -1) return "coffeecol";
      return "other";
    }

    run(scannedVendorIds) {
      var liveKeys = {};
      var liveItems = [];
      Object.keys(this.liveByVendor).forEach(function (vid) {
        (this.liveByVendor[vid] || []).forEach(function (item) {
          var k = CatalogKey.ofProduct(item);
          liveKeys[k] = item;
          liveItems.push(item);
        });
      }, this);

      var outdated = [];
      var kept = [];
      this.current.forEach(function (p) {
        var vid = this.vendorOf(p);
        if (vid === "legacy") {
          kept.push(p);
          return;
        }
        if (scannedVendorIds.indexOf(vid) === -1) {
          kept.push(p);
          return;
        }
        var k = CatalogKey.ofProduct(p);
        var hit = liveKeys[k];
        if (!hit) {
          var nameKey = CatalogKey.slug(p.name);
          hit = liveItems.filter(function (it) {
            return it.vendorId === vid && CatalogKey.slug(it.name) === nameKey;
          })[0];
        }
        if (hit) kept.push(p);
        else outdated.push(p);
      }, this);

      var currentKeys = {};
      this.current.forEach(function (p) {
        currentKeys[CatalogKey.ofProduct(p)] = true;
        currentKeys[CatalogKey.slug(p.name)] = true;
      });
      var added = [];
      liveItems.forEach(function (item) {
        var k = CatalogKey.ofProduct(item);
        if (currentKeys[k] || currentKeys[CatalogKey.slug(item.name)]) return;
        added.push(item);
      });

      return { outdated: outdated, added: added, kept: kept };
    }
  }

  class EditorApp {
    constructor() {
      this.vendors = [];
      this.products = [];
      this.working = [];
      this.liveByVendor = {};
      this.diff = { outdated: [], added: [], kept: [] };
      this.logLines = [];
    }

    log(kind, msg) {
      var line = { t: new Date().toISOString().slice(11, 19), kind: kind, msg: msg };
      this.logLines.unshift(line);
      this.logLines = this.logLines.slice(0, 200);
      var box = document.getElementById("logE");
      if (!box) return;
      var el = document.createElement("div");
      el.className = "le";
      el.innerHTML =
        '<span class="t">' +
        line.t +
        "</span> <span class=\"" +
        (kind === "ok" ? "ok" : kind === "err" ? "er2" : "inf") +
        '">' +
        this.esc(msg) +
        "</span>";
      box.prepend(el);
    }

    esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    status(text, on) {
      var txt = document.getElementById("sTxt");
      var dot = document.getElementById("sDot");
      if (txt) txt.textContent = text;
      if (dot) {
        dot.className = "dot " + (on ? "on" : "idle");
      }
    }

    async boot() {
      this.products = (global.CATALOG && global.CATALOG.products) || [];
      this.working = this.products.map(function (p) {
        return Object.assign({}, p);
      });
      this.renderCurrent();
      try {
        var res = await fetch("vendors.json", { credentials: "same-origin" });
        var data = await res.json();
        this.vendors = data.vendors || [];
      } catch (err) {
        this.log("err", "Could not load vendors.json: " + err.message);
        this.vendors = [];
      }
      this.renderVendors();
      this.bindPatField();
      this.bindTabs();
      this.archive = { batches: [] };
      this.sources = null;
      this.reloadNewsDesk();
      this.fillEditorial();
      this.log("inf", "Loaded " + this.products.length + " catalog items.");
    }

    bindTabs() {
      var root = document.getElementById("editorApp");
      if (!root || root.dataset.tabsBound) return;
      root.dataset.tabsBound = "1";
      root.addEventListener("click", function (ev) {
        var btn = ev.target.closest("[data-tab]");
        if (!btn || !root.contains(btn)) return;
        global.showEditorTab(btn.getAttribute("data-tab"));
      });
    }

    thumbProxy(u) {
      if (!u) return "";
      return (
        "https://images.weserv.nl/?url=" +
        encodeURIComponent(String(u).replace(/^https?:\/\//, "")) +
        "&w=192&h=144&fit=cover&we&output=jpg"
      );
    }

    parseOgImage(html) {
      var pats = [
        /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
        /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
      ];
      for (var i = 0; i < pats.length; i++) {
        var m = html.match(pats[i]);
        if (m) return m[1].replace(/&amp;/g, "&").trim();
      }
      return "";
    }

    async fetchOgImage(url) {
      if (!url || url === "#") return "";
      var proxies = [
        "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
        "https://corsproxy.io/?" + encodeURIComponent(url),
      ];
      for (var i = 0; i < proxies.length; i++) {
        try {
          var r = await fetch(proxies[i]);
          if (!r.ok) continue;
          var og = this.parseOgImage(await r.text());
          if (og) return og;
        } catch (e) {
          /* next proxy */
        }
      }
      return "";
    }

    confirmCover(img, url) {
      var st = img.parentElement && img.parentElement.querySelector(".cover-st");
      function set(ok, msg) {
        if (!st) return;
        st.textContent = msg;
        st.className = "cover-st " + (ok ? "ok" : "er");
      }
      if (!url) {
        img.removeAttribute("src");
        img.classList.add("fail");
        set(false, "No URL");
        return;
      }
      img.classList.remove("fail");
      delete img.dataset.proxy;
      img.dataset.orig = url;
      img.onload = function () {
        set(true, "URL loads");
      };
      img.onerror = function () {
        if (!img.dataset.proxy) {
          img.dataset.proxy = "1";
          img.src = app.thumbProxy(url);
          return;
        }
        img.classList.add("fail");
        set(false, "URL failed");
      };
      img.src = url;
    }

    catOptions(selected) {
      var cats = {
        industry: "Industry",
        science: "Science",
        reviews: "Reviews",
        origin: "Origin",
        editorial: "Editorial",
      };
      return Object.keys(cats)
        .map(function (k) {
          return (
            '<option value="' +
            k +
            '"' +
            (selected === k ? " selected" : "") +
            ">" +
            cats[k] +
            "</option>"
          );
        })
        .join("");
    }

    newsScope() {
      var el = document.querySelector('input[name="newsScope"]:checked');
      return el && el.value === "all" ? "all" : "today";
    }

    flattenArchive() {
      var out = [];
      var seen = {};
      ((this.archive && this.archive.batches) || []).forEach(function (b) {
        (b.items || []).forEach(function (it) {
          var key = this.signalKey(it);
          if (!key || seen[key]) return;
          seen[key] = true;
          out.push(
            Object.assign({}, it, {
              batchId: b.batchId,
              day: String(b.scannedAt || "").slice(0, 10),
            })
          );
        }, this);
      }, this);
      return out;
    }

    collectNewsRows() {
      var scope = this.newsScope();
      var q = String((document.getElementById("newsDeskFilter") || {}).value || "")
        .trim()
        .toLowerCase();
      var rows;
      if (scope === "all") {
        rows = this.flattenArchive();
      } else {
        rows = ((global.SIGNALS && global.SIGNALS.items) || []).map(function (it, i) {
          return Object.assign({}, it, { _i: i, day: String((global.SIGNALS && global.SIGNALS.scannedAt) || "").slice(0, 10) });
        });
      }
      var total = rows.length;
      if (q) {
        rows = rows.filter(function (r) {
          return [r.title, r.source, r.category, r.categoryLabel, r.summary, r.day]
            .join(" ")
            .toLowerCase()
            .indexOf(q) !== -1;
        });
      }
      return { rows: rows, total: total, scope: scope, q: q };
    }

    renderSignals() {
      this.renderNewsDesk();
    }

    renderNewsDesk() {
      var host = document.getElementById("signalList");
      var meta = document.getElementById("newsDeskMeta");
      if (!host) return;
      var pack = this.collectNewsRows();
      if (meta) {
        if (!pack.total) {
          meta.textContent =
            pack.scope === "today"
              ? "No selected beats for today · run Scan feeds."
              : "No archive loaded · Reload archive.";
        } else if (pack.q) {
          meta.textContent = pack.rows.length + " shown of " + pack.total + " · filter on";
        } else {
          meta.textContent =
            (pack.scope === "today" ? "Today · " : "All archive · ") + pack.total + " beat(s)";
        }
      }
      if (!pack.rows.length) {
        host.innerHTML =
          '<div class="img-adj-empty">' +
          (pack.total
            ? "No matches for filter."
            : pack.scope === "today"
              ? "No selected beats for today. Click Scan feeds, then fix images or Delete."
              : "No archive. Click Reload archive.") +
          "</div>";
        return;
      }
      var self = this;
      host.innerHTML = pack.rows
        .map(function (it, i) {
          var img = it.image || "";
          var idx = it._i != null ? it._i : i;
          return (
            '<div class="img-adj-row" data-i="' +
            idx +
            '" data-batch="' +
            self.esc(it.batchId || "") +
            '" data-id="' +
            self.esc(it.id || "") +
            '" role="listitem"><div><img class="sig-thumb" alt="" referrerpolicy="no-referrer"><p class="cover-st">Checking…</p></div><div>' +
            '<label class="fl">Headline</label>' +
            '<input class="fi sig-title" value="' +
            self.esc(it.title || "") +
            '">' +
            '<p class="img-adj-sub">' +
            self.esc(it.day || "—") +
            " · " +
            self.esc(it.source || "") +
            "</p>" +
            '<label class="fl">Summary</label>' +
            '<textarea class="fi sig-sum" style="min-height:4.5rem">' +
            self.esc(it.summary || "") +
            "</textarea>" +
            '<label class="fl">Category</label>' +
            '<select class="fi sig-cat">' +
            self.catOptions(it.category) +
            "</select>" +
            '<label class="fl">Cover image URL</label>' +
            '<input type="url" class="fi sig-img" value="' +
            self.esc(img) +
            '" placeholder="https://…">' +
            '<div class="sig-actions">' +
            '<button type="button" class="btn btn-p" data-act="apply">Apply</button>' +
            '<button type="button" class="btn" data-act="fetch">From article</button>' +
            '<button type="button" class="btn btn-del" data-act="delete">Delete</button>' +
            (it.sourceUrl
              ? '<a class="btn" href="' + self.esc(it.sourceUrl) + '" target="_blank" rel="noopener">Article</a>'
              : "") +
            "</div></div></div>"
          );
        })
        .join("");
      host.querySelectorAll(".img-adj-row").forEach(function (row) {
        var inp = row.querySelector(".sig-img");
        var thumb = row.querySelector(".sig-thumb");
        self.confirmCover(thumb, inp && inp.value.trim());
        if (inp) {
          inp.addEventListener("input", function () {
            self.confirmCover(thumb, inp.value.trim());
          });
        }
      });
      if (!host.dataset.bound) {
        host.dataset.bound = "1";
        host.addEventListener("click", function (ev) {
          var btn = ev.target.closest("[data-act]");
          if (!btn) return;
          var row = btn.closest(".img-adj-row");
          if (!row) return;
          var act = btn.getAttribute("data-act");
          if (act === "apply") self.applyCover(row);
          if (act === "fetch") self.pullCover(row, btn);
          if (act === "delete") self.deleteSignal(row);
        });
      }
    }

    signalKey(it) {
      return String((it && (it.sourceUrl || it.title)) || "")
        .split("?")[0]
        .replace(/\/+$/, "")
        .toLowerCase();
    }

    isBlocked(it, deleted) {
      var key = this.signalKey(it);
      var title = String((it && it.title) || "").toLowerCase().slice(0, 80);
      return (deleted || []).some(function (d) {
        var dk = String((d && (d.url || d.sourceUrl)) || "")
          .split("?")[0]
          .replace(/\/+$/, "")
          .toLowerCase();
        var dt = String((d && d.title) || "").toLowerCase().slice(0, 80);
        return (key && dk && key === dk) || (title && dt && title === dt);
      });
    }

    rebuildByCategory(items) {
      var by = {};
      (items || []).forEach(function (it) {
        var c = it.category || "other";
        if (!by[c]) by[c] = [];
        by[c].push(it);
      });
      return by;
    }

    rowItem(row) {
      var data = global.SIGNALS || { items: [] };
      var batchId = row.getAttribute("data-batch") || "";
      var id = row.getAttribute("data-id") || "";
      if (this.newsScope() === "all" && batchId) {
        var batch = ((this.archive && this.archive.batches) || []).find(function (b) {
          return b.batchId === batchId;
        });
        if (!batch) return null;
        return (batch.items || []).find(function (it) {
          return String(it.id || "") === id;
        });
      }
      var i = parseInt(row.getAttribute("data-i"), 10);
      return data.items[i] || null;
    }

    writeRowFields(row, it) {
      if (!it || !row) return;
      var title = row.querySelector(".sig-title");
      var sum = row.querySelector(".sig-sum");
      var cat = row.querySelector(".sig-cat");
      var img = row.querySelector(".sig-img");
      if (title) it.title = title.value.trim();
      if (sum) it.summary = sum.value.trim();
      if (cat) {
        it.category = cat.value;
        var labels = (global.SIGNALS && global.SIGNALS.categories) || {};
        it.categoryLabel = labels[it.category] || it.category;
      }
      if (img) it.image = img.value.trim();
    }

    deleteSignal(row) {
      var it = this.rowItem(row);
      if (!it) return;
      if (!window.confirm("Remove this story from Latest Beat?\n\n" + (it.title || ""))) return;
      var data = global.SIGNALS || { items: [] };
      if (!data.deleted) data.deleted = [];
      data.deleted.push({
        url: it.sourceUrl || "",
        title: it.title || "",
        deletedAt: new Date().toISOString(),
      });
      data.items = (data.items || []).filter(function (x) {
        return x !== it && String(x.id || "") !== String(it.id || "");
      });
      data.byCategory = this.rebuildByCategory(data.items);
      global.SIGNALS = data;
      if (this.archive && this.archive.batches) {
        this.archive.batches.forEach(function (b) {
          b.items = (b.items || []).filter(function (x) {
            return String(x.id || "") !== String(it.id || "") && x.sourceUrl !== it.sourceUrl;
          });
        });
      }
      this.renderNewsDesk();
      this.renderEditorialPreview();
      this.refreshEdHeroPicker();
      this.toast("Removed from Latest Beat list.", "success");
      this.log("ok", "Deleted signal: " + (it.title || ""));
      if (this.readPat()) this.publishSignals();
      else this.toast("Deleted here. Paste a GitHub PAT, then Publish Latest Beat.", "info");
    }

    applyCover(row) {
      var it = this.rowItem(row);
      if (!it) return;
      this.writeRowFields(row, it);
      this.confirmCover(row.querySelector(".sig-thumb"), it.image || "");
      this.toast("Saved on this card.", "success");
    }

    async pullCover(row, btn) {
      var it = this.rowItem(row);
      if (!it || !it.sourceUrl) {
        this.toast("No article URL on this item.", "error");
        return;
      }
      if (btn) btn.disabled = true;
      this.toast("Fetching og:image…", "info");
      var og = await this.fetchOgImage(it.sourceUrl);
      if (btn) btn.disabled = false;
      if (!og) {
        this.toast("No og:image found.", "error");
        return;
      }
      var inp = row.querySelector(".sig-img");
      if (inp) inp.value = og;
      this.confirmCover(row.querySelector(".sig-thumb"), og);
      this.toast("Image URL loaded — click Apply to save.", "info");
    }

    async fetchAllCovers() {
      var data = global.SIGNALS || { items: [] };
      var items = data.items || [];
      this.toast("Fetching covers…", "info");
      for (var i = 0; i < items.length; i++) {
        if (items[i].image) continue;
        var og = await this.fetchOgImage(items[i].sourceUrl);
        if (og) items[i].image = og;
      }
      this.renderSignals();
      this.toast("Cover pass finished.", "success");
    }

    parseRss(xml, source) {
      var items = [];
      var doc;
      try {
        doc = new DOMParser().parseFromString(xml, "text/xml");
      } catch (e) {
        return items;
      }
      if (doc.querySelector("parsererror")) return items;
      var nodes = doc.querySelectorAll("item, entry");
      nodes.forEach(function (node) {
        var title = (node.querySelector("title") && node.querySelector("title").textContent) || "";
        var link = "";
        var linkNodes = node.querySelectorAll("link");
        for (var li = 0; li < linkNodes.length; li++) {
          var linkEl = linkNodes[li];
          var rel = (linkEl.getAttribute("rel") || "").toLowerCase();
          var href = (linkEl.getAttribute("href") || linkEl.textContent || "").trim();
          if (!href) continue;
          if (rel === "alternate" || !rel || rel === "self") {
            if (rel === "alternate" || !link) link = href;
          }
        }
        var guid = node.querySelector("guid");
        if (!link && guid) link = (guid.textContent || "").trim();
        var descEl = node.querySelector("description, summary, content");
        var desc = descEl ? descEl.textContent : "";
        var dateEl = node.querySelector("pubDate, published, updated");
        var dateRaw = dateEl ? dateEl.textContent : "";
        var img = "";
        var enc = node.querySelector("enclosure");
        if (enc && enc.getAttribute("url") && /image/i.test(enc.getAttribute("type") || "image")) {
          img = enc.getAttribute("url");
        }
        var media = node.getElementsByTagName("media:content")[0];
        if (!img && media && media.getAttribute("url")) img = media.getAttribute("url");
        var im = desc.match(/<img[^>]+src=["']([^"']+)/i);
        if (!img && im) img = im[1];
        title = title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        desc = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
        if (!title || !link || link.indexOf("http") !== 0) return;
        var ts = Date.parse(dateRaw) || 0;
        items.push({
          title: title,
          source: source,
          sourceUrl: link.split("?")[0],
          summary: desc,
          image: img,
          publishedAt: ts ? new Date(ts).toISOString() : "",
          _ts: ts,
        });
      });
      return items;
    }

    parseRssJson(json, source) {
      var items = [];
      var list = (json && json.items) || [];
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var title = String(it.title || "").trim();
        var link = String(it.link || it.url || "").trim();
        if (!title || link.indexOf("http") !== 0) continue;
        var ts = Date.parse(it.pubDate || it.published || "") || 0;
        var img = "";
        if (it.thumbnail) img = it.thumbnail;
        if (!img && it.enclosure && it.enclosure.link) img = it.enclosure.link;
        items.push({
          title: title,
          source: source,
          sourceUrl: link.split("?")[0],
          summary: String(it.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 280),
          image: img,
          publishedAt: ts ? new Date(ts).toISOString() : "",
          _ts: ts,
        });
      }
      return items;
    }

    async fetchFeed(url, source) {
      var self = this;
      var attempts = [
        "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(url),
        "https://corsproxy.io/?url=" + encodeURIComponent(url),
        "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
      ];
      var lastErr = null;
      for (var i = 0; i < attempts.length; i++) {
        try {
          var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
          var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 14000) : null;
          var res = await fetch(attempts[i], {
            method: "GET",
            credentials: "omit",
            signal: ctrl ? ctrl.signal : undefined,
            headers: { Accept: "application/json, application/rss+xml, application/xml, text/xml, */*" },
          });
          if (timer) clearTimeout(timer);
          if (!res.ok) {
            lastErr = new Error("HTTP " + res.status);
            continue;
          }
          var text = await res.text();
          var trimmed = text.replace(/^\uFEFF/, "").trim();
          if (trimmed.charAt(0) === "{") {
            var json = Http.parseJson(trimmed);
            if (json && json.status === "ok" && json.items) {
              return self.parseRssJson(json, source);
            }
            if (json && json.items && json.items.length) {
              return self.parseRssJson(json, source);
            }
          }
          var parsed = self.parseRss(trimmed, source);
          if (parsed.length) return parsed;
          lastErr = new Error("empty feed");
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("fetch failed");
    }

    async scanSignals() {
      var btn = document.getElementById("sigScanBtn");
      var meta = document.getElementById("sigScanMeta");
      if (btn) btn.classList.add("ld");
      this.toast("Scanning coffee feeds…", "info");
      if (meta) meta.textContent = "Scanning…";
      var src;
      try {
        var res = await fetch("data/sources.json?v=" + Date.now(), { credentials: "same-origin" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        src = await res.json();
      } catch (e) {
        if (btn) btn.classList.remove("ld");
        this.toast("Could not load data/sources.json", "error");
        this.log("err", "sources.json: " + (e.message || e));
        return;
      }
      try {
      var skip = ["shipping update", "check your email", "sponsored"];
      var cats = src.categories || {};
      var pick = src.pickCount || 2;
      var byCategory = {};
      var labels = {};
      var logN = 0;
      var catIds = Object.keys(cats);
      for (var c = 0; c < catIds.length; c++) {
        var catId = catIds[c];
        var cat = cats[catId];
        labels[catId] = cat.label;
        var pool = [];
        var feeds = cat.feeds || [];
        var blocked = (src.blacklist || (this.sources && this.sources.blacklist) || []).map(function (h) {
          return String(h || "").toLowerCase().replace(/^www\./, "");
        });
        for (var f = 0; f < feeds.length; f++) {
          var feed = feeds[f];
          try {
            var host = "";
            try {
              host = new URL(feed.url).hostname.replace(/^www\./, "").toLowerCase();
            } catch (e0) {
              host = "";
            }
            if (host && blocked.indexOf(host) !== -1) {
              this.log("inf", feed.name + " skipped (blacklist)");
              continue;
            }
            var parsed = await this.fetchFeed(feed.url, feed.name);
            pool = pool.concat(parsed);
            logN += parsed.length;
            this.log("ok", feed.name + ": " + parsed.length + " items");
            if (meta) meta.textContent = "Scanning " + feed.name + "…";
          } catch (err) {
            this.log("err", feed.name + " failed: " + (err.message || err));
          }
        }
        pool.sort(function (a, b) {
          return (b._ts || 0) - (a._ts || 0);
        });
        var seen = {};
        var fresh = [];
        var stale = [];
        var known = {};
        this.flattenArchive().forEach(function (it) {
          var k = this.signalKey(it);
          if (k) known[k] = true;
        }, this);
        for (var i = 0; i < pool.length && fresh.length < pick; i++) {
          var it = pool[i];
          var key = String(it.title || "").toLowerCase().slice(0, 80);
          if (seen[key]) continue;
          if (skip.some(function (s) { return key.indexOf(s) !== -1; })) continue;
          if (this.isBlocked(it, (global.SIGNALS && global.SIGNALS.deleted) || [])) continue;
          try {
            var ih = new URL(it.sourceUrl || "").hostname.replace(/^www\./, "").toLowerCase();
            if (ih && blocked.indexOf(ih) !== -1) continue;
          } catch (e1) {
            /* keep */
          }
          seen[key] = true;
          delete it._ts;
          it.category = catId;
          it.categoryLabel = cat.label;
          if (known[this.signalKey(it)]) stale.push(it);
          else fresh.push(it);
        }
        var top = fresh.concat(stale).slice(0, pick);
        top.forEach(function (it, n) {
          it.id = catId + "-" + (n + 1);
        });
        byCategory[catId] = top;
      }
      var items = [];
      catIds.forEach(function (id) {
        items = items.concat(byCategory[id] || []);
      });
      global.SIGNALS = {
        scannedAt: new Date().toISOString(),
        categories: labels,
        items: items,
        byCategory: byCategory,
        deleted: (global.SIGNALS && global.SIGNALS.deleted) || [],
      };
      this.mergeScanIntoArchive(global.SIGNALS);
      this.renderNewsDesk();
      this.renderEditorialPreview();
      this.refreshEdHeroPicker();
      if (btn) btn.classList.remove("ld");
      var msg = items.length
        ? items.length + " beats from " + logN + " feed items"
        : "Scan finished with 0 items — feeds blocked or empty";
      if (meta) meta.textContent = msg;
      this.toast(msg, items.length ? "success" : "error");
      this.log(items.length ? "ok" : "err", "Signal scan: " + msg);
      } catch (err) {
        this.toast("Scan failed: " + (err.message || err), "error");
        this.log("err", "Scan failed: " + (err.message || err));
        if (meta) meta.textContent = "Scan failed";
      } finally {
        if (btn) btn.classList.remove("ld");
      }
    }

    collectSignals() {
      var data = global.SIGNALS || { items: [], categories: {}, deleted: [] };
      if (!data.deleted) data.deleted = [];
      var self = this;
      document.querySelectorAll("#signalList .img-adj-row").forEach(function (row) {
        var it = self.rowItem(row);
        if (it) self.writeRowFields(row, it);
      });
      data.byCategory = this.rebuildByCategory(data.items || []);
      return data;
    }

    fillEditorial() {
      var published = global.EDITORIAL || {};
      var draft = global.EDITORIAL_DRAFT || {};
      var usingDraft = draft.status === "draft" && draft.title;
      var ed = usingDraft ? draft : published;
      var banner = document.getElementById("edDraftBanner");
      if (banner) {
        banner.hidden = !usingDraft;
        banner.textContent = usingDraft
          ? "Morning draft (" +
            (draft.publishDate || "") +
            ") — not live. Edit, then Publish. Latest Beat still shows the last published piece."
          : "";
      }
      function set(id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val || "";
      }
      set("edDate", ed.publishDate || new Date().toISOString().slice(0, 10));
      set("edStatus", ed.status || (usingDraft ? "draft" : "published"));
      set("edTitle", ed.title);
      set("edDek", ed.dek);
      set("edAuthor", ed.authorName || "Dr. Wallace Lynch");
      set("edAuthorTitle", ed.authorTitle || "Editor in Chief");
      set("edHero", ed.heroImage);
      set("edCredit", ed.heroCredit);
      set("edHeroSource", ed.heroSource);
      set("edHeroSourceUrl", ed.heroSourceUrl);
      var b = document.getElementById("edBody");
      if (b) b.value = ed.body || (ed.paragraphs || []).join("\n\n");
      this.countEditorial();
      if (b && !b.dataset.bound) {
        b.dataset.bound = "1";
        b.addEventListener("input", this.countEditorial.bind(this));
      }
      var h = document.getElementById("edHero");
      if (h && !h.dataset.bound) {
        h.dataset.bound = "1";
        h.addEventListener("input", this.updEdImg.bind(this));
      }
      this.updEdImg();
      this.renderEditorialPreview();
      this.refreshEdHeroPicker();
    }

    renderEditorialPreview() {
      var cards = document.getElementById("edSignalCards");
      var urls = document.getElementById("edSignalUrls");
      if (!cards || !urls) return;
      var items = (global.SIGNALS && global.SIGNALS.items) || [];
      if (!items.length) {
        cards.innerHTML = '<p class="empty">No daily signal yet. Run Scan feeds or wait for the 8:15 AM Pacific packet (ready by 9 AM Pacific).</p>';
        urls.innerHTML = "";
        return;
      }
      cards.innerHTML = items
        .map(function (it) {
          return (
            '<div class="ed-hit"><i>' +
            this.esc(it.categoryLabel || it.category) +
            " · " +
            this.esc(it.source) +
            "</i><b>" +
            this.esc(it.title) +
            "</b></div>"
          );
        }, this)
        .join("");
      urls.innerHTML = items
        .map(function (it) {
          var u = it.sourceUrl || "";
          if (!u) return "";
          return (
            "<li><a href=\"" +
            this.esc(u) +
            '" target="_blank" rel="noopener">' +
            this.esc(u) +
            "</a></li>"
          );
        }, this)
        .join("");
    }

    countEditorial() {
      var b = document.getElementById("edBody");
      var w = document.getElementById("edWords");
      var wc = document.getElementById("edWC");
      var n = b && b.value ? b.value.trim().split(/\s+/).filter(Boolean).length : 0;
      if (w) w.textContent = n + " words";
      if (wc) wc.textContent = String(n);
    }

    val(id) {
      var el = document.getElementById(id);
      return el && el.value ? String(el.value).trim() : "";
    }

    collectEditorial(status) {
      var body = this.val("edBody");
      var paras = body.split(/\n\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
      var day = this.val("edDate") || new Date().toISOString().slice(0, 10);
      return {
        id: "ed_" + day,
        publishDate: day,
        status: status || this.val("edStatus") || "draft",
        title: this.val("edTitle"),
        dek: this.val("edDek"),
        heroImage: this.val("edHero"),
        heroCredit: this.val("edCredit"),
        heroSource: this.val("edHeroSource"),
        heroSourceUrl: this.val("edHeroSourceUrl"),
        authorName: this.val("edAuthor") || "Dr. Wallace Lynch",
        authorTitle: this.val("edAuthorTitle") || "Editor in Chief",
        body: body,
        paragraphs: paras,
        wordCount: body ? body.split(/\s+/).filter(Boolean).length : 0,
      };
    }

    isOutlineBrief(ed) {
      if (!ed) return true;
      var blob = String(ed.title || "") + "\n" + String(ed.body || "");
      if (/EDITORIAL BRIEF\s*\(outline only/i.test(blob)) return true;
      if (/^Editorial brief\s*[-—–]/i.test(String(ed.title || "").trim())) return true;
      if (/DRAFT — not live/i.test(blob) || /Selected articles of the day/i.test(blob)) return true;
      if ((ed.wordCount || 0) < 120) return true;
      return false;
    }

    displayDate(iso) {
      var d = String(iso || "").slice(0, 10);
      var m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return d;
      var months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      return months[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
    }

    brandHead(pfx) {
      pfx = pfx || "";
      return (
        '<link rel="icon" href="' + pfx + 'image/favicon.svg" type="image/svg+xml">' +
        '<link rel="icon" href="' + pfx + 'favicon.ico" sizes="any">' +
        '<link rel="apple-touch-icon" href="' + pfx + 'image/apple-touch-icon.png">' +
        '<meta name="theme-color" content="#181818">' +
        '<meta name="color-scheme" content="dark">'
      );
    }

    slimEditorial(ed) {
      return {
        id: ed.id,
        publishDate: ed.publishDate,
        status: ed.status || "published",
        title: ed.title,
        dek: ed.dek || "",
        authorName: ed.authorName || "Dr. Wallace Lynch",
        authorTitle: ed.authorTitle || "Editor in Chief",
        heroImage: ed.heroImage || "",
        heroCredit: ed.heroCredit || "",
        heroSource: ed.heroSource || "",
        heroSourceUrl: ed.heroSourceUrl || "",
        wordCount: ed.wordCount || 0,
        paragraphs: ed.paragraphs || [],
      };
    }

    mergeHistory(ed) {
      var hist = (global.EDITORIAL_HISTORY || []).slice();
      var live = global.EDITORIAL;
      if (
        live &&
        live.publishDate &&
        live.publishDate !== ed.publishDate &&
        (live.paragraphs || []).length
      ) {
        hist = hist.filter(function (h) {
          return h.publishDate !== live.publishDate;
        });
        hist.unshift(this.slimEditorial(live));
      }
      hist = hist.filter(function (h) {
        return h.publishDate !== ed.publishDate;
      });
      return hist.slice(0, 60);
    }

    editorialFile(ed, history) {
      var pack = this.slimEditorial(ed);
      pack.body = (ed.body || "").trim();
      pack.status = "published";
      return (
        "window.EDITORIAL = " +
        JSON.stringify(pack) +
        ";\nwindow.EDITORIAL_HISTORY = " +
        JSON.stringify(history || []) +
        ";\nwindow.EDITORIAL.body = (window.EDITORIAL.paragraphs || []).join(\"\\n\\n\");\n"
      );
    }

    permalinkHtml(ed) {
      var date = ed.publishDate;
      var title = ed.title || "Daily editorial";
      var dek = ed.dek || "";
      var author = ed.authorName || "Dr. Wallace Lynch";
      var role = ed.authorTitle || "Editor in Chief";
      var paras = ed.paragraphs || [];
      var wc = ed.wordCount || 0;
      var hero = ed.heroImage || "";
      var credit = ed.heroCredit || ed.heroSource || "";
      var url = "https://fourthwavecoffee.org/e/" + date + ".html";
      var desc = dek || paras[0] || "Fourth Wave Coffee daily editorial";
      var prose = paras
        .map(function (p) {
          return "<p>" + this.esc(p) + "</p>";
        }, this)
        .join("\n");
      var shareT = encodeURIComponent(title + " — Fourth Wave Coffee");
      var shareU = encodeURIComponent(url);
      var shareB = encodeURIComponent(title + " — Fourth Wave Coffee\n\n" + url);
      var heroBlock = hero
        ? '<div class="ed-hero"><img src="' +
          this.esc(hero) +
          '" alt="" width="1280" height="720" fetchpriority="high" decoding="async" referrerpolicy="no-referrer"></div>'
        : "";
      var creditBlock = credit
        ? '<p class="ed-credit">Photo: ' + this.esc(credit) + "</p>"
        : "";
      return (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        "<title>" +
        this.esc(title) +
        " | Fourth Wave Coffee</title>\n" +
        '<meta name="description" content="' +
        this.esc(desc) +
        '">\n' +
        '<link rel="canonical" href="' +
        this.esc(url) +
        '">\n' +
        '<meta property="og:type" content="article">\n' +
        '<meta property="og:url" content="' +
        this.esc(url) +
        '">\n' +
        '<meta property="og:title" content="' +
        this.esc(title) +
        '">\n' +
        '<meta property="og:description" content="' +
        this.esc(desc) +
        '">\n' +
        (hero
          ? '<meta property="og:image" content="' + this.esc(hero) + '">\n'
          : "") +
        this.brandHead("../") +
        '<link rel="stylesheet" href="../site.css?v=20260908b">\n' +
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">\n' +
        "</head>\n<body>\n<div data-nav></div>\n<main class=\"wrap ed-permalink\">\n" +
        '<div class="ed-kicker">Daily editorial · ' +
        this.esc(this.displayDate(date)) +
        "</div>\n<article class=\"ed-card\">" +
        heroBlock +
        creditBlock +
        '<div class="ed-body"><h2>' +
        this.esc(title) +
        "</h2>" +
        (dek ? '<p class="ed-dek">' + this.esc(dek) + "</p>" : "") +
        '<div class="ed-byline-row"><p class="ed-byline">By ' +
        this.esc(author) +
        '<span class="ed-role"> ' +
        this.esc(role) +
        '</span></p><p class="ed-meta"><time datetime="' +
        this.esc(date) +
        '">' +
        this.esc(this.displayDate(date)) +
        "</time></p></div><div class=\"ed-prose\">" +
        prose +
        '</div><div class="ed-share-wrap"><span class="ed-share-label">Share</span><div class="ed-share">' +
        '<a class="ed-share-btn" href="https://twitter.com/intent/tweet?url=' +
        shareU +
        "&text=" +
        shareT +
        '" target="_blank" rel="noopener">X</a>' +
        '<a class="ed-share-btn" href="https://www.linkedin.com/sharing/share-offsite/?url=' +
        shareU +
        '" target="_blank" rel="noopener">in</a>' +
        '<a class="ed-share-btn" href="mailto:?subject=' +
        shareT +
        "&body=" +
        shareB +
        '">Email</a>' +
        '<button type="button" class="ed-share-btn" data-copy-share="' +
        this.esc(url) +
        '">Copy</button></div></div>' +
        '<p class="ed-footer-links"><a href="../latestbeat.html#editorial">← Today’s desk</a>' +
        '<a href="../latestbeat.html">Latest Beat</a><a href="./">All editorials</a></p>' +
        "</div></article></main><footer data-footer></footer>" +
        '<script src="../site.js?v=20260908b"></script>\n</body></html>\n'
      );
    }

    archiveIndexHtml(ed, history) {
      var fallback = "../image/carosal/cafe-scene-6887.jpg";
      var rows = [
        {
          date: ed.publishDate,
          title: ed.title,
          dek: ed.dek || "",
          hero: ed.heroImage || "",
        },
      ].concat(
        (history || []).map(function (h) {
          return {
            date: h.publishDate,
            title: h.title,
            dek: h.dek || "",
            hero: h.heroImage || "",
          };
        })
      );
      var seen = {};
      rows = rows.filter(function (r) {
        if (!r.date || seen[r.date]) return false;
        seen[r.date] = true;
        return true;
      });
      rows.sort(function (a, b) {
        return a.date < b.date ? 1 : -1;
      });
      var list = rows
        .map(function (r) {
          var hero = r.hero || fallback;
          return (
            '<a class="ed-archive-card" href="' +
            this.esc(r.date) +
            '.html"><div class="n-img"><img src="' +
            this.esc(hero) +
            '" alt="" width="640" height="400" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>' +
            '<div class="ed-archive-body"><time datetime="' +
            this.esc(r.date) +
            '">' +
            this.esc(this.displayDate(r.date)) +
            "</time><strong>" +
            this.esc(r.title) +
            "</strong>" +
            (r.dek ? "<span>" + this.esc(r.dek) + "</span>" : "") +
            "</div></a>"
          );
        }, this)
        .join("");
      return (
        "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        "<title>Editorials | Fourth Wave Coffee</title>" +
        this.brandHead("../") +
        '<link rel="stylesheet" href="../site.css?v=20260908b">' +
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">' +
        "</head><body><div data-nav></div>" +
        '<header class="page-hero wrap"><h1>Editorials.</h1><p>Daily desk archive. Newest first.</p></header>' +
        '<main class="wrap"><div class="ed-archive-list">' +
        list +
        "</div></main><footer data-footer></footer>" +
        '<script src="../site.js?v=20260908b"></script></body></html>\n'
      );
    }

    async publishEditorial() {
      var ed = this.collectEditorial("published");
      if (!ed.title || !ed.body) {
        this.toast("Title and body are required to publish.", "error");
        return;
      }
      if (this.isOutlineBrief(ed)) {
        this.toast("Refuse outline brief. Replace with finished ~300-word prose first.", "error");
        return;
      }
      var history = this.mergeHistory(ed);
      global.EDITORIAL = ed;
      global.EDITORIAL_HISTORY = history;
      this.toast("Publishing editorial…", "info");
      var ok = await this.putGithubFile(
        "editorial.data.js",
        this.editorialFile(ed, history),
        "Publish editorial " + ed.publishDate + ": " + ed.title
      );
      if (!ok) return;
      await this.putGithubFile(
        "e/" + ed.publishDate + ".html",
        this.permalinkHtml(ed),
        "Editorial permalink " + ed.publishDate
      );
      await this.putGithubFile(
        "e/index.html",
        this.archiveIndexHtml(ed, history),
        "Editorial archive index " + ed.publishDate
      );
      this.archivePreviousEditorial(history[0]);
      if (this.archive) {
        await this.putGithubFile(
          "data/archive.json",
          JSON.stringify(this.archive, null, 2) + "\n",
          "Archive previous editorial as Latest Beat card"
        );
      }
      this.log("ok", "Published editorial.data.js + e/" + ed.publishDate + ".html — " + ed.title);
      this.toast("Editorial published. Home, Latest Beat, and permalink will update after Pages deploys.", "success");
    }

    mergeScanIntoArchive(batch) {
      if (!this.archive) this.archive = { batches: [] };
      var scanned = (batch && batch.scannedAt) || new Date().toISOString();
      var batchId = "auto_" + scanned.replace(/:/g, "-").slice(0, 19);
      var slim = (batch.items || []).map(function (it) {
        return {
          id: it.id,
          title: it.title,
          source: it.source,
          sourceUrl: it.sourceUrl,
          summary: it.summary,
          image: it.image || "",
          publishedAt: it.publishedAt,
          category: it.category,
          categoryLabel: it.categoryLabel,
        };
      });
      var batches = (this.archive.batches || []).filter(function (b) {
        return b.batchId !== batchId;
      });
      batches.unshift({ batchId: batchId, scannedAt: scanned, items: slim });
      this.archive.batches = batches.slice(0, 45);
    }

    archivePreviousEditorial(prev) {
      if (!prev || !prev.publishDate || !prev.title) return;
      if (!this.archive) this.archive = { batches: [] };
      var id = "editorial_" + prev.publishDate;
      var card = {
        id: id,
        rank: 0,
        title: prev.title,
        category: "editorial",
        categoryLabel: "Editorial",
        summary: prev.dek || "",
        image: prev.heroImage || "",
        source: "Fourth Wave Coffee · Editorial",
        sourceUrl: "https://fourthwavecoffee.org/e/" + prev.publishDate + ".html",
        isEditorialArchive: true,
        publishDate: prev.publishDate,
      };
      var batches = (this.archive.batches || []).filter(function (b) {
        return b.batchId !== id;
      });
      batches.unshift({
        batchId: id,
        scannedAt: new Date().toISOString(),
        kind: "editorial_archive",
        items: [card],
      });
      this.archive.batches = batches.slice(0, 45);
    }

    async reloadNewsDesk() {
      try {
        var res = await fetch("data/archive.json?v=" + Date.now(), { credentials: "same-origin" });
        if (res.ok) this.archive = await res.json();
      } catch (e) {
        this.archive = this.archive || { batches: [] };
      }
      this.renderNewsDesk();
    }

    updEdImg() {
      var box = document.getElementById("edImgP");
      var url = this.val("edHero");
      if (!box) return;
      if (!url) {
        box.innerHTML = '<span class="ph-t">Hero preview</span>';
        return;
      }
      box.innerHTML = '<img alt="" referrerpolicy="no-referrer" src="' + this.esc(url) + '">';
    }

    heroCandidates() {
      var out = [];
      var seen = {};
      ((global.SIGNALS && global.SIGNALS.items) || []).forEach(function (h) {
        var url = String((h && h.image) || "").trim();
        if (!url) return;
        var key = url.split("?")[0].toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        out.push({
          image: url,
          title: h.title || "",
          source: h.source || "",
          category: h.categoryLabel || h.category || "",
          sourceUrl: h.sourceUrl || "",
        });
      });
      return out;
    }

    refreshEdHeroPicker() {
      var root = document.getElementById("edHeroPick");
      var countEl = document.getElementById("edHeroPickCount");
      if (!root) return;
      var cands = this.heroCandidates();
      var cur = this.val("edHero").split("?")[0].toLowerCase();
      if (countEl) {
        countEl.textContent = cands.length
          ? cands.length + " image" + (cands.length === 1 ? "" : "s") + " from selected articles"
          : "No article images";
      }
      if (!cands.length) {
        root.innerHTML =
          '<div class="ed-hero-pick-empty">No article head images on file. Run Scan feeds, then Refresh thumbs. You can still paste a URL below.</div>';
        return;
      }
      var self = this;
      root.innerHTML = cands
        .map(function (c, i) {
          var sel = cur && cur === c.image.split("?")[0].toLowerCase();
          return (
            '<button type="button" class="ed-hero-pick-card' +
            (sel ? " sel" : "") +
            '" data-hero="' +
            i +
            '"><img alt="" referrerpolicy="no-referrer" src="' +
            self.esc(self.thumbProxy(c.image) || c.image) +
            '"><span class="ed-hero-pick-meta"><b>' +
            self.esc(c.title || "Untitled") +
            "</b>" +
            self.esc(c.category) +
            " · " +
            self.esc(c.source || "—") +
            "</span></button>"
          );
        })
        .join("");
      if (!root.dataset.bound) {
        root.dataset.bound = "1";
        root.addEventListener("click", function (ev) {
          var btn = ev.target.closest("[data-hero]");
          if (!btn) return;
          var c = self.heroCandidates()[parseInt(btn.getAttribute("data-hero"), 10)];
          if (!c) return;
          var h = document.getElementById("edHero");
          var cr = document.getElementById("edCredit");
          var hs = document.getElementById("edHeroSource");
          var hu = document.getElementById("edHeroSourceUrl");
          if (h) h.value = c.image;
          if (cr) cr.value = c.title || c.source || "Field signal";
          if (hs) hs.value = c.source || "Selected article";
          if (hu) hu.value = c.sourceUrl || "";
          self.updEdImg();
          self.refreshEdHeroPicker();
        });
      }
    }

    forceEditorialDraft() {
      var items = (global.SIGNALS && global.SIGNALS.items) || [];
      var day = new Date().toISOString().slice(0, 10);
      var first = items[0] || {};
      var second = items[1] || {};
      var lines = [
        "DRAFT — not live. Rewrite before Publish. On " + this.displayDate(day) + ", the desk holds these beats.",
      ];
      items.forEach(function (it) {
        lines.push(
          (it.categoryLabel || it.category || "") +
            ": " +
            (it.title || "") +
            " (" +
            (it.source || "") +
            "). " +
            (it.summary || "")
        );
      });
      lines.push("Edit title, dek, and body. Then Publish to Latest Beat.");
      var body = lines.join("\n\n");
      var titleEl = document.getElementById("edTitle");
      var dekEl = document.getElementById("edDek");
      var dateEl = document.getElementById("edDate");
      var stEl = document.getElementById("edStatus");
      var bodyEl = document.getElementById("edBody");
      if (dateEl) dateEl.value = day;
      if (stEl) stEl.value = "draft";
      if (titleEl) titleEl.value = String(first.title || "Daily beat").slice(0, 72);
      if (dekEl) {
        dekEl.value = [first.source, second.title].filter(Boolean).join(". ").slice(0, 140);
      }
      if (bodyEl) bodyEl.value = body;
      if (first.image) {
        var h = document.getElementById("edHero");
        if (h) h.value = first.image;
        var cr = document.getElementById("edCredit");
        if (cr) cr.value = first.source || "";
        var hs = document.getElementById("edHeroSource");
        if (hs) hs.value = first.source || "";
        var hu = document.getElementById("edHeroSourceUrl");
        if (hu) hu.value = first.sourceUrl || "";
      }
      this.countEditorial();
      this.updEdImg();
      this.refreshEdHeroPicker();
      this.toast("Outline draft loaded. Replace with finished prose before Publish.", "info");
    }

    previewEditorial() {
      var ed = this.collectEditorial();
      var box = document.getElementById("edPrevBody");
      var mo = document.getElementById("edPrevM");
      if (!box || !mo) return;
      var paras = (ed.paragraphs || [])
        .map(function (p) {
          return "<p>" + this.esc(p) + "</p>";
        }, this)
        .join("");
      box.innerHTML =
        "<p class=\"img-adj-sub\">" +
        this.esc(this.displayDate(ed.publishDate)) +
        " · " +
        ed.wordCount +
        " words</p><h2>" +
        this.esc(ed.title || "(untitled)") +
        "</h2><p><i>" +
        this.esc(ed.dek || "") +
        "</i></p>" +
        paras;
      mo.classList.add("on");
    }

    toggleCrawlList(show) {
      var desk = document.getElementById("newsDeskP");
      var src = document.getElementById("srcP");
      if (!desk || !src) return;
      var on = show === undefined ? src.hidden : !!show;
      src.hidden = !on;
      desk.hidden = on;
      if (on) this.renderCrawlList();
    }

    async reloadCrawlList() {
      try {
        var res = await fetch("data/sources.json?v=" + Date.now(), { credentials: "same-origin" });
        if (res.ok) this.sources = await res.json();
      } catch (e) {
        this.toast("Could not load data/sources.json", "error");
        return;
      }
      if (!this.sources.blacklist) this.sources.blacklist = [];
      this.renderCrawlList();
    }

    renderCrawlList() {
      if (!this.sources) {
        this.reloadCrawlList();
        return;
      }
      var bl = document.getElementById("srcBlacklist");
      var cats = document.getElementById("srcCats");
      var self = this;
      if (bl) {
        bl.innerHTML = (this.sources.blacklist || [])
          .map(function (h, i) {
            return (
              '<div class="src-feed"><span>' +
              self.esc(h) +
              '</span><span></span><button type="button" class="btn btn-del" data-bl="' +
              i +
              '">Remove</button></div>'
            );
          })
          .join("") || '<p class="side-note">No blocked hosts.</p>';
        if (!bl.dataset.bound) {
          bl.dataset.bound = "1";
          bl.addEventListener("click", function (ev) {
            var btn = ev.target.closest("[data-bl]");
            if (!btn) return;
            self.sources.blacklist.splice(parseInt(btn.getAttribute("data-bl"), 10), 1);
            self.renderCrawlList();
          });
        }
      }
      if (!cats) return;
      var html = "";
      var categories = this.sources.categories || {};
      Object.keys(categories).forEach(function (id) {
        var cat = categories[id];
        html += "<div class=\"src-cat\" data-cat=\"" + self.esc(id) + "\"><h3>" + self.esc(cat.label || id) + "</h3>";
        (cat.feeds || []).forEach(function (f, i) {
          html +=
            '<div class="src-feed"><input class="fi src-name" value="' +
            self.esc(f.name || "") +
            '"><input class="fi src-url" value="' +
            self.esc(f.url || "") +
            '"><button type="button" class="btn btn-del" data-rm="' +
            i +
            '">Remove</button></div>';
        });
        html +=
          '<button type="button" class="btn" data-add="' +
          self.esc(id) +
          '">Add feed</button></div>';
      });
      cats.innerHTML = html;
      if (!cats.dataset.bound) {
        cats.dataset.bound = "1";
        cats.addEventListener("click", function (ev) {
          var add = ev.target.closest("[data-add]");
          var rm = ev.target.closest("[data-rm]");
          if (add) {
            self.readCrawlListDom();
            var id = add.getAttribute("data-add");
            if (!self.sources.categories[id].feeds) self.sources.categories[id].feeds = [];
            self.sources.categories[id].feeds.push({ name: "", url: "" });
            self.renderCrawlList();
          }
          if (rm) {
            self.readCrawlListDom();
            var catEl = rm.closest("[data-cat]");
            var cid = catEl && catEl.getAttribute("data-cat");
            if (cid) {
              self.sources.categories[cid].feeds.splice(parseInt(rm.getAttribute("data-rm"), 10), 1);
              self.renderCrawlList();
            }
          }
        });
      }
    }

    readCrawlListDom() {
      if (!this.sources) return;
      var cats = document.getElementById("srcCats");
      if (!cats) return;
      cats.querySelectorAll("[data-cat]").forEach(function (block) {
        var id = block.getAttribute("data-cat");
        var feeds = [];
        block.querySelectorAll(".src-feed").forEach(function (row) {
          var name = (row.querySelector(".src-name") || {}).value || "";
          var url = (row.querySelector(".src-url") || {}).value || "";
          if (name || url) feeds.push({ name: name.trim(), url: url.trim() });
        });
        if (this.sources.categories[id]) this.sources.categories[id].feeds = feeds;
      }, this);
    }

    saveCrawlListLocal() {
      this.readCrawlListDom();
      try {
        sessionStorage.setItem("fw_sources", JSON.stringify(this.sources));
      } catch (e) {
        /* ignore */
      }
      this.toast("Crawl list saved in this tab.", "success");
    }

    async publishCrawlList() {
      this.readCrawlListDom();
      var ok = await this.putGithubFile(
        "data/sources.json",
        JSON.stringify(this.sources, null, 2) + "\n",
        "Update Latest Beat crawl list"
      );
      if (ok) this.toast("Crawl list published.", "success");
    }

    addBlacklistHost() {
      var inp = document.getElementById("srcBlInput");
      var host = inp && inp.value ? inp.value.trim().toLowerCase().replace(/^www\./, "") : "";
      if (!host) return;
      if (!this.sources) this.sources = { categories: {}, blacklist: [] };
      if (!this.sources.blacklist) this.sources.blacklist = [];
      if (this.sources.blacklist.indexOf(host) === -1) this.sources.blacklist.push(host);
      if (inp) inp.value = "";
      this.renderCrawlList();
    }

    renderVendors() {
      var host = document.getElementById("vendorList");
      if (!host) return;
      host.innerHTML = this.vendors
        .map(function (v) {
          var locked = v.kind === "static" ? " disabled" : "";
          return (
            '<label class="vrow"><input type="checkbox" data-vid="' +
            v.id +
            '"' +
            (v.kind === "static" ? "" : " checked") +
            locked +
            "> <b>" +
            this.esc(v.name) +
            "</b> <span>" +
            v.kind +
            "</span></label>"
          );
        }, this)
        .join("");
    }

    selectedVendorIds() {
      return Array.prototype.slice
        .call(document.querySelectorAll("#vendorList input[data-vid]:checked"))
        .map(function (el) {
          return el.getAttribute("data-vid");
        });
    }

    renderCurrent() {
      var meta = document.getElementById("catMeta");
      if (meta) meta.textContent = this.working.length + " items in working catalog";
    }

    renderDiff() {
      var outHost = document.getElementById("outdatedList");
      var newHost = document.getElementById("newList");
      var sum = document.getElementById("diffMeta");
      if (sum) {
        sum.textContent =
          this.diff.outdated.length +
          " outdated · " +
          this.diff.added.length +
          " new · " +
          this.diff.kept.length +
          " unchanged (including Legacy 1892)";
      }
      function row(p, kind) {
        var id = kind + "-" + CatalogKey.slug(p.id || p.name);
        return (
          '<label class="drow" data-kind="' +
          kind +
          '"><input type="checkbox" checked data-key="' +
          CatalogKey.ofProduct(p) +
          '"> <span class="dthumb">' +
          (p.image
            ? '<img src="' + p.image + '" alt="">'
            : "") +
          "</span><span class=\"dbody\"><b>" +
          (p.name || "") +
          "</b><i>" +
          (p.brand || "") +
          " · " +
          (p.price || "no price") +
          "</i><a href=\"" +
          (p.url || "#") +
          '" target="_blank" rel="noopener">' +
          (p.url || "") +
          "</a></span></label>"
        );
      }
      if (outHost) {
        outHost.innerHTML = this.diff.outdated.length
          ? this.diff.outdated.map(function (p) {
              return row(p, "out");
            }).join("")
          : '<p class="empty">No outdated items in scanned shops.</p>';
      }
      if (newHost) {
        newHost.innerHTML = this.diff.added.length
          ? this.diff.added.map(function (p) {
              return row(p, "new");
            }).join("")
          : '<p class="empty">No new priced coffee items found.</p>';
      }
    }

    async rescan() {
      var ids = this.selectedVendorIds();
      if (!ids.length) {
        this.log("err", "Select at least one vendor.");
        return;
      }
      var btn = document.getElementById("sBtn");
      if (btn) btn.classList.add("ld");
      this.status("Scanning…", true);
      this.liveByVendor = {};
      for (var i = 0; i < this.vendors.length; i++) {
        var v = this.vendors[i];
        if (ids.indexOf(v.id) === -1) continue;
        this.status("Scanning " + v.name + "…", true);
        this.log("inf", "Scan " + v.name);
        try {
          var scanner = new VendorScanner(v);
          var result = await scanner.scan();
          this.liveByVendor[v.id] = result.items || [];
          this.log(
            "ok",
            v.name +
              ": " +
              (result.items || []).length +
              " coffee items (" +
              (result.via || result.note || "ok") +
              (result.raw != null ? ", raw " + result.raw : "") +
              ")"
          );
        } catch (err) {
          this.liveByVendor[v.id] = [];
          this.log("err", v.name + " failed: " + (err.message || err));
        }
      }
      this.diff = new CatalogDiff(this.working, this.liveByVendor).run(ids);
      this.renderDiff();
      this.status("Idle", false);
      if (btn) btn.classList.remove("ld");
      this.log(
        "ok",
        "Diff ready: " +
          this.diff.outdated.length +
          " outdated, " +
          this.diff.added.length +
          " new."
      );
    }

    applyDiff() {
      var removeKeys = {};
      document.querySelectorAll('#outdatedList input[data-key]:checked').forEach(function (el) {
        removeKeys[el.getAttribute("data-key")] = true;
      });
      var addKeys = {};
      document.querySelectorAll('#newList input[data-key]:checked').forEach(function (el) {
        addKeys[el.getAttribute("data-key")] = true;
      });
      this.working = this.working.filter(function (p) {
        return !removeKeys[CatalogKey.ofProduct(p)];
      });
      var self = this;
      this.diff.added.forEach(function (item) {
        if (!addKeys[CatalogKey.ofProduct(item)]) return;
        var copy = Object.assign({}, item);
        if (!copy.description) {
          copy.description =
            "Newly listed on the roaster’s shop. Confirm size is 16 oz / 1 lb or smaller, write a 35–40 word English blurb, then export.";
          copy.wordCount = copy.description.split(/\s+/).length;
        }
        self.working.push(copy);
      });
      this.diff = { outdated: [], added: [], kept: this.working.slice() };
      this.renderDiff();
      this.renderCurrent();
      this.log("ok", "Applied. Working catalog now " + this.working.length + " items.");
      this.toast("Working catalog updated. Export to replace catalog.data.js.", "success");
    }

    exportJs() {
      var payload = {
        itemCount: this.working.length,
        products: this.working,
      };
      var body = "/* generated catalog — priced bags 16 oz or less */\nwindow.CATALOG = " +
        JSON.stringify(payload) +
        ";\n";
      var blob = new Blob([body], { type: "text/javascript" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "catalog.data.js";
      a.click();
      URL.revokeObjectURL(a.href);
      this.log("ok", "Downloaded catalog.data.js (" + this.working.length + " items).");
    }

    ghHeaders(token, withJson) {
      var h = {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (withJson) h["Content-Type"] = "application/json";
      return h;
    }

    b64Utf8(str) {
      var bytes = new TextEncoder().encode(str);
      var bin = "";
      bytes.forEach(function (b) {
        bin += String.fromCharCode(b);
      });
      return btoa(bin);
    }

    readPat() {
      var typed = "";
      document.querySelectorAll(".gh-pat").forEach(function (el) {
        if (!typed && el.value) typed = String(el.value).trim();
      });
      if (typed) {
        try {
          sessionStorage.setItem("fw_gh_pat", typed);
        } catch (e) {
          /* private mode */
        }
        return typed;
      }
      try {
        return sessionStorage.getItem("fw_gh_pat") || "";
      } catch (e) {
        return "";
      }
    }

    bindPatField() {
      var saved = "";
      try {
        saved = sessionStorage.getItem("fw_gh_pat") || "";
      } catch (e) {
        saved = "";
      }
      document.querySelectorAll(".gh-pat").forEach(function (input) {
        if (saved && !input.value) input.value = saved;
        input.addEventListener("change", function () {
          var v = String(input.value || "").trim();
          try {
            if (v) sessionStorage.setItem("fw_gh_pat", v);
            else sessionStorage.removeItem("fw_gh_pat");
          } catch (e2) {
            /* ignore */
          }
          document.querySelectorAll(".gh-pat").forEach(function (other) {
            if (other !== input) other.value = v;
          });
        });
      });
    }

    async putGithubFile(path, content, message) {
      var owner = "dvpwemake";
      var repo = "4Wcoffee";
      var branch = "main";
      var token = this.readPat();
      if (!token) {
        var field = document.getElementById("ghPat");
        if (field) field.focus();
        this.toast("Paste a GitHub PAT with Contents write on dvpwemake/4Wcoffee.", "error");
        return false;
      }
      var api =
        "https://api.github.com/repos/" +
        owner +
        "/" +
        repo +
        "/contents/" +
        encodeURI(path);
      var sha = null;
      var cur = await fetch(api + "?ref=" + encodeURIComponent(branch), {
        headers: this.ghHeaders(token, false),
      });
      if (cur.status === 401 || cur.status === 403) {
        try {
          sessionStorage.removeItem("fw_gh_pat");
        } catch (e) {
          /* ignore */
        }
        var bad = document.getElementById("ghPat");
        if (bad) bad.value = "";
        this.toast("Token rejected. Paste a valid PAT and try again.", "error");
        return false;
      }
      if (cur.ok) {
        var curJ = await cur.json();
        sha = curJ.sha;
      }
      var body = {
        message: message,
        content: this.b64Utf8(content),
        branch: branch,
      };
      if (sha) body.sha = sha;
      var put = await fetch(api, {
        method: "PUT",
        headers: this.ghHeaders(token, true),
        body: JSON.stringify(body),
      });
      if (!put.ok) {
        var errT = await put.text();
        this.log("err", "GitHub publish failed " + path + ": " + put.status + " " + errT.slice(0, 180));
        this.toast("GitHub publish failed.", "error");
        return false;
      }
      return true;
    }

    async publishGithub() {
      var payload = { itemCount: this.working.length, products: this.working };
      var content =
        "/* generated catalog — priced bags 16 oz or less */\nwindow.CATALOG = " +
        JSON.stringify(payload) +
        ";\n";
      this.status("Publishing…", true);
      var ok = await this.putGithubFile(
        "catalog.data.js",
        content,
        "catalog rescan " + new Date().toISOString().slice(0, 10)
      );
      this.status("Idle", false);
      if (ok) {
        this.log("ok", "Published catalog.data.js");
        this.toast("Published catalog to GitHub.", "success");
      }
    }

    signalsPayload() {
      var data = this.collectSignals();
      if (!data.deleted) data.deleted = [];
      data.byCategory = this.rebuildByCategory(data.items || []);
      return data;
    }

    async publishSignals() {
      var data = this.signalsPayload();
      global.SIGNALS = data;
      var js = "window.SIGNALS = " + JSON.stringify(data) + ";\n";
      var json = JSON.stringify(data, null, 2) + "\n";
      this.toast("Publishing Latest Beat…", "info");
      var ok1 = await this.putGithubFile(
        "signals.data.js",
        js,
        "Update Latest Beat signals " + new Date().toISOString().slice(0, 10)
      );
      if (!ok1) return;
      await this.putGithubFile("data/signals.json", json, "Update signals.json " + new Date().toISOString().slice(0, 10));
      if (this.archive) {
        await this.putGithubFile(
          "data/archive.json",
          JSON.stringify(this.archive, null, 2) + "\n",
          "Update Latest Beat archive " + new Date().toISOString().slice(0, 10)
        );
      }
      this.log("ok", "Published signals.data.js (" + (data.items || []).length + " items)");
      this.toast("Latest Beat updated on GitHub.", "success");
    }

    toast(msg, kind) {
      var el = document.getElementById("tst");
      if (!el) return;
      el.className = "toast sh " + (kind || "info");
      el.textContent = msg;
      setTimeout(function () {
        el.classList.remove("sh");
      }, 2800);
    }
  }

  var app = new EditorApp();
  global.FourthWaveEditor = app;

  global.doScan = function () {
    app.rescan();
  };
  global.applyDiff = function () {
    app.applyDiff();
  };
  global.exportCatalog = function () {
    app.exportJs();
  };
  global.publishCatalog = function () {
    app.publishGithub();
  };
  global.showEditorTab = function (id) {
    var root = document.getElementById("editorApp");
    if (!root || !id) return;
    root.querySelectorAll(".tabs [data-tab]").forEach(function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-tab") === id);
    });
    root.querySelectorAll("[data-panel]").forEach(function (p) {
      var on = p.getAttribute("data-panel") === id;
      p.hidden = !on;
      p.style.display = on ? "grid" : "none";
    });
    if (id === "signal") app.renderNewsDesk();
    if (id === "editorial") {
      app.renderEditorialPreview();
      app.refreshEdHeroPicker();
      app.countEditorial();
    }
  };
  global.scanSignals = function () {
    app.scanSignals();
  };
  global.fetchAllCovers = function () {
    app.fetchAllCovers();
  };
  global.showLog = function () {
    var p = document.getElementById("logP");
    if (p) p.scrollIntoView({ behavior: "smooth" });
  };
  global.publishSignals = function () {
    app.publishSignals();
  };
  global.exportSignals = function () {
    var data = app.collectSignals();
    var body = "window.SIGNALS = " + JSON.stringify(data) + ";\n";
    var blob = new Blob([body], { type: "text/javascript" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "signals.data.js";
    a.click();
    URL.revokeObjectURL(a.href);
    app.toast("Downloaded signals.data.js", "success");
  };
  global.publishEditorial = function () {
    app.publishEditorial();
  };
  global.renderNewsDesk = function () {
    app.renderNewsDesk();
  };
  global.reloadNewsDesk = function () {
    app.reloadNewsDesk();
  };
  global.saveSignalsLocal = function () {
    app.collectSignals();
    try {
      sessionStorage.setItem("fw_signals", JSON.stringify(global.SIGNALS || {}));
    } catch (e) {
      /* ignore */
    }
    app.toast("Beats saved in this tab.", "success");
  };
  global.forceEditorialDraft = function () {
    app.forceEditorialDraft();
  };
  global.saveEditorialLocal = function () {
    var ed = app.collectEditorial();
    try {
      sessionStorage.setItem("fw_editorial", JSON.stringify(ed));
    } catch (e) {
      /* ignore */
    }
    app.toast("Editorial saved in this tab (not live).", "success");
  };
  global.previewEditorial = function () {
    app.previewEditorial();
  };
  global.closeEdPrev = function () {
    var mo = document.getElementById("edPrevM");
    if (mo) mo.classList.remove("on");
  };
  global.refreshEdHeroPicker = function () {
    app.refreshEdHeroPicker();
  };
  global.toggleCrawlList = function (show) {
    app.toggleCrawlList(show);
  };
  global.saveCrawlListLocal = function () {
    app.saveCrawlListLocal();
  };
  global.publishCrawlList = function () {
    app.publishCrawlList();
  };
  global.reloadCrawlList = function () {
    app.reloadCrawlList();
  };
  global.addBlacklistHost = function () {
    app.addBlacklistHost();
  };
  global.exportEditorial = function () {
    var ed = app.collectEditorial();
    var body = app.editorialFile(ed);
    var blob = new Blob([body], { type: "text/javascript" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "editorial.data.js";
    a.click();
    URL.revokeObjectURL(a.href);
    app.toast("Downloaded editorial.data.js", "success");
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (!global.FourthWaveEditorAuth) return;
    global.FourthWaveEditorAuth.mountGate({
      onUnlock: function () {
        app.boot();
      },
    });
  });
})(window);
