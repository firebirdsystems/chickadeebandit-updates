-- Updates: one page per thing a circle is following, a journal of entries on
-- it, and the messages visitors leave.
--
-- Migrations are additive only: add 002_*.sql, 003_*.sql for later changes.
-- Never DROP/RENAME; the runner applies each version exactly once, in order.

-- A page is the shareable item. `adult_writable`: adults open and manage
-- pages, everyone in the household reads them.
CREATE TABLE IF NOT EXISTS app_updates__pages (
  id              TEXT NOT NULL PRIMARY KEY,
  title           TEXT NOT NULL,
  about           TEXT NOT NULL DEFAULT '',
  cover_file_ids  TEXT NOT NULL DEFAULT '[]', -- JSON array of hub file ids (one photo today)

  -- open: taking visitor messages; closed: read-only, share links still resolve;
  -- archived: hidden from share links entirely (shareable.visible_where).
  -- CHECK is enforceable only because these enum columns are plaintext.
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'closed', 'archived')),

  -- When the page stopped taking messages: an ISO instant, NULL while open.
  -- The share link's submit.until_column. A link resolves for open and closed
  -- pages alike, so this is what makes "closed" hold for a writable link —
  -- hence the CHECK: a page that is not open always carries a cutoff.
  closed_at       TEXT
                    CHECK (status = 'open' OR closed_at IS NOT NULL),

  -- Whether a visitor reads the messages other visitors left
  -- (shareable.feeds[1].parent_where). With "family", a visitor can still
  -- write one, and only members read them. That is the default: nothing a
  -- stranger types is shown to other visitors until an adult turns it on.
  messages_visibility TEXT NOT NULL DEFAULT 'family'
                    CHECK (messages_visibility IN ('everyone', 'family')),

  -- 1 while the page takes updates, 0 from the moment it is being deleted.
  -- Every entry carries a copy (page_live) under a foreign key on (id, live),
  -- so the database itself refuses an update posted to a page that is gone or
  -- going: see the entries table.
  live            INTEGER NOT NULL DEFAULT 1
                    CHECK (live IN (0, 1)),

  created_by      TEXT NOT NULL,              -- member id of whoever opened it
  created_at      TEXT NOT NULL,

  UNIQUE (id, live)
);

-- One update on a page, written by an adult member. Title, body, author name
-- and photos are encrypted at rest; the share page decrypts what it projects.
CREATE TABLE IF NOT EXISTS app_updates__entries (
  id           TEXT NOT NULL PRIMARY KEY,
  page_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  -- Denormalized: the share page projects columns from this row and cannot
  -- join the roster. Inside the app the roster name is shown instead.
  author_name  TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  file_ids     TEXT NOT NULL DEFAULT '[]',    -- JSON array of hub file ids (photos)
  photo_thumbs TEXT NOT NULL DEFAULT '{}',    -- JSON object: photo id -> small copy id

  -- everyone: on the share page and in the app; family: in the app only.
  -- The share feed filters on it, so it is the one switch that keeps an
  -- entry, and its photos, off every link. It defaults to family: a row
  -- written without saying so is never published.
  audience     TEXT NOT NULL DEFAULT 'family'
                 CHECK (audience IN ('everyone', 'family')),

  edited_at    TEXT,
  created_at   TEXT NOT NULL,

  -- The page's `live` flag as it was when this row was written: always 1,
  -- by its default (no member may write the column). The foreign key below
  -- then means an entry can be inserted only under a page that exists AND is
  -- live. Deleting a page starts by setting its live to 0, which this key
  -- copies onto the page's entries, and from that statement on no new entry
  -- can arrive: not from a composer left open on another device, and not in
  -- the gap between "delete the entries" (which reclaims their photos) and
  -- "delete the page".
  page_live    INTEGER NOT NULL DEFAULT 1,

  FOREIGN KEY (page_id, page_live) REFERENCES app_updates__pages (id, live)
    ON UPDATE CASCADE ON DELETE CASCADE
);

-- One message from a visitor, inserted by the hub's share-link form. Members
-- cannot write here: every column is locked by column_write_acls, so a row is
-- always what a visitor typed. Adults may delete one. Named guest_* so that
-- listing these columns as plaintext (the hub writes a visitor's text in the
-- clear) does not also unencrypt an entry's body.
CREATE TABLE IF NOT EXISTS app_updates__messages (
  id            TEXT NOT NULL PRIMARY KEY,
  page_id       TEXT NOT NULL,
  guest_name    TEXT NOT NULL DEFAULT '',
  guest_message TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'external'
                  CHECK (source IN ('external')),
  created_at    TEXT NOT NULL,

  FOREIGN KEY (page_id) REFERENCES app_updates__pages (id) ON DELETE CASCADE
);

-- A page's entries, newest first, and the per-page counts on the list.
CREATE INDEX IF NOT EXISTS app_updates__entries_page_idx
  ON app_updates__entries (page_id, created_at);

-- The share-link feed's exact filter and order.
CREATE INDEX IF NOT EXISTS app_updates__entries_feed_idx
  ON app_updates__entries (page_id, audience, created_at);

-- The newest entries marked for everyone, across every page, for the Home card
-- (which then drops those whose page is archived, by the page's primary key).
CREATE INDEX IF NOT EXISTS app_updates__entries_audience_idx
  ON app_updates__entries (audience, created_at);

-- A page's messages, newest first, in the app and on the share page.
CREATE INDEX IF NOT EXISTS app_updates__messages_page_idx
  ON app_updates__messages (page_id, created_at);

-- Page list, newest first.
CREATE INDEX IF NOT EXISTS app_updates__pages_created_idx
  ON app_updates__pages (created_at);
