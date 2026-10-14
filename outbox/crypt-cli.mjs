// GitHub Actions helper: `node outbox/crypt-cli.mjs open <file>` prints the decrypted JSON
// (private key from env OUTBOX_PRIVATE_KEY); `node outbox/crypt-cli.mjs seal <file>` encrypts the
// JSON on stdin with outbox/public-key.pem and writes <file>. Nothing secret is printed to the log.
import { readFileSync, writeFileSync } from "node:fs";
import { open, seal } from "./crypto.mjs";

const [cmd, file] = process.argv.slice(2);
if (cmd === "open") {
  const key = process.env.OUTBOX_PRIVATE_KEY;
  if (!key) { console.error("missing OUTBOX_PRIVATE_KEY"); process.exit(2); }
  process.stdout.write(JSON.stringify(await open(key, readFileSync(file, "utf8"))));
} else if (cmd === "seal") {
  const pem = readFileSync(new URL("./public-key.pem", import.meta.url), "utf8");
  const input = readFileSync(0, "utf8");
  writeFileSync(file, (await seal(pem, JSON.parse(input))) + "\n");
} else {
  console.error("usage: crypt-cli.mjs open|seal <file>");
  process.exit(2);
}
