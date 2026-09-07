/* Site chrome, contact routing, and silent buy notice. Email never in the client. */
(function (global) {
  "use strict";

  class SiteChrome {
    static pages() {
      return [
        { href: "4thwave.html", id: "4thwave", label: 'The <span class="nav-accent">4</span>th Wave' },
        { href: "coffee.html", id: "coffee", label: "Buy Coffee" },
        { href: "latestbeat.html", id: "beat", label: "Latest Beat" },
        { href: "healthbenefits.html", id: "health", label: "Coffee&Health" },
        { href: "americansmile.html", id: "smile", label: "American Smile" },
        { href: "contact.html", id: "contact", label: "Contact" },
      ];
    }

    static currentFile() {
      const path = (location.pathname.split("/").pop() || "index.html").toLowerCase();
      if (!path || path === "index.html") return "index.html";
      return path;
    }

    static navMarkup() {
      const current = SiteChrome.currentFile();
      const links = SiteChrome.pages()
        .map(function (page) {
          const active = page.href === current ? " is-active" : "";
          return (
            '<a class="' +
            active.trim() +
            '" href="' +
            page.href +
            '">' +
            page.label +
            "</a>"
          );
        })
        .join("");
      return (
        '<div class="wrap">' +
        '<a class="logo" href="index.html" aria-label="Fourth Wave Coffee home">' +
        '<span class="logo__num" aria-hidden="true">4</span>' +
        '<span class="logo__stack">' +
        '<span class="logo__name">Fourth Wave</span>' +
        '<span class="logo__sub">Coffee</span>' +
        "</span></a>" +
        '<button type="button" class="nav-toggle" aria-label="Open menu" aria-expanded="false" aria-controls="site-menu">' +
        '<span></span><span></span><span></span>' +
        "</button>" +
        '<nav class="nav-links" id="site-menu" aria-label="Primary">' +
        links +
        "</nav>" +
        '<div class="nav-scrim" hidden></div>' +
        "</div>"
      );
    }

    static footerMarkup() {
      const year = String(new Date().getFullYear());
      return (
        '<div class="wrap">' +
        '<p class="foot-org"><span class="foot-accent">Fourth</span> Wave Coffee<span class="foot-accent"> · </span>San Diego, CA<span class="foot-accent"> · </span><a href="contact.html">Contact</a></p>' +
        '<p class="foot-copy">&copy; 2020–' +
        year +
        ' <span class="foot-accent">Fourth</span>WaveCoffee.org. An AppChurch Global Foundation 501(c)(3) initiative. All rights reserved. ' +
        '<a href="privacy.html">Privacy</a>' +
        '<span class="foot-accent" aria-hidden="true"> · </span>' +
        '<a href="terms.html">Terms</a></p>' +
        "</div>"
      );
    }

    static mount() {
      const nav = document.querySelector("[data-nav]");
      const foot = document.querySelector("[data-footer]");
      if (nav) {
        nav.classList.add("site-nav");
        nav.innerHTML = SiteChrome.navMarkup();
        SiteChrome.bindMenu(nav);
      }
      if (foot) {
        foot.classList.add("site-foot");
        foot.innerHTML = SiteChrome.footerMarkup();
      }
    }

    static bindMenu(root) {
      const toggle = root.querySelector(".nav-toggle");
      const scrim = root.querySelector(".nav-scrim");
      const menu = root.querySelector(".nav-links");
      if (!toggle || !menu) return;
      const close = function () {
        root.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open menu");
        if (scrim) scrim.hidden = true;
        document.body.classList.remove("nav-lock");
      };
      const open = function () {
        root.classList.add("is-open");
        toggle.setAttribute("aria-expanded", "true");
        toggle.setAttribute("aria-label", "Close menu");
        if (scrim) scrim.hidden = false;
        document.body.classList.add("nav-lock");
      };
      toggle.addEventListener("click", function () {
        if (root.classList.contains("is-open")) close();
        else open();
      });
      if (scrim) scrim.addEventListener("click", close);
      menu.querySelectorAll("a").forEach(function (a) {
        a.addEventListener("click", close);
      });
      window.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") close();
      });
    }
  }

  class BuyNotifier {
    static endpoint() {
      return "api/notify-buy.php";
    }

    static notify(payload) {
      try {
        const body = JSON.stringify({
          type: payload.type || "buy",
          id: String(payload.id || "").slice(0, 80),
          name: String(payload.name || "").slice(0, 160),
          url: String(payload.url || "").slice(0, 400),
          note: String(payload.note || "").slice(0, 400),
          t: Date.now(),
        });
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(BuyNotifier.endpoint(), blob);
          return;
        }
        fetch(BuyNotifier.endpoint(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true,
          credentials: "same-origin",
        }).catch(function () {});
      } catch (err) {
        /* fail closed; the shop tab still opens */
      }
    }
  }

  class ContactForm {
    static setStatus(text) {
      const note = document.getElementById("contact-status");
      if (note) note.textContent = text;
    }

    static bind() {
      const form = document.getElementById("contact-form");
      if (!form) return;
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        const trap = form.querySelector('[name="_gotcha"]');
        if (trap && trap.value) {
          location.replace("sent.html");
          return;
        }
        const name = ((form.querySelector('[name="name"]') || {}).value || "").trim();
        const email = ((form.querySelector('[name="email"]') || {}).value || "").trim();
        const message = ((form.querySelector('[name="message"]') || {}).value || "").trim();
        if (!name || !email || !message) {
          ContactForm.setStatus("Please enter your name, email address, and message.");
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          ContactForm.setStatus("Please enter a valid email address so we can reply.");
          const emailEl = form.querySelector('[name="email"]');
          if (emailEl) emailEl.focus();
          return;
        }
        const btn = form.querySelector("#contact-send") || form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        ContactForm.setStatus("Sending…");
        function pack() {
          const data = new FormData();
          data.set("name", name);
          data.set("email", email);
          data.set("_replyto", email);
          data.set("message", message);
          data.set("_subject", "Fourth Wave Coffee contact from " + name);
          return data;
        }
        const posts = [
          fetch(form.action, {
            method: "POST",
            body: pack(),
            headers: { Accept: "application/json" },
          }),
          fetch("https://formsubmit.co/ajax/" + ["info", "appchurchglobal.org"].join("@"), {
            method: "POST",
            body: pack(),
            headers: { Accept: "application/json" },
          }),
        ];
        Promise.allSettled(posts)
          .then(function (results) {
            var delivered = results.some(function (r) {
              return r.status === "fulfilled" && r.value && r.value.ok;
            });
            if (!delivered) throw new Error("send failed");
            location.replace("sent.html");
          })
          .catch(function () {
            form.submit();
          })
          .then(function () {
            if (btn) btn.disabled = false;
          });
      });
    }
  }

  class HeroCarousel {
    static stock() {
      return [
        "image/carosal/cafe-scene-6887.jpg",
        "image/carosal/cafe-scene-7252.jpg",
        "image/carosal/cafe-scene-7378.jpg",
        "image/carosal/cafe-scene-7439.jpg",
        "image/carosal/cafe-scene-7473.jpg",
        "image/carosal/cafe-scene-7623.jpg",
        "image/carosal/cafe-scene-7717.jpg",
        "image/carosal/cafe-scene-8167.png",
        "image/carosal/cafe-scene-8168.png",
        "image/carosal/cafe-scene-8174.png",
        "image/carosal/cafe-scene-8186.png",
        "image/carosal/cafe-scene-8187.png",
        "image/carosal/cafe-scene-8188.png",
        "image/carosal/cafe-scene-8190.png",
        "image/carosal/cafe-scene-8192.png",
        "image/carosal/cafe-scene-8198.png",
        "image/carosal/cafe-scene-8204.png",
        "image/carosal/cafe-scene-8205.png",
      ];
    }

    static files() {
      const seen = {};
      const out = [];
      function add(src) {
        if (!src) return;
        const key = String(src).split("?")[0];
        if (seen[key]) return;
        seen[key] = true;
        out.push(src);
      }
      const ed = global.EDITORIAL || {};
      add(ed.heroImage);
      ((global.SIGNALS && global.SIGNALS.items) || []).forEach(function (it) {
        add(it.image);
      });
      HeroCarousel.stock().forEach(add);
      return out;
    }

    constructor(root) {
      this.root = root;
      this.build();
      this.slides = Array.prototype.slice.call(root.querySelectorAll(".hero-cinema__slide"));
      this.dots = Array.prototype.slice.call(root.querySelectorAll("[data-carousel-dot]"));
      this.index = 0;
      this.timer = null;
      this.reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.bind();
      this.show(0);
      if (!this.reduce && this.slides.length > 1) this.start();
    }

    build() {
      const track = this.root.querySelector(".hero-cinema__track");
      const dots = this.root.querySelector(".hero-cinema__dots");
      const files = HeroCarousel.files();
      if (track) {
        track.innerHTML = files
          .map(function (src, i) {
            const extra = i === 0 ? ' fetchpriority="high"' : ' loading="lazy"';
            const on = i === 0 ? " is-on" : "";
            const remote = /^https?:/i.test(src);
            const proxy = remote
              ? ' data-proxy="https://images.weserv.nl/?url=' +
                encodeURIComponent(String(src).replace(/^https?:\/\//, "")) +
                '&w=1600&h=900&fit=cover&we"'
              : "";
            return (
              '<div class="hero-cinema__slide' +
              on +
              '"><img src="' +
              src +
              '" alt="" referrerpolicy="no-referrer"' +
              extra +
              proxy +
              ' onerror="if(this.dataset.proxy&&!this.dataset.tried){this.dataset.tried=1;this.src=this.dataset.proxy}"></div>'
            );
          })
          .join("");
      }
      if (dots) {
        dots.innerHTML = files
          .map(function (_src, i) {
            const on = i === 0 ? ' class="is-on"' : "";
            return (
              '<button type="button" data-carousel-dot' +
              on +
              ' aria-label="Slide ' +
              (i + 1) +
              '"></button>'
            );
          })
          .join("");
      }
    }

    show(i) {
      if (!this.slides.length) return;
      this.index = (i + this.slides.length) % this.slides.length;
      this.slides.forEach(function (slide, n) {
        slide.classList.toggle("is-on", n === this.index);
      }, this);
      this.dots.forEach(function (dot, n) {
        dot.classList.toggle("is-on", n === this.index);
        dot.setAttribute("aria-current", n === this.index ? "true" : "false");
      }, this);
    }

    next() {
      this.show(this.index + 1);
    }

    start() {
      const self = this;
      this.stop();
      this.timer = setInterval(function () {
        self.next();
      }, 3000);
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }

    bind() {
      const self = this;
      this.dots.forEach(function (dot, n) {
        dot.addEventListener("click", function () {
          self.show(n);
          if (!self.reduce) self.start();
        });
      });
      const prev = this.root.querySelector("[data-carousel-prev]");
      const next = this.root.querySelector("[data-carousel-next]");
      if (prev) {
        prev.addEventListener("click", function () {
          self.show(self.index - 1);
          if (!self.reduce) self.start();
        });
      }
      if (next) {
        next.addEventListener("click", function () {
          self.show(self.index + 1);
          if (!self.reduce) self.start();
        });
      }
      this.root.addEventListener("mouseenter", function () {
        self.stop();
      });
      this.root.addEventListener("mouseleave", function () {
        if (!self.reduce && self.slides.length > 1) self.start();
      });
    }
  }

  class HomeEditorial {
    static esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    }

    static byline(ed) {
      const name = ed.authorName || "Dr. Wallace Lynch";
      const title = ed.authorTitle || "Editor in Chief";
      const date = ed.publishDate || "";
      return date ? name + " · " + title + " · " + date : name + " · " + title;
    }

    static mount() {
      const host = document.getElementById("home-editorial");
      const ed = global.EDITORIAL;
      if (!host || !ed || !ed.title) return;
      const paras = ed.paragraphs && ed.paragraphs.length
        ? ed.paragraphs
        : String(ed.body || "").split(/\n\n+/);
      const line = HomeEditorial.byline(ed);
      host.innerHTML =
        '<p class="hero__kicker">Daily editorial</p>' +
        '<span class="tag editorial">Editorial</span>' +
        "<h2>" +
        HomeEditorial.esc(ed.title) +
        "</h2>" +
        '<p class="dek">' +
        HomeEditorial.esc(ed.dek || "") +
        "</p>" +
        '<p class="beat-src">' +
        HomeEditorial.esc(line) +
        "</p>" +
        '<div class="prose">' +
        paras
          .map(function (p) {
            return "<p>" + HomeEditorial.esc(p) + "</p>";
          })
          .join("") +
        '<p class="ed-sign">' +
        HomeEditorial.esc(line) +
        "</p>" +
        '<p><a class="btn btn-outline" href="latestbeat.html#editorial">Latest Beat</a></p>' +
        "</div>";
    }
  }

  class HomeStrips {
    static esc(s) {
      return HomeEditorial.esc(s);
    }

    static proxyUrl(url) {
      if (!url || String(url).indexOf("image/") === 0) return "";
      return (
        "https://images.weserv.nl/?url=" +
        encodeURIComponent(String(url).replace(/^https?:\/\//, "")) +
        "&w=640&h=400&fit=cover&we"
      );
    }

    static coffeeCard(p) {
      return (
        '<article class="strip-card"><div class="shop-card">' +
        '<img src="' +
        HomeStrips.esc(p.image) +
        '" alt="">' +
        '<div class="shop-body">' +
        "<h3>" +
        HomeStrips.esc(p.name) +
        "</h3>" +
        '<p class="shop-meta">' +
        HomeStrips.esc(p.brand) +
        ' · <span class="shop-price">' +
        HomeStrips.esc(p.price) +
        "</span></p>" +
        '<a class="btn" href="' +
        HomeStrips.esc(p.url) +
        '" target="_blank" rel="noopener noreferrer" data-buy="' +
        HomeStrips.esc(p.id) +
        '">Buy</a>' +
        "</div></div></article>"
      );
    }

    static beatCard(it) {
      const raw = it.image || "";
      const proxy = HomeStrips.proxyUrl(raw);
      const tag = it.category === "editorial" ? "Editorial" : it.categoryLabel || it.category || "Beat";
      const href = it.sourceUrl || "latestbeat.html";
      const tgt = it.category === "editorial" ? "" : ' target="_blank" rel="noopener"';
      return (
        '<article class="strip-card"><a class="beat-card" href="' +
        HomeStrips.esc(href) +
        '"' +
        tgt +
        ">" +
        '<div class="n-img"><img src="' +
        HomeStrips.esc(raw) +
        '" alt="" referrerpolicy="no-referrer" data-proxy="' +
        HomeStrips.esc(proxy) +
        '" onerror="if(this.dataset.proxy&&!this.dataset.tried){this.dataset.tried=1;this.src=this.dataset.proxy}"></div>' +
        '<div class="beat-body">' +
        '<span class="tag ' +
        HomeStrips.esc(it.category || "") +
        '">' +
        HomeStrips.esc(tag) +
        "</span>" +
        "<h3>" +
        HomeStrips.esc(it.title) +
        "</h3>" +
        '<p class="beat-src">' +
        HomeStrips.esc(it.source || "") +
        "</p>" +
        "</div></a></article>"
      );
    }

    static featuredCoffees() {
      const list = ((global.CATALOG && global.CATALOG.products) || []).slice();
      const pinned = list
        .filter(function (p) {
          return typeof p.pin === "number";
        })
        .sort(function (a, b) {
          return a.pin - b.pin;
        });
      const rest = list.filter(function (p) {
        return typeof p.pin !== "number";
      });
      return pinned.concat(rest).slice(0, 18);
    }

    static beats() {
      const out = [];
      const ed = global.EDITORIAL;
      if (ed && ed.title) {
        out.push({
          title: ed.title,
          source: "Fourth Wave Coffee",
          sourceUrl: "latestbeat.html#editorial",
          image: ed.heroImage || "",
          category: "editorial",
          categoryLabel: "Editorial",
        });
      }
      ((global.SIGNALS && global.SIGNALS.items) || []).forEach(function (it) {
        out.push(it);
      });
      return out;
    }

    static bindBuy(root) {
      root.querySelectorAll("[data-buy]").forEach(function (link) {
        link.addEventListener("click", function () {
          const id = link.getAttribute("data-buy");
          const product = ((global.CATALOG && global.CATALOG.products) || []).find(function (row) {
            return row.id === id;
          });
          if (product && global.BuyNotifier) {
            global.BuyNotifier.notify({
              type: "buy",
              id: product.id,
              name: product.name,
              url: product.url,
            });
          }
        });
      });
    }

    static bindArrows() {
      function step(id, dir) {
        const el = document.getElementById(id);
        if (!el) return;
        const card = el.querySelector(".strip-card");
        const w = card ? card.getBoundingClientRect().width + 16 : el.clientWidth * 0.8;
        el.scrollBy({ left: dir * w, behavior: "smooth" });
      }
      document.querySelectorAll("[data-strip-prev]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          step(btn.getAttribute("data-strip-prev"), -1);
        });
      });
      document.querySelectorAll("[data-strip-next]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          step(btn.getAttribute("data-strip-next"), 1);
        });
      });
    }

    static mount() {
      const coffeeTrack = document.getElementById("home-coffee-track");
      if (coffeeTrack) {
        coffeeTrack.innerHTML = HomeStrips.featuredCoffees()
          .map(HomeStrips.coffeeCard)
          .join("");
        HomeStrips.bindBuy(coffeeTrack);
      }
      const beatTrack = document.getElementById("home-beats-track");
      if (beatTrack) {
        beatTrack.innerHTML = HomeStrips.beats().map(HomeStrips.beatCard).join("");
      }
      HomeStrips.bindArrows();
    }
  }

  class BackToTop {
    static mount() {
      if (SiteChrome.currentFile() !== "coffee.html") return;
      if (document.querySelector(".to-top")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "to-top is-hidden";
      btn.setAttribute("aria-label", "Back to top");
      btn.textContent = "Top";
      btn.addEventListener("click", function () {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      document.body.appendChild(btn);
      const sync = function () {
        btn.classList.toggle("is-hidden", window.scrollY < 480);
      };
      window.addEventListener("scroll", sync, { passive: true });
      sync();
    }
  }

  class EditorialShare {
    static CANONICAL = "https://fourthwavecoffee.org/latestbeat.html#editorial";

    static esc(s) {
      return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;");
    }

    static icon(name) {
      const box = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
      const icons = {
        x:
          '<svg ' +
          box +
          '><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/></svg>',
        facebook:
          '<svg ' +
          box +
          '><path d="M24 12.073C24 5.446 18.627.073 12 .073S0 5.446 0 12.073c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
        reddit:
          '<svg ' +
          box +
          '><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 000-.463.33.33 0 00-.463 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.204-.094z"/></svg>',
        sms:
          '<svg ' +
          box +
          '><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>',
        email:
          '<svg ' +
          box +
          '><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>',
        link:
          '<svg ' +
          box +
          '><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
      };
      return icons[name] || "";
    }

    static html(ed) {
      const title = (ed && ed.title) || "Fourth Wave Coffee editorial";
      const url = EditorialShare.CANONICAL;
      const shareTitle = encodeURIComponent(title + " — Fourth Wave Coffee");
      const shareU = encodeURIComponent(url);
      const shareBody = encodeURIComponent(title + "\n\n" + url);
      return (
        '<div class="ed-share-wrap">' +
        '<span class="ed-share-label">Share</span>' +
        '<div class="ed-share" role="group" aria-label="Share this editorial">' +
        '<a class="ed-share-btn ed-share-x" href="https://twitter.com/intent/tweet?url=' +
        shareU +
        "&text=" +
        shareTitle +
        '" target="_blank" rel="noopener noreferrer" aria-label="Share on X" title="X">' +
        EditorialShare.icon("x") +
        "</a>" +
        '<a class="ed-share-btn ed-share-fb" href="https://www.facebook.com/sharer/sharer.php?u=' +
        shareU +
        '" target="_blank" rel="noopener noreferrer" aria-label="Share on Facebook" title="Facebook">' +
        EditorialShare.icon("facebook") +
        "</a>" +
        '<a class="ed-share-btn ed-share-rd" href="https://www.reddit.com/submit?url=' +
        shareU +
        "&title=" +
        shareTitle +
        '" target="_blank" rel="noopener noreferrer" aria-label="Share on Reddit" title="Reddit">' +
        EditorialShare.icon("reddit") +
        "</a>" +
        '<a class="ed-share-btn ed-share-sms" href="sms:?&body=' +
        shareBody +
        '" aria-label="Share by SMS" title="SMS">' +
        EditorialShare.icon("sms") +
        "</a>" +
        '<a class="ed-share-btn ed-share-em" href="mailto:?subject=' +
        shareTitle +
        "&body=" +
        shareBody +
        '" aria-label="Share by email" title="Email">' +
        EditorialShare.icon("email") +
        "</a>" +
        '<button type="button" class="ed-share-btn ed-share-link" data-copy-share="' +
        EditorialShare.esc(url) +
        '" aria-label="Copy link" title="Copy link">' +
        EditorialShare.icon("link") +
        "</button>" +
        "</div></div>"
      );
    }

    static bind() {
      if (EditorialShare._bound) return;
      EditorialShare._bound = true;
      document.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-copy-share]");
        if (!btn) return;
        const url = btn.getAttribute("data-copy-share") || EditorialShare.CANONICAL;
        const done = function () {
          btn.classList.add("is-copied");
          btn.setAttribute("title", "Copied");
          window.setTimeout(function () {
            btn.classList.remove("is-copied");
            btn.setAttribute("title", "Copy link");
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () {
            EditorialShare.fallbackCopy(url, done);
          });
        } else {
          EditorialShare.fallbackCopy(url, done);
        }
      });
    }

    static fallbackCopy(url, done) {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  global.SiteChrome = SiteChrome;
  global.BuyNotifier = BuyNotifier;
  global.EditorialShare = EditorialShare;

  class AmericanSmileCovers {
    static CHANNEL = "https://www.youtube.com/@American_Smile";
    static CHANNEL_ID = "UCPwiRGVLgdrptJUKDP8m8ug";
    static RSS =
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCPwiRGVLgdrptJUKDP8m8ug";

    /* YouTube RSS only returns recent uploads. Pin older episodes so EP01/EP02 stay. */
    static ARCHIVE = [
      { id: "woV-3dTGK3U", title: "American Smile EP01 Angie's Smile, Englewood, NJ" },
      { id: "7jFu2r12p0g", title: "American Smile_EP02: Philadelphia" },
      { id: "m8HswqYO4Gc", title: "American Smile: EP04_Ladysmith" },
    ];

    static epNum(title) {
      const m = String(title || "").match(/EP[\s_.:-]*0*(\d+)/i);
      return m ? parseInt(m[1], 10) : 999;
    }

    static videoId(item) {
      const link = String((item && (item.link || item.guid)) || "");
      const m = link.match(/[?&]v=([\w-]{6,})/) || link.match(/youtu\.be\/([\w-]{6,})/);
      if (m) return m[1];
      const thumb = String((item && item.thumbnail) || "");
      const t = thumb.match(/\/vi\/([\w-]{6,})\//);
      return t ? t[1] : "";
    }

    static coverUrl(id, kind) {
      return "https://i.ytimg.com/vi/" + id + "/" + (kind || "hqdefault") + ".jpg";
    }

    static mount() {
      const grid = document.getElementById("as-covers");
      if (!grid) return;
      grid.innerHTML = "<p class=\"empty\">Loading YouTube covers…</p>";
      const feed =
        "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(AmericanSmileCovers.RSS);
      fetch(feed, { credentials: "omit" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        })
        .then(function (data) {
          const seen = {};
          const list = [];
          function add(id, title) {
            if (!id || seen[id]) return;
            seen[id] = true;
            list.push({ id: id, title: title || "American Smile" });
          }
          ((data && data.items) || []).forEach(function (it) {
            add(AmericanSmileCovers.videoId(it), it.title);
          });
          AmericanSmileCovers.ARCHIVE.forEach(function (it) {
            add(it.id, it.title);
          });
          if (!list.length) throw new Error("empty");
          list.sort(function (a, b) {
            const na = AmericanSmileCovers.epNum(a.title);
            const nb = AmericanSmileCovers.epNum(b.title);
            if (na !== nb) return na - nb;
            return String(a.title).localeCompare(String(b.title));
          });
          grid.innerHTML = list
            .map(function (it) {
              const href = "https://www.youtube.com/watch?v=" + it.id;
              const hq = AmericanSmileCovers.coverUrl(it.id, "hqdefault");
              const max = AmericanSmileCovers.coverUrl(it.id, "maxresdefault");
              const title = String(it.title || "American Smile").replace(/</g, "");
              return (
                '<a href="' +
                href +
                '" target="_blank" rel="noopener">' +
                '<img src="' +
                max +
                '" alt="' +
                title.replace(/"/g, "") +
                '" data-fallback="' +
                hq +
                '" onerror="if(this.dataset.fallback&&this.src!==this.dataset.fallback){this.src=this.dataset.fallback;this.dataset.fallback=\'\';}">' +
                "<figcaption>" +
                title +
                "</figcaption></a>"
              );
            })
            .join("");
        })
        .catch(function () {
          grid.innerHTML =
            '<p class="empty">Could not load YouTube covers. <a href="' +
            AmericanSmileCovers.CHANNEL +
            '" target="_blank" rel="noopener">Watch on YouTube</a>.</p>';
        });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    SiteChrome.mount();
    EditorialShare.bind();
    ContactForm.bind();
    HomeEditorial.mount();
    HomeStrips.mount();
    const carousel = document.querySelector("[data-carousel]");
    if (carousel) new HeroCarousel(carousel);
    BackToTop.mount();
    AmericanSmileCovers.mount();
  });
})(window);
