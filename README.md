# Updates

A [Chickadee Bandit](https://chickadeebandit.com/app-library/updates) app.

Keep a wide circle informed from one page. Post news on a recovery, a new baby or a long stay away, share a single link, and friends and relatives read it and leave a message without an account.

## Model

| Table | What it holds |
| --- | --- |
| `pages` | One thing a circle is following. Title, about text, a photo, status, and whether visitors read each other's messages. `adult_writable`. |
| `entries` | One update on a page: title, body, photos (`file_ids`), author, and its audience. `adult_writable`: adults post, edit and delete; everyone reads. Its author, author name, page and posting time cannot be changed after it is posted (`column_write_acls`), and every write is logged (`audit_writes`). |
| `messages` | One message from a visitor, inserted by the hub's share-link form. `adult_writable` with `audit_writes` and `max_rows`. Every column is closed to members (`column_write_acls` with an empty `writable_by`), so a row is always what a visitor typed. Adults can delete one; everyone reads. |

All three policies are `adult_writable`, which is a capability of being an adult. In a shared space every participant is an adult, so every sibling in a care space can post to the same page, correct what another wrote, change its audience, and remove it. There is no steward-only case. That is a deliberate choice for a small circle that shares the care; a space where that is too open should keep the page in one household instead. Two things follow from it and are not prevented: the author stored with an update is whatever the page sent when it was posted, so an adult writing SQL by hand can post under another member's name, and the "edited" mark is the page's own note rather than proof. The write log an admin can read records who really did what.

### The switches that decide who sees what

1. **`entries.audience`** is `everyone` or `family`. The share page's feed filters on `audience = 'everyone'`, so a family-only update and its photos never reach a link. Every member reads both. The column defaults to `family`, and the page treats anything but an exact `everyone` as `family`, so a row written without saying so is not published.
2. **`pages.status`**: `open` takes visitor messages, `closed` is read-only while links keep working, `archived` takes the page off the list and stops every link (`shareable.visible_where`). Adults still see an archived page under Archived and can restore or delete it.
3. **`pages.closed_at`** is the share form's `until_column`. A link resolves for open and closed pages alike, so this timestamp, not the status, is what shuts a writable link's form. The save statement writes it from the hub's clock and never keeps one still to come (`SAVE_PAGE_SQL` in `src/logic.js`), and a CHECK refuses a page that is not open and has none.
4. **`pages.messages_visibility`**: `family` (the default) lets a visitor leave a message that only members read; `everyone` also shows visitors each other's messages (`feeds[1].parent_where`).

The Home card (`glance`) lists the newest updates marked for everyone, on pages that are not archived, because a household can put that card on a kitchen display.

### Why the message columns are named `guest_*`

The hub writes a visitor's text without the encryption codec, so the form's columns must be listed in `db_plaintext_columns`. That list goes by column name across every table. Had the messages table used `body` and `author_name`, an update's own body and author would have become plaintext at rest too. `__tests__/share-page.test.mjs` pins this.

## Sharing

A household's own sharing setting comes first: it can turn sharing off or limit it to admins, and a shared space starts with only its steward able to create links. Within that, any adult can create a read-only link. The `sharing` capability, included with every live plan, adds visitor messages, a password and one-year expiry. Those controls appear in the Share dialog only for entitled households.

Each message fires `updates.message_submitted`, which the hub publishes from the share-link submit path and which lights members' notification bell (`alert_on`). The bell entry names the app, not the visitor or the text, and reaches every member with a login who may open the app. The hub refuses any hub-origin event a member posts, so one cannot be forged; the manifest leaves it out of `publishes` because the app never posts it.

A visitor's message passes a bot check, is rate-limited, is capped at 200 per link and 5,000 for the household, and lands with `source = 'external'` and the hub's own timestamp.

## Known limits

- **Visitors are not notified of a new update.** There are no followers: a share-link visitor is anonymous. People open the link to read the latest.
- **The share page shows the newest 100 updates and at most 100 photos**, 12 per update. Older updates and photos beyond that stay in the app.
- **Each shared update shows the name of whoever posted it**, and a photo's original file name is visible to visitors.
- **Visitors cannot attach photos.** The share-link write surface is text-only.
- **Messages are not held for approval.** With visitors reading each other's messages turned on, a message shows as soon as it is sent. An adult removes one by deleting it.
- **An update's photos are fixed once posted.** Title, body and audience can be edited. To change photos, delete the update and post it again.
- **Deleting a page is three statements, on purpose** (`DELETE_PAGE_SQL` in `src/logic.js`). `file_columns` (`list_columns`) reclaims an update's photos when that update is deleted; a cascade from the page only drops rows, and the hub refuses a batched delete on a table with declared file columns. So the app first sets the page's `live` to 0, then deletes the updates, then the page. The first statement is what makes the gap safe: `entries` has a foreign key on `(page_id, page_live)` to `pages (id, live)`, so from then on the database refuses any new update for that page, from any device. If a later statement fails the page says so, shows as "Not fully deleted", takes no updates, and is deleted again to finish. Anything else that deletes a page row directly leaves its updates' photos in storage, unreachable from any link.
- **An update can only be posted to a page that exists.** The same foreign key refuses a post from a composer left open after someone else deleted the page; the member is told and the list is re-read.
- **The app reads 200 updates and 200 messages at a time**, with a control to show older ones. In-page search covers what is loaded.

## Development

```bash
make setup     # once per clone: enables the pre-push hook (build + tests)
npm install
npm run dev    # local dev server, demo mode (no hub attached)
npm test
npm run build  # writes dist/
```
