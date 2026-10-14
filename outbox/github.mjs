// Outbox: the editor's GitHub calls (Contents API and workflow dispatch). Every call has a timeout.
// The token is the editor's fine-grained PAT (Contents: read and write; Actions: read and write).

const API = "https://api.github.com";
const TIMEOUT_MS = 15000;

export class GitHubRepo {
  constructor({ repo, branch = "main", token }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("bad_repo");
    this.repo = repo;
    this.branch = branch;
    this.token = token;
  }

  async call(method, path, body) {
    if (!this.token) throw new Error("github_token_missing");
    const r = await fetch(API + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + this.token,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`github_${r.status}${j.message ? ": " + j.message : ""}`);
    }
    return r.status === 204 ? {} : r.json();
  }

  /** A file's text and sha, or null when it does not exist. */
  async read(path) {
    const j = await this.call("GET", `/repos/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
    if (!j || Array.isArray(j)) return null;
    const bin = atob(String(j.content || "").replace(/\s+/g, ""));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes), sha: j.sha };
  }

  async readJson(path) {
    const f = await this.read(path);
    return f ? { value: JSON.parse(f.text), sha: f.sha } : null;
  }

  /** Names in a folder (empty when the folder does not exist). */
  async list(path) {
    const j = await this.call("GET", `/repos/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
    return Array.isArray(j) ? j.filter((e) => e.type === "file").map((e) => e.name) : [];
  }

  /** Create or replace one file. Pass the sha you read; a stale sha fails (409) instead of overwriting. */
  async write(path, text, message, sha) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return this.call("PUT", `/repos/${this.repo}/contents/${encodeURI(path)}`, {
      message,
      content: btoa(bin),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    });
  }

  /** Start outbox.yml with these inputs (string values only). */
  async dispatch(inputs) {
    return this.call("POST", `/repos/${this.repo}/actions/workflows/outbox.yml/dispatches`, { ref: this.branch, inputs });
  }

  runsUrl() {
    return `https://github.com/${this.repo}/actions/workflows/outbox.yml`;
  }
}
