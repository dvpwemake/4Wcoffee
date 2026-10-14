// Writes outbox/test/vectors.json from outbox/lib.mjs (the reference). outbox/test/test_send.py
// checks that the Python sender renders every case the same. Run after changing either renderer:
//   node outbox/test/make-vectors.mjs
import { writeFileSync } from "node:fs";
import { renderMessage } from "../lib.mjs";

const site = { name: "Fourth Wave Coffee", postalAddress: "7220 Trade St, San Diego, CA 92121" };
const senderEmail = "contact@qualifyhours.com";
const cases = [
  ["plain", { subject: "Hello {{first_name|there}}", body: "Hi {{first_name|there}},\nSee you soon." }, { email: "a@x.com", first_name: "Ada" }],
  ["fallback", { subject: "Hello {{first_name|there}}", body: "Hi {{ first_name | friend }}!" }, { email: "b@x.com" }],
  ["link", { subject: "Read", body: "Read [our story](https://fourthwavecoffee.org/4thwave.html) today." }, { email: "c@x.com" }],
  ["link-placeholder-url", { subject: "Ref", body: "Go [here](https://x.org/r?who={{name}}&v=1)." }, { email: "d@x.com", name: "Ann & Bo Lee" }],
  ["bare-url", { subject: "S", body: "Visit https://fourthwavecoffee.org/coffee.html, or https://x.org/a?b=1&c=2." }, { email: "e@x.com" }],
  ["escape", { subject: "<b>{{name}}</b>", body: "Dear {{name}}, 5 < 6 & \"quotes\" 'single'" }, { email: "f@x.com", name: "<script>alert(1)</script>" }],
  ["value-cannot-link", { subject: "S", body: "Hi {{name}}" }, { email: "g@x.com", name: "[click](https://evil.example)" }],
  ["bad-scheme", { subject: "S", body: "No [js](javascript:alert(1)) links." }, { email: "h@x.com" }],
  ["vars-extra", { subject: "{{company|your team}}", body: "At {{company}} in {{city|town}}" }, { email: "i@x.com", vars: { company: "Acme Roasters" } }],
  ["newlines-subject", { subject: "Line one\nline two {{first_name}}", body: "x" }, { email: "j@x.com", first_name: "Zed" }],
  ["control-chars", { subject: "S", body: "Hi {{name}}" }, { email: "k@x.com", name: "Tab\tand\nnew line" }],
  ["link-same-text", { subject: "S", body: "[https://a.org/x](https://a.org/x)" }, { email: "l@x.com" }],
];
const out = cases.map(([name, template, recipient]) => ({ name, template, recipient, site, senderEmail, expect: renderMessage({ template, recipient, site, senderEmail }) }));
writeFileSync(new URL("./vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.length} vectors`);
