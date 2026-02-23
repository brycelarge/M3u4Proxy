# M3u4Proxy — Feature Assessment
_Last updated: 2026-02-21_

---

## ✅ Completed Features

| Feature | Notes |
|---|---|
| Group ordering | Drag-to-reorder groups per playlist |
| Channel number assignment | UI in Review modal, stored as `sort_order` |
| Playlist scheduler | Cron-based auto-rebuild |
| Xtream Codes API | Per-user auth, categories, streams, M3U, XMLTV |
| Per-playlist filtered XMLTV | `/api/playlists/:id/xmltv` |
| Stream stats | Bitrate, bytesIn/Out, reconnects, active sessions |
| Backup & restore | Gzipped JSON bundle including XML files |
| Dark / light theme | CSS vars + `data-theme`, persisted to localStorage |
| Remove Load Playlist button | Replaced with Sources page workflow |
| Mobile responsive layout | Hamburger nav, sidebar drawer, responsive tables |
| User / client portal | Multi-user with playlist assignment, stream limits, expiry |
| **Password hashing** | `crypto.scrypt` with salt, stored as `scrypt$salt$hash`; verified on stream auth and Xtream API |
| **Admin UI login wall** | Session-based auth via `admin_sessions` table; token in `localStorage`; set `ADMIN_PASSWORD` in `.env` |
| **Active stream count per user** | Users table shows `N/max` live streams, polled from `/api/streams` |
| **Xtream connection info modal** | 📋 Connect button per user — shows Server, Username, API URL, M3U URL, XMLTV URL with one-click copy |
| **Expiry warnings** | Amber "Expires in Xd" badge on users expiring within 7 days; "Expiring soon" counter in stats row |
| **User activity log** | `stream_history` table; 📜 History button per user shows last 50 sessions with channel, group, start time, duration |
| **Dead channels report** | `failed_streams` table; Diagnostics tab shows report with clear action |
| **TMDB EPG enrichment** | Auto-runs after every EPG grab if `TMDB_API_KEY` set; injects `<icon>` (poster) and `<desc>` into programmes missing them; manual trigger on EPG Scraper page |
| **Proxy buffering** | `PROXY_BUFFER_SECONDS` env var; configurable via Settings → Proxy tab; pre-buffer flushed to joining clients; takes effect immediately without restart |
| **Architecture diagram** | SVG data-flow diagram at `docs/architecture.svg`; viewable in Settings → Architecture tab |
| **Diagnostics tab** | Speed test, VPN IP check, DNS check; dead channels report with clear action |
| **HDHomeRun virtual devices** | Per-playlist tuner simulation; Plex/Emby/Jellyfin discovery URLs shown in Settings |

---

## 🔴 Bugs / Broken

> ✅ All known bugs fixed.

### ~~1. Route ordering conflict in `xtream.js`~~
**Fixed:** Wildcard `/xtream/:user/:pass/:channelId` moved to last.

### ~~2. `res.sendFile` needs absolute path~~
**Fixed:** `res.sendFile(resolve(GUIDE_XML))`.

### ~~3. Unused import in `xtream.js`~~
**Fixed:** `readFileSync` removed; replaced with `resolve`.

### ~~4. Stream session key collision~~
**Fixed:** Plain `channelId` used as session key — multiple users share one upstream.

### ~~5. No password hashing~~
**Fixed:** `crypto.scrypt` hashing in `server/auth.js`; all user create/update/auth paths updated.

### ~~6. `lookupUser` was synchronous~~
**Fixed:** All Xtream route handlers converted to `async`; `lookupUser` awaited everywhere.

---

## 🟡 Missing / Incomplete Features

### Users page
- No **search / filter** on the users table (fine at <20 users, annoying at 50+).

### EPG
- **Per-user EPG filtering** — all users share the global `guide.xml`. Serving a
  XMLTV filtered to only channels in the user's assigned playlist is not yet implemented.

### Backup / Restore
- Verify **restore** correctly round-trips the `users` table (it iterates `BACKUP_TABLES`
  so should be fine, but worth a test restore to confirm).

---

## 🟢 Nice-to-Have Additions

| Feature | Effort | Status |
|---|---|---|
| **Bulk user import** via CSV (username, password, playlist, expiry) | Medium | ⬜ Pending |
| **Password generator** button in user create/edit form | Low | ⬜ Pending |
| **Last connected** timestamp per user (updated on stream auth) | Low | ⬜ Pending |
| **Global filtered XMLTV** — single endpoint serving only playlist-mapped channels | Medium | ⬜ Pending |
| **Per-user EPG** — XMLTV filtered to only channels in the user's playlist | Medium | ⬜ Pending |
| **User search/filter** on Users table | Low | ⬜ Pending |
| **Container rebuild workflow** — document the `docker compose up --build` flow | Low | ⬜ Pending |
| **Multi-source channel failover** — each channel can have multiple source URLs with priority/capacity; automatic failover if primary is down/full; EPG mapper shows source count + manage sources UI | High | ⬜ Pending |
