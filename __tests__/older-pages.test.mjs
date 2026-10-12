import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { takePage, PAGE_SIZE } from "../src/logic.js";

/**
 * "Show older" reads the rows that come after the last one loaded. The page's
 * own loadOlder is run here, taken from src/index.html as written, against a
 * read that answers when the test says so — so the test decides what happens
 * to the list while the read is in flight.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

function pageFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  expect(start, `${name} not found in src/index.html`).toBeGreaterThan(0);
  const from = html.lastIndexOf("\n", start) + 1;
  return html.slice(from, html.indexOf("\n}\n", start) + 2);
}

const rows = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, created_at: `2026-01-01T00:00:00.${String(999 - i).padStart(3, "0")}Z` }));

function page() {
  const sandbox = { takePage, PAGE_SIZE, Promise, Set, console, alerts: [], renders: 0, reads: [] };
  vm.createContext(sandbox);
  vm.runInContext(`
    var openPageId = "p1", listGen = 0;
    var entries = [], messages = [], entriesMore = false, messagesMore = false;
    var loadingOlder = { entries: null, messages: null };
    function render() { renders += 1; }
    function hubAlert(title) { alerts.push(title); }
    function read(kind, pageId, before) {
      return new Promise((resolve, reject) => reads.push({ kind, pageId, before, resolve, reject }));
    }
    function readEntries(pageId, before) { return read("entries", pageId, before); }
    function readMessages(pageId, before) { return read("messages", pageId, before); }
    ${pageFunction("uniqueById")}
    ${pageFunction("loadOlder")}
  `, sandbox);
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, get, run: (code) => vm.runInContext(code, sandbox) };
}

describe("loadOlder", () => {
  it("appends the older page after the list it was asked for", async () => {
    const p = page();
    p.sandbox.first = rows("a", PAGE_SIZE);
    p.run("entries = first; entriesMore = true;");
    const done = p.run('loadOlder("entries")');
    expect(p.sandbox.reads[0].before).toEqual(p.sandbox.first[PAGE_SIZE - 1]);
    p.sandbox.reads[0].resolve({ rows: rows("b", 50) });
    await done;
    expect(p.get("entries.length")).toBe(PAGE_SIZE + 50);
    expect(p.get("entriesMore")).toBe(false);
    expect(p.get("loadingOlder.entries")).toBeNull();
  });

  // A refresh replaced the list while the older page was being read. Those
  // rows continue from a tail that no longer exists: appended, they would sit
  // after the fresh first page with every row in between missing, and their
  // "no more" would remove the only way to fetch what was skipped.
  it("drops an older page whose list was replaced while it was being read", async () => {
    const p = page();
    p.sandbox.first = rows("a", PAGE_SIZE);
    p.sandbox.fresh = rows("c", PAGE_SIZE);
    p.run("entries = first; entriesMore = true;");
    const done = p.run('loadOlder("entries")');
    // What loadPageContents does when a reload lands.
    p.run("listGen += 1; entries = fresh; entriesMore = true;");
    p.sandbox.reads[0].resolve({ rows: rows("b", 50) });
    await done;
    expect(p.get("entries.map(e => e.id).join()")).toBe(p.sandbox.fresh.map(e => e.id).join());
    expect(p.get("entriesMore")).toBe(true);
    expect(p.get("loadingOlder.entries")).toBeNull();

    // And the member can still go on from the new list.
    const again = p.run('loadOlder("entries")');
    expect(p.sandbox.reads[1].before).toEqual(p.sandbox.fresh[PAGE_SIZE - 1]);
    p.sandbox.reads[1].resolve({ rows: rows("d", PAGE_SIZE + 1) });
    await again;
    expect(p.get("entries.length")).toBe(PAGE_SIZE * 2);
    expect(p.get("entriesMore")).toBe(true);
  });

  it("drops an older page that arrives after the member opened another page", async () => {
    const p = page();
    p.sandbox.first = rows("a", PAGE_SIZE);
    p.run("entries = first; entriesMore = true;");
    const done = p.run('loadOlder("entries")');
    p.run('openPageId = "p2"; listGen += 1; entries = []; entriesMore = false;');
    p.sandbox.reads[0].resolve({ rows: rows("b", 50) });
    await done;
    expect(p.get("entries.length")).toBe(0);
    expect(p.get("loadingOlder.entries")).toBeNull();
  });

  it("asks once while a read is in flight, draws a row once, and keeps messages apart", async () => {
    const p = page();
    p.sandbox.first = rows("a", PAGE_SIZE);
    p.sandbox.notes = rows("m", PAGE_SIZE);
    p.run("entries = first; entriesMore = true; messages = notes; messagesMore = true;");
    const one = p.run('loadOlder("entries")');
    await p.run('loadOlder("entries")');
    expect(p.sandbox.reads).toHaveLength(1);
    const other = p.run('loadOlder("messages")');
    expect(p.sandbox.reads).toHaveLength(2);
    // The first row of the answer is one already on screen.
    p.sandbox.reads[0].resolve({ rows: [p.sandbox.first[0], ...rows("b", 3)] });
    p.sandbox.reads[1].resolve({ rows: rows("n", 2) });
    await Promise.all([one, other]);
    expect(p.get("entries.length")).toBe(PAGE_SIZE + 3);
    expect(p.get("messages.length")).toBe(PAGE_SIZE + 2);
  });

  it("says so and leaves the list alone when the read fails", async () => {
    const p = page();
    p.sandbox.first = rows("a", PAGE_SIZE);
    p.run("entries = first; entriesMore = true;");
    const done = p.run('loadOlder("entries")');
    p.sandbox.reads[0].reject(new Error("down"));
    await done;
    expect(p.sandbox.alerts).toEqual(["Couldn't load older ones"]);
    expect(p.get("entries.length")).toBe(PAGE_SIZE);
    expect(p.get("entriesMore")).toBe(true);
    expect(p.get("loadingOlder.entries")).toBeNull();
  });

  it("is told of every wholesale replacement of the list", () => {
    // The two places the page swaps the open page's lists: a load landing, and
    // opening a page.
    expect(html.match(/listGen \+= 1;/g)).toHaveLength(2);
    expect(html).toMatch(/if \(openPageId !== pageId \|\| seq !== contentsSeq\) return;\s+listGen \+= 1;\s+entries = entryPage\.rows;/);
  });
});
