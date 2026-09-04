/* Fourth Wave Coffee catalog — object model, sort, Buy. */
(function (global) {
  "use strict";

  class Product {
    constructor(data) {
      this.id = data.id;
      this.name = data.name;
      this.price = data.price;
      this.priceValue = Number(data.priceValue || 0);
      this.description = data.description;
      this.specs = data.specs || {};
      this.image = data.image || "";
      this.url = data.url || "";
      this.brand = data.brand || "";
      this.origin = data.origin || "";
      this.kind = data.kind || "SOE";
      this.pin = data.pin;
    }

    matches(query) {
      if (!query) return true;
      const hay = [this.name, this.brand, this.origin, this.kind, this.description, this.price]
        .join(" ")
        .toLowerCase();
      return hay.includes(query);
    }

    specEntries() {
      return Object.entries(this.specs).filter(function (pair) {
        return Boolean(pair[1]);
      });
    }
  }

  class Catalog {
    constructor(payload) {
      this.products = (payload.products || []).map(function (row) {
        return new Product(row);
      });
    }

    withPinnedHead(copy, restSort) {
      const pinned = copy.filter(function (p) {
        return typeof p.pin === "number";
      });
      const rest = copy.filter(function (p) {
        return typeof p.pin !== "number";
      });
      pinned.sort(function (a, b) {
        return a.pin - b.pin;
      });
      rest.sort(restSort);
      const row = [null, null, null];
      pinned.forEach(function (item) {
        if (item.pin >= 0 && item.pin < 3) row[item.pin] = item;
      });
      return row.filter(Boolean).concat(rest);
    }

    sorted(mode) {
      const copy = this.products.slice();
      if (mode === "price") {
        copy.sort(function (a, b) {
          return a.priceValue - b.priceValue || a.name.localeCompare(b.name);
        });
        return copy;
      }
      if (mode === "origin") {
        copy.sort(function (a, b) {
          return a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name);
        });
        return copy;
      }
      if (mode === "brand") {
        copy.sort(function (a, b) {
          return a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name);
        });
        return copy;
      }
      if (mode === "kind") {
        return this.withPinnedHead(copy, function (a, b) {
          const rank = function (kind) {
            return String(kind || "").toUpperCase() === "SOE" ? 0 : 1;
          };
          return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name);
        });
      }
      return this.withPinnedHead(copy, function (a, b) {
        return a.name.localeCompare(b.name);
      });
    }
  }

  class CatalogView {
    constructor(root, catalog) {
      this.root = root;
      this.catalog = catalog;
      this.query = "";
      this.sort = "featured";
    }

    static escape(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    chipMarkup(specs) {
      return specs
        .map(function (pair) {
          return (
            '<span class="chip"><b>' +
            CatalogView.escape(pair[0]) +
            "</b> " +
            CatalogView.escape(pair[1]) +
            "</span>"
          );
        })
        .join("");
    }

    productMarkup(product) {
      const img = product.image
        ? '<img src="' +
          CatalogView.escape(product.image) +
          '" alt="' +
          CatalogView.escape(product.name) +
          '" loading="lazy" width="640" height="640">'
        : '<div class="card__ph">Photo coming from the roaster</div>';
      return (
        '<article class="card" data-product="' +
        CatalogView.escape(product.id) +
        '">' +
        '<div class="card__shot">' +
        img +
        "</div><div class=\"card__body\">" +
        '<p class="card__meta">' +
        CatalogView.escape(product.brand) +
        " · " +
        CatalogView.escape(product.kind) +
        "</p>" +
        '<div class="card__row"><h3>' +
        CatalogView.escape(product.name) +
        '</h3><div class="card__price">' +
        CatalogView.escape(product.price) +
        "</div></div>" +
        '<p class="card__desc">' +
        CatalogView.escape(product.description) +
        "</p>" +
        '<div class="chips">' +
        this.chipMarkup(product.specEntries()) +
        "</div>" +
        '<a class="card__link" href="' +
        CatalogView.escape(product.url) +
        '" target="_blank" rel="noopener noreferrer" data-buy="' +
        CatalogView.escape(product.id) +
        '">Buy</a>' +
        "</div></article>"
      );
    }

    visibleProducts() {
      return this.catalog
        .sorted(this.sort)
        .filter((product) => product.matches(this.query));
    }

    paintGrid() {
      const grid = this.root.querySelector("#catalog-grid");
      if (!grid) return;
      grid.innerHTML = this.visibleProducts()
        .map((product) => this.productMarkup(product))
        .join("");
      this.bindBuy();
    }

    render() {
      this.root.innerHTML =
        '<div class="toolbar">' +
        '<label class="visually-hidden" for="catalog-sort">Sort</label>' +
        '<select id="catalog-sort">' +
        '<option value="featured">Featured</option>' +
        '<option value="price">Price</option>' +
        '<option value="origin">Origin</option>' +
        '<option value="brand">Brand</option>' +
        '<option value="kind">SOE / Blend</option>' +
        "</select>" +
        '<label class="visually-hidden" for="catalog-query">Search</label>' +
        '<input id="catalog-query" type="search" placeholder="Search coffees" autocomplete="off">' +
        "</div>" +
        '<div class="grid" id="catalog-grid"></div>';
      const select = this.root.querySelector("#catalog-sort");
      if (select) select.value = this.sort;
      const input = this.root.querySelector("#catalog-query");
      if (input) input.value = this.query;
      this.paintGrid();
      this.bind();
    }

    bindBuy() {
      const self = this;
      this.root.querySelectorAll("[data-buy]").forEach(function (link) {
        link.addEventListener("click", function () {
          const id = link.getAttribute("data-buy");
          const product = self.catalog.products.find(function (row) {
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

    bind() {
      const select = this.root.querySelector("#catalog-sort");
      const input = this.root.querySelector("#catalog-query");
      const self = this;
      if (select) {
        select.addEventListener("change", function () {
          self.sort = select.value;
          self.paintGrid();
        });
      }
      if (input) {
        input.addEventListener("input", function () {
          self.query = input.value.trim().toLowerCase();
          self.paintGrid();
        });
      }
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    const root = document.getElementById("catalog");
    if (!root || !global.CATALOG) return;
    const view = new CatalogView(root, new Catalog(global.CATALOG));
    view.render();
  });
})(window);
