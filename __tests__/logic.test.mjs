import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import {
  parseIds, parseThumbs, tilePhotoId, thumbsFor, photoRoom, pageById, canManage, resolveCurrentMember,
  entryAuthor, onSharePage, cleanAudience, cleanMessagesVisibility, cleanStatus,
  entryDraft, pageDraft, pageSettingsPatch, closedAtFor, takesMessages,
  withEntryStats, entryStatsAfter, takePage, shareSummary, formatWhen, formatDay,
  searchableFields, entrySearchableFields,
  MAX_TITLE, MAX_BODY, MAX_PHOTOS_PER_ENTRY, MAX_MESSAGES_PER_LINK, PAGE_SIZE, SHARE_PAGE_MAX_ENTRIES, SHARE_PAGE_MAX_PHOTOS,
  SAVE_PAGE_SQL, RESTORE_PAGE_SQL, DELETE_PAGE_SQL, isLive, postRefusal,
} from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(__dirname, path), "utf-8");
const manifest = JSON.parse(read("../manifest.json"));
const scenarios = JSON.parse(read("../scenarios.json")).scenarios;
const html = read("../src/index.html");
const logicSource = read("../src/logic.js");

const MEMBERS = [
  { id: "m1", name: "Alex", role: "adult" },
  { id: "m2", name: "Casey", role: "child" },
];
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const UUID_2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const THUMB = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const THUMB_2 = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
// A real id with something before or after it: only an anchored match refuses these.
const PADDED = [`${UUID}/../x`, `x${UUID}`, `${UUID}0`, ` ${UUID}`];

describe("parseIds", () => {
  it("keeps only uuid-shaped strings", () => {
    expect(parseIds(JSON.stringify([UUID]))).toEqual([UUID]);
  });

  it("drops crafted ids that would otherwise reach a file URL", () => {
    expect(parseIds(JSON.stringify([UUID, "../../etc/passwd", 7, null]))).toEqual([UUID]);
  });

  it("drops an id with anything before or after it", () => {
    expect(parseIds(JSON.stringify([...PADDED, UUID_2]))).toEqual([UUID_2]);
  });

  it("returns [] for null, malformed JSON and non-arrays", () => {
    expect(parseIds(null)).toEqual([]);
    expect(parseIds("not json")).toEqual([]);
    expect(parseIds('{"id":"x"}')).toEqual([]);
  });
});

describe("photo small copies", () => {
  it("reads the stored map as text or as an object", () => {
    expect(parseThumbs(JSON.stringify({ [UUID]: THUMB }))).toEqual({ [UUID]: THUMB });
    expect(parseThumbs({ [UUID]: THUMB })).toEqual({ [UUID]: THUMB });
  });

  it("reads a malformed map as no small copies", () => {
    for (const raw of [null, undefined, "not json", "[]", '"text"', 7]) expect(parseThumbs(raw)).toEqual({});
  });

  it("drops entries that are not a file id on both sides", () => {
    const stored = { [UUID]: THUMB, [UUID_2]: 7, "../../etc/passwd": THUMB_2, [THUMB_2]: "javascript:alert(1)" };
    expect(parseThumbs(JSON.stringify(stored))).toEqual({ [UUID]: THUMB });
  });

  it("drops an id with anything before or after it, on either side", () => {
    for (const bad of PADDED) {
      expect(parseThumbs({ [bad]: THUMB }), `key ${bad}`).toEqual({});
      expect(parseThumbs({ [UUID]: bad }), `value ${bad}`).toEqual({});
    }
  });

  it("draws the small copy when the photo has one, else the photo", () => {
    expect(tilePhotoId(UUID, { [UUID]: THUMB })).toBe(THUMB);
    expect(tilePhotoId(UUID_2, { [UUID]: THUMB })).toBe(UUID_2);
    expect(tilePhotoId("constructor", {})).toBe("constructor");
    expect(tilePhotoId(UUID, undefined)).toBe(UUID);
  });

  it("stores a small copy only for photos still attached that have one", () => {
    expect(thumbsFor([{ id: UUID, thumbnailId: THUMB }, { id: UUID_2 }, { id: THUMB_2, thumbnailId: "" }, { thumbnailId: THUMB_2 }]))
      .toEqual({ [UUID]: THUMB });
    expect(thumbsFor(undefined)).toEqual({});
  });
});

describe("photoRoom", () => {
  it("counts attached photos and uploads in flight against the limit", () => {
    expect(photoRoom(0, 0)).toBe(MAX_PHOTOS_PER_ENTRY);
    expect(photoRoom(5, 4)).toBe(MAX_PHOTOS_PER_ENTRY - 9);
    expect(photoRoom(MAX_PHOTOS_PER_ENTRY, 0)).toBe(0);
    expect(photoRoom(8, 8)).toBe(0);
  });

  it("is the per-entry limit the share page shows", () => {
    expect(MAX_PHOTOS_PER_ENTRY).toBe(12);
  });

  it("quotes the manifest's own per-link message limit", () => {
    expect(MAX_MESSAGES_PER_LINK).toBe(manifest.shareable.page.submit.max_submissions);
  });
});

describe("lookups", () => {
  it("finds a page by id, or null", () => {
    const pages = [{ id: "p1" }, { id: "p2" }];
    expect(pageById(pages, "p2")).toBe(pages[1]);
    expect(pageById(pages, "p9")).toBeNull();
  });
});

describe("canManage", () => {
  it("is adults only, matching the adult_writable tables", () => {
    expect(canManage(true)).toBe(true);
    expect(canManage(false)).toBe(false);
    expect(canManage(undefined)).toBe(false);
    for (const policy of Object.values(manifest.row_policies)) expect(policy.kind).toBe("adult_writable");
  });
});

describe("resolveCurrentMember", () => {
  it("is the member the hub names", () => {
    expect(resolveCurrentMember(MEMBERS[1], MEMBERS, true)).toBe(MEMBERS[1]);
    expect(resolveCurrentMember(MEMBERS[1], MEMBERS, false)).toBe(MEMBERS[1]);
  });

  it("is nobody, and not an adult, when the hub names no one", () => {
    const nobody = resolveCurrentMember(null, MEMBERS, true);
    expect(nobody).toEqual({ id: "", name: "", role: "guest" });
    expect(nobody).not.toBe(MEMBERS[0]);
  });

  it("stands in the first demo member only outside the hub", () => {
    expect(resolveCurrentMember(null, MEMBERS, false)).toBe(MEMBERS[0]);
    expect(resolveCurrentMember(null, [], false).role).toBe("adult");
  });
});

describe("entryAuthor", () => {
  it("prefers the roster name, so a rename follows old entries", () => {
    expect(entryAuthor({ member_id: "m1", author_name: "Alexander" }, MEMBERS)).toBe("Alex");
  });

  it("falls back to the stored name once the author has left, or has no name", () => {
    expect(entryAuthor({ member_id: "gone", author_name: "Robin" }, MEMBERS)).toBe("Robin");
    expect(entryAuthor({ member_id: "m9", author_name: "Robin" }, [{ id: "m9", name: "" }])).toBe("Robin");
    expect(entryAuthor({ member_id: "gone", author_name: "" }, MEMBERS)).toBe("Someone");
    expect(entryAuthor(null, MEMBERS)).toBe("Someone");
  });
});

describe("audience", () => {
  it("puts only an entry marked everyone on the share page", () => {
    expect(onSharePage({ audience: "everyone" })).toBe(true);
    expect(onSharePage({ audience: "family" })).toBe(false);
    expect(onSharePage({ audience: "" })).toBe(false);
    expect(onSharePage({})).toBe(false);
    expect(onSharePage(null)).toBe(false);
  });

  it("publishes only on an exact everyone; anything else stays with the family", () => {
    expect(cleanAudience("everyone")).toBe("everyone");
    expect(cleanAudience("family")).toBe("family");
    for (const other of ["public", "Everyone", "", undefined, null, 1]) expect(cleanAudience(other)).toBe("family");
  });

  it("shows visitors each other's messages only on an exact everyone", () => {
    expect(cleanMessagesVisibility("everyone")).toBe("everyone");
    for (const other of ["family", "all", "", undefined]) expect(cleanMessagesVisibility(other)).toBe("family");
  });

  it("agrees with the share page's own filter", () => {
    const feed = manifest.shareable.page.feeds.find(f => f.table === "entries");
    expect(feed.where).toEqual([{ column: "audience", values: ["everyone"] }]);
    expect(feed.max_items).toBe(SHARE_PAGE_MAX_ENTRIES);
  });
});

describe("cleanStatus", () => {
  it("takes the three statuses and keeps the page's own for anything else", () => {
    for (const status of ["open", "closed", "archived"]) expect(cleanStatus(status, "open")).toBe(status);
    expect(cleanStatus("deleted", "closed")).toBe("closed");
    expect(cleanStatus(undefined, "open")).toBe("open");
  });
});

describe("entryDraft", () => {
  it("trims and returns what may be saved", () => {
    expect(entryDraft({ title: "  Home today ", body: " He is home.\n", audience: "family" }))
      .toEqual({ value: { title: "Home today", body: "He is home.", audience: "family" } });
    expect(entryDraft({ title: "Home today", audience: "everyone" }).value.audience).toBe("everyone");
  });

  it("keeps an update with no stated audience in the family", () => {
    expect(entryDraft({ title: "Home today" }).value.audience).toBe("family");
  });

  it("allows an empty body", () => {
    expect(entryDraft({ title: "Home today", body: "", audience: "everyone" }).value.body).toBe("");
  });

  it("refuses a missing or blank title", () => {
    expect(entryDraft({ title: "   ", body: "text" }).error).toMatch(/title/);
    expect(entryDraft({ body: "text" }).error).toMatch(/title/);
    expect(entryDraft().error).toMatch(/title/);
  });

  it("takes a title or body at the limit and refuses one over it, naming the limit", () => {
    expect(entryDraft({ title: "x".repeat(MAX_TITLE) }).value.title).toHaveLength(MAX_TITLE);
    expect(entryDraft({ title: "x".repeat(MAX_TITLE + 1) }).error).toBe(`Keep the title to ${MAX_TITLE} characters.`);
    expect(entryDraft({ title: "t", body: "x".repeat(MAX_BODY) }).value.body).toHaveLength(MAX_BODY);
    expect(entryDraft({ title: "t", body: "x".repeat(MAX_BODY + 1) }).error).toBe(`Keep the update to ${MAX_BODY} characters.`);
  });
});

describe("pageDraft", () => {
  it("trims the title and the about text", () => {
    expect(pageDraft({ title: " Dad's recovery ", about: " News. " })).toEqual({ value: { title: "Dad's recovery", about: "News." } });
    expect(pageDraft({ title: "Dad" }).value.about).toBe("");
  });

  it("refuses a blank title and one over the limit", () => {
    expect(pageDraft({ title: "  " }).error).toMatch(/title/);
    expect(pageDraft().error).toMatch(/title/);
    expect(pageDraft({ title: "x".repeat(MAX_TITLE) }).value.title).toHaveLength(MAX_TITLE);
    expect(pageDraft({ title: "x".repeat(MAX_TITLE + 1) }).error).toMatch(String(MAX_TITLE));
  });
});

describe("saving a page's settings", () => {
  const PAGE = { id: "p1", title: "Old", status: "open", closed_at: null };

  it("binds the form in the statement's order, the status twice", () => {
    const patch = pageSettingsPatch({ title: " Dad ", about: " Home. ", status: "closed", messages_visibility: "everyone" }, PAGE);
    expect(patch.fields).toEqual({ title: "Dad", about: "Home.", status: "closed", messages_visibility: "everyone" });
    expect(patch.params).toEqual(["Dad", "Home.", "closed", "everyone", "closed", "p1"]);
    expect(SAVE_PAGE_SQL.match(/\?/g)).toHaveLength(patch.params.length);
  });

  it("refuses a blank title instead of keeping the old one silently", () => {
    expect(pageSettingsPatch({ title: " ", status: "open" }, PAGE).error).toMatch(/title/);
  });

  it("keeps the page's status for one it does not know, and messages in the family", () => {
    const patch = pageSettingsPatch({ title: "Dad", status: "gone", messages_visibility: "anyone" }, { ...PAGE, status: "closed" });
    expect(patch.fields.status).toBe("closed");
    expect(patch.fields.messages_visibility).toBe("family");
    expect(patch.params[2]).toBe("closed");
    expect(patch.params[4]).toBe("closed");
  });

  // closed_at is the share form's cutoff. These pin that the statement writes
  // it, from the hub's clock, and that the page sends this statement and no
  // other; scenarios.json then runs the same text through the hub.
  it("writes the cutoff in the statement itself, from the hub's clock", () => {
    expect(manifest.shareable.page.submit.until_column).toBe("closed_at");
    const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    // MIN(…, now): a cutoff still to come would hold the form open on a page
    // that reads as closed, so one is never kept.
    expect(SAVE_PAGE_SQL).toContain(`closed_at = CASE WHEN ? = 'open' THEN NULL ELSE MIN(COALESCE(closed_at, ${NOW}), ${NOW}) END`);
    expect(RESTORE_PAGE_SQL).toContain(`status = 'closed', closed_at = MIN(COALESCE(closed_at, ${NOW}), ${NOW})`);
    expect(RESTORE_PAGE_SQL).toMatch(/WHERE id = \? AND status = 'archived'$/);
  });

  it("is the statement the page sends and the hub scenarios run", () => {
    expect(html).toContain("db(SAVE_PAGE_SQL, patch.params)");
    expect(html).toContain("db(RESTORE_PAGE_SQL, [id])");
    // No other statement may write a page's status or cutoff. Every UPDATE of
    // the pages table, in the page and in logic.js, is one of these three.
    const pageUpdates = (source) => source.match(/update\s+app_updates__pages\b/gi) ?? [];
    expect(pageUpdates(html)).toEqual(["UPDATE app_updates__pages"]);
    expect(html).toContain('"UPDATE app_updates__pages SET cover_file_ids = ? WHERE id = ?"');
    // SAVE_PAGE_SQL, RESTORE_PAGE_SQL and the first of DELETE_PAGE_SQL.
    expect(pageUpdates(logicSource)).toHaveLength(3);
    const ran = scenarios.flatMap(s => s.steps).map(step => step.sql);
    expect(ran).toContain(SAVE_PAGE_SQL);
    expect(ran).toContain(RESTORE_PAGE_SQL);
  });

  it("mirrors the stored cutoff locally", () => {
    const NOW = "2026-03-02T10:00:00.000Z";
    expect(closedAtFor("open", { closed_at: "2026-01-01T00:00:00.000Z" }, NOW)).toBeNull();
    expect(closedAtFor("closed", { closed_at: null }, NOW)).toBe(NOW);
    expect(closedAtFor("archived", {}, NOW)).toBe(NOW);
    expect(closedAtFor("archived", { closed_at: "2026-01-01T00:00:00.000Z" }, NOW)).toBe("2026-01-01T00:00:00.000Z");
    expect(closedAtFor("unknown", { closed_at: null }, NOW)).toBe(NOW);
  });

  it("takes messages only while open", () => {
    expect(takesMessages({ status: "open" })).toBe(true);
    expect(takesMessages({ status: "closed" })).toBe(false);
    expect(takesMessages({ status: "archived" })).toBe(false);
    expect(takesMessages(null)).toBe(false);
  });
});

describe("deleting a page", () => {
  it("stops the page taking updates, then deletes its updates, then the page", () => {
    expect(DELETE_PAGE_SQL).toEqual([
      "UPDATE app_updates__pages SET live = 0 WHERE id = ?",
      "DELETE FROM app_updates__entries WHERE page_id = ?",
      "DELETE FROM app_updates__pages WHERE id = ?",
    ]);
  });

  it("is what the page sends, in that order, and the only way it deletes a page or all its updates", () => {
    expect(html).toContain("const [stop, dropEntries, dropPage] = DELETE_PAGE_SQL;");
    const order = ["await db(stop, [id])", "await db(dropEntries, [id])", "await db(dropPage, [id])"].map(call => html.indexOf(call));
    expect(order.every(at => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toMatch(/DELETE FROM app_updates__pages/i);
    expect(html).not.toMatch(/DELETE FROM app_updates__entries WHERE page_id/i);
  });

  it("is run, statement for statement, by the hub scenarios", () => {
    const ran = scenarios.flatMap(s => s.steps).map(step => step.sql);
    for (const sql of DELETE_PAGE_SQL) expect(ran, sql).toContain(sql);
  });

  it("rests on a foreign key no member can write around", () => {
    const schema = read("../migrations/001_init.sql");
    expect(schema).toMatch(/FOREIGN KEY \(page_id, page_live\) REFERENCES app_updates__pages \(id, live\)\s+ON UPDATE CASCADE ON DELETE CASCADE/);
    expect(schema).toMatch(/page_live\s+INTEGER NOT NULL DEFAULT 1,/);
    expect(schema).toMatch(/UNIQUE \(id, live\)/);
    expect(schema).toMatch(/FOREIGN KEY \(page_id\) REFERENCES app_updates__pages \(id\) ON DELETE CASCADE/);
    expect(manifest.row_policies.entries.column_write_acls.page_live).toEqual({ writable_by: [] });
    for (const column of ["live", "page_live"]) expect(manifest.db_plaintext_columns).toContain(column);
  });

  it("reads a page as live unless its deletion was started", () => {
    expect(isLive({ live: 1 })).toBe(true);
    expect(isLive({ live: "1" })).toBe(true);
    expect(isLive({})).toBe(true);
    expect(isLive(null)).toBe(true);
    expect(isLive({ live: 0 })).toBe(false);
    expect(isLive({ live: "0" })).toBe(false);
  });

  it("tells a post refused because its page is gone from any other failure", () => {
    expect(postRefusal("FOREIGN KEY constraint failed")).toBe("page-gone");
    expect(postRefusal("D1_ERROR: foreign key constraint failed: SQLITE_CONSTRAINT")).toBe("page-gone");
    expect(postRefusal("Couldn’t reach the hub. Try again.")).toBe("other");
    expect(postRefusal("UNIQUE constraint failed: app_updates__entries.id")).toBe("other");
    expect(postRefusal(undefined)).toBe("other");
  });
});

describe("entry counts", () => {
  it("merges counts onto pages and reads a page with no row as empty", () => {
    const pages = [{ id: "p1", title: "A" }, { id: "p2", title: "B" }];
    const rows = [{ page_id: "p1", entry_count: "3", last_at: "2026-03-01T00:00:00Z" }];
    expect(withEntryStats(pages, rows)).toEqual([
      { id: "p1", title: "A", entry_count: 3, last_at: "2026-03-01T00:00:00Z" },
      { id: "p2", title: "B", entry_count: 0, last_at: null },
    ]);
    expect(withEntryStats(pages, undefined)[0].entry_count).toBe(0);
  });

  it("recounts and re-dates a page after a post or a delete", () => {
    const newest = { created_at: "2026-03-03T00:00:00Z" };
    const older = { created_at: "2026-03-01T00:00:00Z" };
    expect(entryStatsAfter({ entry_count: 1, last_at: older.created_at }, [newest, older], 1))
      .toEqual({ entry_count: 2, last_at: "2026-03-03T00:00:00Z" });
    // Deleting the newest: the date falls back to the one before it.
    expect(entryStatsAfter({ entry_count: 2, last_at: newest.created_at }, [older], -1))
      .toEqual({ entry_count: 1, last_at: "2026-03-01T00:00:00Z" });
    // Deleting the only one: no "last posted" at all.
    expect(entryStatsAfter({ entry_count: 1, last_at: older.created_at }, [], -1)).toEqual({ entry_count: 0, last_at: null });
  });

  it("never counts fewer than are loaded, and keeps the true count when older ones are not", () => {
    expect(entryStatsAfter({ entry_count: 0 }, [{ created_at: "a" }, { created_at: "b" }], 0).entry_count).toBe(2);
    expect(entryStatsAfter({ entry_count: 250 }, new Array(199).fill({ created_at: "a" }), -1).entry_count).toBe(249);
    expect(entryStatsAfter(undefined, [], -1).entry_count).toBe(0);
  });
});

describe("takePage", () => {
  it("returns a page of rows and whether older ones exist", () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => i);
    expect(takePage(rows)).toEqual({ rows: rows.slice(0, PAGE_SIZE), more: true });
    expect(takePage(rows.slice(0, PAGE_SIZE))).toEqual({ rows: rows.slice(0, PAGE_SIZE), more: false });
    expect(takePage([])).toEqual({ rows: [], more: false });
  });

  it("is read one row past the page size, so more is known", () => {
    expect(html.match(/LIMIT \$\{PAGE_SIZE \+ 1\}/g)).toHaveLength(2);
    expect(html).not.toMatch(/LIMIT \d/);
    // Paged on time and id together, so a tie at the boundary is not skipped.
    expect(html).toContain("(created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC");
  });
});

describe("shareSummary", () => {
  const PAGE = { messages_visibility: "family" };
  const everyone = (n) => Array.from({ length: n }, () => ({ audience: "everyone" }));
  const CEILING = `The page shows the newest ${SHARE_PAGE_MAX_ENTRIES} of them and ${SHARE_PAGE_MAX_PHOTOS} photos at most.`;

  it("says when nothing is on the page", () => {
    expect(shareSummary(PAGE, [])).toBe("No update is on the page yet. Visitors do not see each other's messages.");
    expect(shareSummary(PAGE, undefined)).toMatch(/^No update/);
    expect(shareSummary(PAGE, [{ audience: "family" }])).toMatch(/^No update is on the page yet\. 1 marked family only stays off it\./);
  });

  it("counts what is shared and what is held back", () => {
    expect(shareSummary(PAGE, [...everyone(1), { audience: "family" }, { audience: "family" }])).toBe(
      "1 update is marked for everyone, with its photos. 2 marked family only stay off it. Visitors do not see each other's messages.");
    expect(shareSummary(PAGE, [...everyone(2), { audience: "family" }])).toBe(
      "2 updates are marked for everyone, with their photos. 1 marked family only stays off it. Visitors do not see each other's messages.");
  });

  it("says visitors see each other's messages only when the page says everyone", () => {
    expect(shareSummary({ messages_visibility: "everyone" }, everyone(1))).toMatch(/Visitors see each other's messages\.$/);
    expect(shareSummary({}, everyone(1))).toMatch(/Visitors do not see each other's messages\.$/);
    expect(shareSummary(null, everyone(1))).toMatch(/Visitors do not see each other's messages\.$/);
  });

  it("names the page's ceilings once the photos could exceed them, and not before", () => {
    const fits = Math.floor(SHARE_PAGE_MAX_PHOTOS / MAX_PHOTOS_PER_ENTRY);
    expect(shareSummary(PAGE, everyone(fits))).not.toContain("at most");
    expect(shareSummary(PAGE, everyone(fits + 1))).toContain(CEILING);
    expect(shareSummary(PAGE, everyone(SHARE_PAGE_MAX_ENTRIES + 1))).toContain(CEILING);
  });

  it("does not present a partial count as the whole when older updates are unloaded", () => {
    expect(shareSummary(PAGE, everyone(3), true)).toBe(
      `3 or more updates are marked for everyone, with their photos. ${CEILING} Visitors do not see each other's messages.`);
    expect(shareSummary(PAGE, [], true)).toMatch(/^0 or more updates are/);
  });
});

describe("dates", () => {
  const AT = "2026-03-01T10:00:00Z";

  it("formats an instant as a date, and with its time", () => {
    expect(formatDay(AT)).toBe(new Date(AT).toLocaleDateString());
    expect(formatWhen(AT)).toBe(new Date(AT).toLocaleString());
    expect(formatDay(AT)).toMatch(/2026/);
    expect(formatWhen(AT)).not.toBe(formatDay(AT));
  });

  it("reads a bad one as empty", () => {
    expect(formatWhen("nope")).toBe("");
    expect(formatDay(undefined)).toBe("");
  });
});

describe("search fields", () => {
  it("matches a page on its title and its about text", () => {
    expect(searchableFields({ title: "Dad", about: "Recovery", status: "open" })).toEqual(["Dad", "Recovery"]);
  });

  it("matches an entry on title, body and the rendered author", () => {
    expect(entrySearchableFields({ title: "Home", body: "Today", member_id: "m1", author_name: "Old" }, MEMBERS))
      .toEqual(["Home", "Today", "Alex"]);
  });
});
