// Pure, browser-free logic for Updates — unit-tested in
// __tests__/logic.test.mjs. No DOM, no network, no module-level state.
//
// The permission helper takes a plain `isAdultMember` boolean rather than
// importing the hub SDK's isAdult: logic.js is imported by Node in tests, where
// "/hub-sdk.js" does not resolve. index.html supplies the flag from the SDK.

const FILE_ID = /^[0-9a-f-]{36}$/;

export const MAX_TITLE = 120;
export const MAX_BODY = 8000;
// Per entry, matching the share page's per-entry ceiling — an entry that
// carried more would have photos silently missing from the share page.
export const MAX_PHOTOS_PER_ENTRY = 12;
// The app reads a page's updates and messages this many at a time.
export const PAGE_SIZE = 200;
// What one share page shows: the manifest's feed max_items, and the hub's
// ceiling on photos across the whole page.
export const SHARE_PAGE_MAX_ENTRIES = 100;
export const SHARE_PAGE_MAX_PHOTOS = 100;
// The manifest's submit.max_submissions: what one link accepts in total.
export const MAX_MESSAGES_PER_LINK = 200;

const SERVER_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Saving a page's settings. `closed_at` is the share link's
 *  `submit.until_column`: the hub refuses a visitor's message once it has
 *  passed, which is the only thing that makes "closed" hold for a writable
 *  link (the link itself keeps resolving for open and closed pages alike). It
 *  is written by the statement, from the hub's clock, so a device whose clock
 *  runs fast cannot leave the form open: an open page has none, a page being
 *  closed gets now, and a page already closed keeps the time it closed — but
 *  never a time still to come, which would hold the form open on a page that
 *  reads as closed.
 *  __tests__/logic.test.mjs holds scenarios.json to this exact text. */
export const SAVE_PAGE_SQL =
  "UPDATE app_updates__pages SET title = ?, about = ?, status = ?, messages_visibility = ?, "
  + `closed_at = CASE WHEN ? = 'open' THEN NULL ELSE MIN(COALESCE(closed_at, ${SERVER_NOW}), ${SERVER_NOW}) END WHERE id = ?`;

/** Restoring an archived page: closed, not open, with a cutoff. A page may
 *  have been archived to stop visitor messages, and its links resolve again
 *  the moment it is restored. */
export const RESTORE_PAGE_SQL =
  `UPDATE app_updates__pages SET status = 'closed', closed_at = MIN(COALESCE(closed_at, ${SERVER_NOW}), ${SERVER_NOW}) `
  + "WHERE id = ? AND status = 'archived'";

/** Deleting a page, in the three statements it takes, in order.
 *
 *  An update's photos are reclaimed only when that update's own row is deleted
 *  (delete_file_list_columns); a cascade from the page drops rows and leaves
 *  the bytes. So the updates go first, then the page, and the hub refuses to
 *  run those two as one batch. What makes that safe is the first statement:
 *  from the moment a page's `live` is 0 the database refuses any new update
 *  under it (the entries table's foreign key), so nothing can be posted into
 *  the gap and lose its photos, by this device or any other.
 *  __tests__/logic.test.mjs holds scenarios.json to these exact texts. */
export const DELETE_PAGE_SQL = [
  "UPDATE app_updates__pages SET live = 0 WHERE id = ?",
  "DELETE FROM app_updates__entries WHERE page_id = ?",
  "DELETE FROM app_updates__pages WHERE id = ?",
];

/** Whether a page still takes updates. One whose deletion was started and
 *  did not finish does not, and can only be deleted again. */
export function isLive(page) {
  return Number(page?.live ?? 1) !== 0;
}

/** Why an update could not be stored, from the hub's refusal: the page it was
 *  for is gone or going (the foreign key), or anything else. */
export function postRefusal(message) {
  return /FOREIGN KEY constraint failed/i.test(message ?? "") ? "page-gone" : "other";
}

/** Hub file ids are UUIDs. Any adult can write a file-id column with raw SQL,
 *  so the shape is checked exactly as the hub checks it before projecting a
 *  share page — a crafted id must never reach a URL the app builds. */
export function parseIds(raw) {
  try {
    const parsed = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(v => typeof v === "string" && FILE_ID.test(v));
  } catch { return []; }
}

/** An entry's `photo_thumbs`: photo id -> the id of its small copy. Arrives as
 *  the stored JSON text (or already parsed); anything else reads as no small
 *  copies at all. Both sides are held to the file-id shape for the same reason
 *  parseIds is — a small copy's id reaches a URL too. */
export function parseThumbs(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const thumbs = {};
  for (const [photoId, thumbId] of Object.entries(parsed)) {
    if (FILE_ID.test(photoId) && typeof thumbId === "string" && FILE_ID.test(thumbId)) thumbs[photoId] = thumbId;
  }
  return thumbs;
}

/** The file to draw in a tile: the photo's small copy when it has one, else
 *  the photo itself. */
export function tilePhotoId(photoId, thumbs) {
  return (Object.hasOwn(thumbs ?? {}, photoId) && thumbs[photoId]) || photoId;
}

/** The map to store beside `file_ids`, built from the composer's photos
 *  ({ id, thumbnailId }). Only photos still in the list get an entry, so one
 *  removed before posting takes its small copy's id with it. */
export function thumbsFor(photos) {
  const thumbs = {};
  for (const photo of photos ?? []) {
    if (photo?.id && typeof photo.thumbnailId === "string" && photo.thumbnailId) thumbs[photo.id] = photo.thumbnailId;
  }
  return thumbs;
}

/** How many of the chosen files may still be attached. In-flight uploads count
 *  against the limit, so two quick selections cannot overshoot it together. */
export function photoRoom(attached, uploading) {
  return Math.max(0, MAX_PHOTOS_PER_ENTRY - attached - uploading);
}

export function pageById(pages, id) {
  return pages.find(p => p.id === id) ?? null;
}

/** All three tables are `adult_writable`: any adult opens a page, posts an
 *  update, edits or deletes one, and removes a visitor's message. That is a
 *  capability of being an adult, in a household and in a shared space alike, so
 *  there is no steward-only case to mirror. Children read. */
export function canManage(isAdultMember) {
  return !!isAdultMember;
}

/** Who the page is being shown to. Outside the hub (demo mode) the first demo
 *  member stands in. Inside it, a missing current member is nobody: adopting
 *  the first roster member would hand a stranger an adult's controls and stamp
 *  that adult's name on what they post. */
export function resolveCurrentMember(hubMember, members, inHub) {
  if (hubMember) return hubMember;
  if (inHub) return { id: "", name: "", role: "guest" };
  return members[0] ?? { id: "guest", name: "Guest", role: "adult" };
}

/** The author line inside the app: the roster name, so a rename follows old
 *  entries; the name stored with the entry once its author has left. */
export function entryAuthor(entry, members) {
  const member = members.find(m => m.id === entry?.member_id);
  return member?.name || entry?.author_name || "Someone";
}

/** Whether an entry is on the share page. Anything that is not exactly
 *  "everyone" stays inside: the hub's feed filter reads the same column. */
export function onSharePage(entry) {
  return entry?.audience === "everyone";
}

/** A form's audience value. Only an exact "everyone" publishes; anything
 *  else, including a value this code does not know, stays with the family. */
export function cleanAudience(value) {
  return value === "everyone" ? "everyone" : "family";
}

/** A form's "who reads visitors' messages" value, closed the same way. */
export function cleanMessagesVisibility(value) {
  return value === "everyone" ? "everyone" : "family";
}

/** A form's status value, held to the three the table's CHECK accepts. An
 *  unknown one keeps the page as it is. */
export function cleanStatus(value, current) {
  return value === "open" || value === "closed" || value === "archived" ? value : current;
}

/** What an entry form may save, or the reason it may not. Photos alone are
 *  not enough: the title is the entry's heading on the share page. */
export function entryDraft({ title, body, audience } = {}) {
  const cleanTitle = String(title ?? "").trim();
  const cleanBody = String(body ?? "").trim();
  if (!cleanTitle) return { error: "Give the update a title." };
  if (cleanTitle.length > MAX_TITLE) return { error: `Keep the title to ${MAX_TITLE} characters.` };
  if (cleanBody.length > MAX_BODY) return { error: `Keep the update to ${MAX_BODY} characters.` };
  return { value: { title: cleanTitle, body: cleanBody, audience: cleanAudience(audience) } };
}

/** What a new-page form may save, or the reason it may not. */
export function pageDraft({ title, about } = {}) {
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) return { error: "Give the page a title." };
  if (cleanTitle.length > MAX_TITLE) return { error: `Keep the title to ${MAX_TITLE} characters.` };
  return { value: { title: cleanTitle, about: String(about ?? "").trim() } };
}

/** The settings form as the values SAVE_PAGE_SQL takes, in its order, plus the
 *  fields to mirror locally. A blank title is refused, not silently replaced. */
export function pageSettingsPatch(form, page) {
  const draft = pageDraft(form);
  if (draft.error) return { error: draft.error };
  const status = cleanStatus(form?.status, page.status);
  const fields = {
    ...draft.value,
    status,
    messages_visibility: cleanMessagesVisibility(form?.messages_visibility),
  };
  return {
    fields,
    params: [fields.title, fields.about, fields.status, fields.messages_visibility, fields.status, page.id],
  };
}

/** The `closed_at` to show locally after a save, mirroring what SAVE_PAGE_SQL
 *  stored: none while open, else the time the page first closed. The stored
 *  value comes from the hub's clock; this is only the page's copy of it. */
export function closedAtFor(status, page, now) {
  if (status === "open") return null;
  return page?.closed_at || now;
}

/** Only an open page takes visitor messages; a closed one stays readable. */
export function takesMessages(page) {
  return page?.status === "open";
}

/** Per-page entry counts and last-posted times from the grouped count rows,
 *  merged onto the pages. A page with no entries has no row at all. */
export function withEntryStats(pages, statRows) {
  const stats = new Map((statRows ?? []).map(r => [r.page_id, r]));
  return pages.map(page => ({
    ...page,
    entry_count: Number(stats.get(page.id)?.entry_count) || 0,
    last_at: stats.get(page.id)?.last_at ?? null,
  }));
}

/** A page's count and last-posted time after its loaded entries changed.
 *  `entries` is newest first, so its head is the latest; with older ones still
 *  unloaded the count is at least what is loaded. */
export function entryStatsAfter(page, entries, countDelta) {
  return {
    entry_count: Math.max(entries.length, Number(page?.entry_count ?? 0) + countDelta, 0),
    last_at: entries[0]?.created_at ?? null,
  };
}

/** One read of PAGE_SIZE + 1 rows, split into the page and whether more exist. */
export function takePage(rows) {
  return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
}

/** What someone with the link will see, said before a link is made. Counts
 *  come from the entries loaded for the page; `more` says older ones exist. */
export function shareSummary(page, entries, more = false) {
  const shared = (entries ?? []).filter(onSharePage).length;
  const held = (entries ?? []).length - shared;
  const parts = [];
  if (shared === 0 && !more) parts.push("No update is on the page yet.");
  else parts.push(`${shared}${more ? " or more" : ""} update${shared === 1 && !more ? " is" : "s are"} marked for everyone, with ${shared === 1 && !more ? "its" : "their"} photos.`);
  // Only said once it can matter: below this, every photo of every update fits.
  if (more || shared > SHARE_PAGE_MAX_ENTRIES || shared * MAX_PHOTOS_PER_ENTRY > SHARE_PAGE_MAX_PHOTOS) {
    parts.push(`The page shows the newest ${SHARE_PAGE_MAX_ENTRIES} of them and ${SHARE_PAGE_MAX_PHOTOS} photos at most.`);
  }
  if (held > 0) parts.push(`${held} marked family only ${held === 1 ? "stays" : "stay"} off it.`);
  parts.push(page?.messages_visibility === "everyone"
    ? "Visitors see each other's messages."
    : "Visitors do not see each other's messages.");
  return parts.join(" ");
}

export function formatWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function formatDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** Fields the page-list search matches against (see hub-sdk `searchMatch`). */
export function searchableFields(page) {
  return [page.title, page.about];
}

/** Fields the in-page search matches against. The author is the RENDERED
 *  name, so searching a member's current name finds what they wrote under an
 *  older one. */
export function entrySearchableFields(entry, members) {
  return [entry.title, entry.body, entryAuthor(entry, members)];
}

/**
 * The line a failed write shows ("Refused, gone, or failed: which line"), from
 * the error's `status` / `code` — never the hub's text. `forUser` marks a
 * message this app worded itself (a photo it would not send, say).
 */
export function failureLine(e, { action, thing } = {}) {
  if (e?.forUser) return e.message;
  if (e?.code === "UNIQUE_CONSTRAINT" || /UNIQUE constraint failed/i.test(String(e?.message ?? ""))) return `That ${thing} already exists.`;
  if (e?.status === 403) return `You don’t have permission to ${action}.`;
  if (e?.status === 507) return "The household’s storage is full — free up space first.";
  if (e?.status === 429) return "Too many tries — wait a minute and try again.";
  return `Couldn’t ${action} — try again.`;
}

/** The line a failed photo upload shows: the upload's own refusals first. */
export function uploadFailureLine(e) {
  if (e?.status === 413) return "That photo is too large.";
  if (e?.status === 415) return "That kind of file can’t be uploaded.";
  return failureLine(e, { action: "add that photo", thing: "photo" });
}

/** The line a failed share-link create, revoke or list shows. */
export function shareFailureLine(e, { action, thing } = {}) {
  if (e?.status === 402) return "Too many share links are active — revoke one first.";
  if (e?.status === 409 && e?.code === "share_link_limit") return "Too many share links are active — revoke one first.";
  if (e?.status === 400 && e?.code === "password_too_short") return "The password needs at least 6 characters.";
  if (e?.status === 403) return `You don’t have permission to ${action}.`;
  if (e?.status === 404) return `This ${thing} has been removed.`;
  if (e?.status === 429) return "Too many tries — wait a minute and try again.";
  return `Couldn’t ${action} — try again.`;
}
