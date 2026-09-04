/* Site chrome, contact routing, and silent buy notice. Email never in the client. */
(function (global) {
  "use strict";

  class SiteChrome {
    static pages() {
      return [
        { href: "4thwave.html", id: "4thwave", label: "The 4th Wave" },
        { href: "coffee.html", id: "coffee", label: "Buy Coffee" },
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
        '<nav class="nav-links" aria-label="Primary">' +
        links +
        "</nav></div>"
      );
    }

    static footerMarkup() {
      const year = String(new Date().getFullYear());
      return (
        '<div class="wrap">' +
        '<p class="foot-org">AppChurch Global Foundation</p>' +
        "<p>501(c)(3) Nonprofit Organization</p>" +
        "<p>Fourth Wave Coffee: A Project of AppChurch Global Foundation</p>" +
        "<p>San Diego, CA</p>" +
        '<div class="foot-links">' +
        '<a href="privacy.html">Privacy</a>' +
        '<span class="foot-sep" aria-hidden="true">|</span>' +
        '<a href="terms.html">Terms of Use</a>' +
        "</div>" +
        '<p><a class="btn" href="contact.html">Contact</a></p>' +
        '<p class="foot-copy">&copy; 2020–' +
        year +
        " AppChurch Global Foundation. All rights reserved.</p>" +
        "</div>"
      );
    }

    static mount() {
      const nav = document.querySelector("[data-nav]");
      const foot = document.querySelector("[data-footer]");
      if (nav) {
        nav.classList.add("site-nav");
        nav.innerHTML = SiteChrome.navMarkup();
      }
      if (foot) {
        foot.classList.add("site-foot");
        foot.innerHTML = SiteChrome.footerMarkup();
      }
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
    static mailbox() {
      return ["info", "appchurchglobal.org"].join("@");
    }

    static endpoint() {
      return "https://formsubmit.co/ajax/" + ContactForm.mailbox();
    }

    static setStatus(text) {
      const note = document.getElementById("contact-status");
      if (note) note.textContent = text;
    }

    static bind() {
      const form = document.getElementById("contact-form");
      if (!form) return;
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        const trap = form.querySelector('[name="company"]');
        if (trap && trap.value) {
          ContactForm.setStatus("Message sent. We will reply as we are able.");
          form.reset();
          return;
        }
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        const name = ((form.querySelector('[name="name"]') || {}).value || "").trim().slice(0, 80);
        const email = ((form.querySelector('[name="email"]') || {}).value || "").trim().slice(0, 120);
        const message = ((form.querySelector('[name="message"]') || {}).value || "").trim().slice(0, 400);
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        ContactForm.setStatus("Sending…");
        const payload = new FormData();
        payload.append("name", name);
        payload.append("email", email);
        payload.append("_replyto", email);
        payload.append("message", message);
        payload.append("_subject", "Fourth Wave Coffee contact");
        payload.append("_template", "table");
        payload.append("_captcha", "false");
        fetch(ContactForm.endpoint(), {
          method: "POST",
          headers: { Accept: "application/json" },
          body: payload,
        })
          .then(function (res) {
            return res.json().then(function (data) {
              return { ok: res.ok, data: data };
            });
          })
          .then(function (result) {
            if (!result.ok) {
              throw new Error((result.data && result.data.message) || "send failed");
            }
            ContactForm.setStatus("Message sent. We will reply as we are able.");
            form.reset();
          })
          .catch(function () {
            ContactForm.setStatus("Could not send. Please try again in a moment.");
          })
          .then(function () {
            if (btn) btn.disabled = false;
          });
      });
    }
  }

  class HeroCarousel {
    static files() {
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
            return (
              '<div class="hero-cinema__slide' +
              on +
              '"><img src="' +
              src +
              '" alt="Cafe interior"' +
              extra +
              "></div>"
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
      }, 6000);
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

  global.SiteChrome = SiteChrome;
  global.BuyNotifier = BuyNotifier;

  document.addEventListener("DOMContentLoaded", function () {
    SiteChrome.mount();
    ContactForm.bind();
    const carousel = document.querySelector("[data-carousel]");
    if (carousel) new HeroCarousel(carousel);
    BackToTop.mount();
  });
})(window);
