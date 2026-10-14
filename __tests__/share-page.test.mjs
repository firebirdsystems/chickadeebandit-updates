import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

/**
 * The share link is this app's whole reason to exist, and what it shows is
 * decided in the manifest, not in the page: the hub renders the visitor's side
 * from `shareable`, and member row policies do not apply there. These checks
 * pin the declarations that keep private things private.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));

const migrationsDir = join(__dirname, "../migrations");
const schema = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
  .join("\n");

function columnsOf(table) {
  const body = schema.match(
    new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?app_[a-z0-9_]+__${table}\\s*\\(([\\s\\S]*?)\\n\\);`),
  );
  expect(body, `no CREATE TABLE for ${table}`).toBeTruthy();
  const created = body[1]
    .split("\n")
    .map((line) => line.trim().match(/^([a-z_]+)\s+(TEXT|INTEGER|REAL|BLOB)\b/i))
    .filter(Boolean)
    .map((m) => m[1]);
  const altered = [...schema.matchAll(
    new RegExp(`ALTER TABLE app_[a-z0-9_]+__${table} ADD COLUMN ([a-z_]+)\\b`, "g"),
  )].map((m) => m[1]);
  return [...created, ...altered];
}

const page = manifest.shareable.page;
const feedFor = (table) => page.feeds.find((f) => f.table === table);
const plaintext = new Set(manifest.db_plaintext_columns);

describe("what a visitor reads", () => {
  it("shares one item type, the page", () => {
    expect(Object.keys(manifest.shareable)).toEqual(["page"]);
  });

  it("stops resolving for an archived page", () => {
    expect(page.visible_where).toEqual({ column: "status", values: ["open", "closed"] });
  });

  it("shows only entries marked for everyone", () => {
    expect(feedFor("entries").where).toEqual([{ column: "audience", values: ["everyone"] }]);
  });

  it("projects no member id from any table", () => {
    const projected = [
      ...page.columns.map((c) => c.column),
      ...page.feeds.flatMap((f) => f.columns.map((c) => c.column)),
    ];
    for (const column of projected) expect(column).not.toMatch(/(^|_)(member_id|created_by)$/);
  });

  it("projects, filters and orders only on columns the tables have", () => {
    const own = [
      page.title_column, page.visible_where.column, page.files.ids_column,
      ...page.columns.map((c) => c.column),
      // A feed's parent_where reads the shared row, not the feed's table.
      ...page.feeds.map((f) => f.parent_where?.column).filter(Boolean),
    ];
    for (const column of own) expect(columnsOf(page.table), `${page.table}.${column}`).toContain(column);
    for (const feed of page.feeds) {
      const columns = columnsOf(feed.table);
      const used = [
        feed.fk_column, feed.order_column, feed.files_column,
        ...feed.columns.map((c) => c.column), ...(feed.where ?? []).map((w) => w.column),
      ].filter(Boolean);
      for (const column of used) expect(columns, `${feed.table}.${column}`).toContain(column);
    }
  });

  // The switches a visitor's view turns on must fail closed: a row written
  // without saying so is not published, and strangers' text is not shown to
  // other strangers until an adult chooses that.
  it("defaults an update to the family and visitors' messages to the family", () => {
    expect(schema).toMatch(/audience\s+TEXT NOT NULL DEFAULT 'family'/);
    expect(schema).toMatch(/messages_visibility TEXT NOT NULL DEFAULT 'family'/);
  });

  it("keeps the Home card, which a kitchen display can show, to updates marked for everyone on pages that are not archived", () => {
    expect(manifest.glance.source.query).toContain("WHERE e.audience = 'everyone' AND p.status IN ('open', 'closed')");
    expect(page.visible_where.values).toEqual(["open", "closed"]);
  });

  it("lets the page turn off visitors reading each other's messages", () => {
    expect(feedFor("messages").parent_where).toEqual({ column: "messages_visibility", values: ["everyone"] });
    expect(plaintext.has("messages_visibility")).toBe(true);
  });
});

describe("what a visitor writes", () => {
  const submit = page.submit;

  it("writes only columns the messages table has", () => {
    const columns = columnsOf(submit.table);
    const written = [
      submit.fk_column, ...submit.fields.map((f) => f.column),
      ...Object.keys(submit.fixed_values ?? {}), ...(submit.timestamp_columns ?? []),
    ];
    for (const column of written) expect(columns, `${submit.table}.${column}`).toContain(column);
  });

  it("stores the visitor's text in columns declared plaintext", () => {
    for (const field of submit.fields) expect(plaintext.has(field.column), field.column).toBe(true);
    for (const column of Object.keys(submit.fixed_values)) expect(plaintext.has(column), column).toBe(true);
  });

  // db_plaintext_columns goes by column NAME across every table. A visitor's
  // text has to be plaintext; an update's title, body and author must not be
  // dragged along by sharing a name with it.
  it("keeps an entry's own text encrypted", () => {
    for (const column of ["title", "body", "author_name", "about", "file_ids", "photo_thumbs"]) {
      expect(plaintext.has(column), column).toBe(false);
    }
    for (const field of submit.fields) expect(columnsOf("entries")).not.toContain(field.column);
  });

  it("closes the form with the page", () => {
    expect(submit.until_column).toBe("closed_at");
    expect(columnsOf(page.table)).toContain("closed_at");
  });

  it("caps the table and each link, and logs each outside row", () => {
    const policy = manifest.row_policies[submit.table];
    expect(policy.kind).toBe("adult_writable");
    expect(policy.audit_writes).toBe(true);
    expect(policy.max_rows).toBe(5000);
    expect(submit.max_submissions).toBe(200);
  });

  // The hub's form is the only writer: every column it fills is closed to
  // members, so a row is always what a visitor typed. Adults keep DELETE.
  it("lets no member write or change a message", () => {
    const acls = manifest.row_policies[submit.table].column_write_acls;
    const written = [
      submit.fk_column, ...submit.fields.map((f) => f.column),
      ...Object.keys(submit.fixed_values), ...submit.timestamp_columns,
    ];
    for (const column of written) expect(acls[column], column).toEqual({ writable_by: [] });
    // The hub fills the id; a member may not rename the row afterwards either.
    expect(acls.id).toEqual({ writable_by: [], actions: ["update"] });
    expect(Object.keys(acls).sort()).toEqual([...columnsOf(submit.table)].sort());
  });

  it("lets no one move an update to another author, page or time after it is posted, and logs each change", () => {
    const policy = manifest.row_policies.entries;
    for (const column of ["member_id", "author_name", "page_id", "created_at"]) {
      expect(policy.column_write_acls[column], column).toEqual({ writable_by: [], actions: ["update"] });
    }
    expect(policy.audit_writes).toBe(true);
  });

  // The hub publishes this when a visitor's message lands, and refuses any
  // hub-origin event a member posts, whatever a manifest says. Its payload carries the visitor's name and message, which is sound
  // only because every member already reads the messages table in full.
  it("fires a namespaced hub event for each message, and alerts members", () => {
    expect(submit.event).toBe(`${manifest.id}.message_submitted`);
    expect(manifest.alert_on).toEqual([submit.event]);
    expect(manifest.row_policies[submit.table].member_read_column).toBeUndefined();
    expect(manifest.row_policies[submit.table].column_read_acls).toBeUndefined();
  });

  it("does not claim in publishes an event it never posts", () => {
    expect(manifest.publishes ?? []).toEqual([]);
  });
});

describe("files", () => {
  it("declares every file column for reclaim", () => {
    // One `file_columns` entry covers both the DELETE and the UPDATE lane.
    expect(manifest.file_columns).toEqual({
      pages: { list_columns: ["cover_file_ids"] },
      entries: { list_columns: ["file_ids"] },
    });
    // photo_thumbs holds small copies' ids as a JSON OBJECT. A small copy is
    // deleted with its photo, and declaring an object column as a file list
    // would break every reclaim, so it must stay undeclared.
    expect(JSON.stringify(manifest.file_columns)).not.toContain("photo_thumbs");
  });

  it("publishes exactly the declared file columns", () => {
    expect(page.files.ids_column).toBe("cover_file_ids");
    expect(feedFor("entries").files_column).toBe("file_ids");
    expect(feedFor("messages").files_column).toBeUndefined();
  });
});
