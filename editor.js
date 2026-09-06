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
      this.renderSignals();
      this.fillEditorial();
      this.log("inf", "Loaded " + this.products.length + " catalog items.");
    }

    bindTabs() {
      var root = document.getElementById("editorApp");
      if (!root) return;
      root.querySelectorAll(".tabs [data-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-tab");
          root.querySelectorAll(".tabs [data-tab]").forEach(function (b) {
            b.classList.toggle("is-on", b === btn);
          });
          root.querySelectorAll("[data-panel]").forEach(function (p) {
            p.hidden = p.getAttribute("data-panel") !== id;
          });
        });
      });
    }

    renderSignals() {
      var host = document.getElementById("signalList");
      if (!host) return;
      var data = global.SIGNALS || { items: [] };
      var items = data.items || [];
      if (!items.length) {
        host.innerHTML = '<p class="empty">No signals. Run scripts/crawl-signals.py.</p>';
        return;
      }
      host.innerHTML = items
        .map(function (it, i) {
          return (
            '<div class="sig-row" data-i="' +
            i +
            '"><span class="sec-t">' +
            this.esc(it.categoryLabel || it.category) +
            "</span><b>" +
            this.esc(it.title) +
            "</b><i>" +
            this.esc(it.source) +
            "</i><label class=\"sec-t\">Summary</label><textarea class=\"fi sig-sum\">" +
            this.esc(it.summary) +
            "</textarea></div>"
          );
        }, this)
        .join("");
    }

    collectSignals() {
      var data = global.SIGNALS || { items: [], categories: {} };
      var rows = document.querySelectorAll("#signalList .sig-row");
      rows.forEach(function (row) {
        var i = parseInt(row.getAttribute("data-i"), 10);
        var ta = row.querySelector(".sig-sum");
        if (data.items[i] && ta) data.items[i].summary = ta.value.trim();
      });
      return data;
    }

    fillEditorial() {
      var ed = global.EDITORIAL || {};
      var t = document.getElementById("edTitle");
      var d = document.getElementById("edDek");
      var h = document.getElementById("edHero");
      var c = document.getElementById("edCredit");
      var b = document.getElementById("edBody");
      if (t) t.value = ed.title || "";
      if (d) d.value = ed.dek || "";
      if (h) h.value = ed.heroImage || "";
      if (c) c.value = ed.heroCredit || "";
      if (b) b.value = ed.body || (ed.paragraphs || []).join("\n\n");
      this.countEditorial();
      if (b) b.addEventListener("input", this.countEditorial.bind(this));
    }

    countEditorial() {
      var b = document.getElementById("edBody");
      var w = document.getElementById("edWords");
      var n = b && b.value ? b.value.trim().split(/\s+/).filter(Boolean).length : 0;
      if (w) w.textContent = n + " words";
    }

    collectEditorial() {
      var body = (document.getElementById("edBody") || {}).value || "";
      var paras = body.split(/\n\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
      return {
        id: "ed_" + new Date().toISOString().slice(0, 10),
        publishDate: new Date().toISOString().slice(0, 10),
        status: "draft",
        title: (document.getElementById("edTitle") || {}).value || "",
        dek: (document.getElementById("edDek") || {}).value || "",
        heroImage: (document.getElementById("edHero") || {}).value || "",
        heroCredit: (document.getElementById("edCredit") || {}).value || "",
        authorName: "Fourth Wave Coffee",
        authorTitle: "Daily desk",
        body: body.trim(),
        paragraphs: paras,
        wordCount: body.trim().split(/\s+/).filter(Boolean).length,
      };
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
      var input = document.getElementById("ghPat");
      var typed = input && input.value ? String(input.value).trim() : "";
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
      var input = document.getElementById("ghPat");
      if (!input) return;
      try {
        var saved = sessionStorage.getItem("fw_gh_pat") || "";
        if (saved && !input.value) input.value = saved;
      } catch (e) {
        /* ignore */
      }
      input.addEventListener("change", function () {
        var v = String(input.value || "").trim();
        try {
          if (v) sessionStorage.setItem("fw_gh_pat", v);
          else sessionStorage.removeItem("fw_gh_pat");
        } catch (e2) {
          /* ignore */
        }
      });
    }

    async publishGithub() {
      var owner = "dvpwemake";
      var repo = "4Wcoffee";
      var branch = "main";
      var path = "catalog.data.js";
      var token = this.readPat();
      if (!token) {
        var field = document.getElementById("ghPat");
        if (field) field.focus();
        this.toast("Paste a GitHub PAT with Contents write on dvpwemake/4Wcoffee.", "error");
        this.log("err", "Publish cancelled — no PAT.");
        return;
      }
      var payload = { itemCount: this.working.length, products: this.working };
      var content =
        "/* generated catalog — priced bags 16 oz or less */\nwindow.CATALOG = " +
        JSON.stringify(payload) +
        ";\n";
      var api =
        "https://api.github.com/repos/" +
        owner +
        "/" +
        repo +
        "/contents/" +
        encodeURI(path);
      this.status("Publishing…", true);
      var sha = null;
      try {
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
          this.status("Idle", false);
          this.log("err", "GitHub rejected the PAT (" + cur.status + ").");
          this.toast("Token rejected. Paste a valid PAT and try again.", "error");
          return;
        }
        if (cur.ok) {
          var curJ = await cur.json();
          sha = curJ.sha;
        }
      } catch (e) {
        /* treat as new file */
      }
      var body = {
        message: "catalog rescan " + new Date().toISOString().slice(0, 10),
        content: this.b64Utf8(content),
        branch: branch,
      };
      if (sha) body.sha = sha;
      var put = await fetch(api, {
        method: "PUT",
        headers: this.ghHeaders(token, true),
        body: JSON.stringify(body),
      });
      this.status("Idle", false);
      if (!put.ok) {
        var errT = await put.text();
        this.log("err", "GitHub publish failed: " + put.status + " " + errT.slice(0, 180));
        this.toast("GitHub publish failed.", "error");
        return;
      }
      this.log("ok", "Published catalog.data.js to " + owner + "/" + repo + "@" + branch);
      this.toast("Published to GitHub.", "success");
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
  global.showLog = function () {
    var p = document.getElementById("logP");
    if (p) p.scrollIntoView({ behavior: "smooth" });
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
  global.exportEditorial = function () {
    var ed = app.collectEditorial();
    var body = "window.EDITORIAL = " + JSON.stringify(ed) + ";\n";
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
