#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const catalogJs = fs.readFileSync(path.join(ROOT, "catalog.js"), "utf8");
const dataJs = fs.readFileSync(path.join(ROOT, "catalog.data.js"), "utf8");

const sandbox = {
  document: { addEventListener() {} },
  console,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(dataJs + "\n" + catalogJs, sandbox);

assert.ok(sandbox.FourthWaveCatalog, "FourthWaveCatalog export missing");
assert.ok(sandbox.CATALOG, "CATALOG payload missing");

const { Catalog, CatalogView } = sandbox.FourthWaveCatalog;
const grid = { innerHTML: "" };
const root = {
  querySelector(sel) {
    return sel === "#catalog-grid" ? grid : null;
  },
  querySelectorAll() {
    return [];
  },
};
const view = new CatalogView(root, new Catalog(sandbox.CATALOG));
const products = view.visibleProducts();
assert.ok(products.length >= 80, "catalog too small: " + products.length);
assert.ok(products[0].image, "first featured product has no image");

const first = view.productMarkup(products[0], 0);
assert.match(first, /<picture>/);
assert.match(first, /type="image\/webp"/);
assert.match(first, /image\/catalog-thumbs\/[^"]+\.webp/);
assert.match(first, /image\/catalog-thumbs\/[^"]+\.jpg/);
assert.match(first, /loading="eager"/);
assert.match(first, /fetchpriority="high"/);
assert.doesNotMatch(first, /src="image\/(?!catalog-thumbs)/);
assert.doesNotMatch(first, /src="image\/[^"]+\.png"/);

const rest = view.productMarkup(products[CatalogView.EAGER_COUNT], CatalogView.EAGER_COUNT);
assert.match(rest, /loading="lazy"/);
assert.doesNotMatch(rest, /fetchpriority="high"/);

const empty = view.productImageMarkup({ image: "" }, 0);
assert.match(empty, /card__ph/);

view.paintGrid();
const eager = (grid.innerHTML.match(/loading="eager"/g) || []).length;
const lazy = (grid.innerHTML.match(/loading="lazy"/g) || []).length;
const originals = grid.innerHTML.match(/src="image\/(?!catalog-thumbs)[^"]+"/g) || [];
assert.strictEqual(eager, CatalogView.EAGER_COUNT, "eager count " + eager);
assert.ok(lazy >= 70, "lazy count " + lazy);
assert.strictEqual(originals.length, 0, "original src leaked: " + originals.slice(0, 3));

products
  .filter((p) => p.image)
  .forEach((p) => {
    const webp = path.join(ROOT, CatalogView.thumbUrl(p.image, "webp"));
    const jpg = path.join(ROOT, CatalogView.thumbUrl(p.image, "jpg"));
    assert.ok(fs.existsSync(webp), "missing " + webp);
    assert.ok(fs.existsSync(jpg), "missing " + jpg);
  });

console.log(
  JSON.stringify({
    products: products.length,
    eager,
    lazy,
    firstThumb: CatalogView.thumbUrl(products[0].image, "webp"),
    lcp: products[0].id,
  })
);
