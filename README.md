# M3u4Prox

A full-stack IPTV playlist manager that makes IPTV easy. Supports many feeds and many outputs with a clean, responsive interface that works on desktop and mobile devices.

---

## Features

- **Sources** — save multiple M3U URLs and Xtream Codes connections with optional cron refresh schedules
- **Channel Browser** — browse source channels by group with virtual scrolling, card or table view, and select content for your playlists
- **Playlists** — create named playlists (e.g. "Live TV", "VOD"), set an output path and rebuild schedule with automatic generation
- **EPG Scraper** — If your IPTV provider has incomplete EPG data, then EPG Scapper is built right in to the application to scrape known sources for missing EPG data and map it to your channels
- **EPG Mappings** — override `tvg-id` values to fix EPG matching between channels and guide data
- **HDHomeRun Integration** — built-in support for HDHomeRun tuners, perfect for Plex/Emby users wanting to integrate over-the-air channels
- **Xtream Codes API** — full Xtream Codes API support for IPTV apps like IPTV Smarters, TiviMate, and other popular IPTV players
- **EPG Enrichment** — automatically enrich EPG data with TMDB metadata for better guide information
- **Multi-Source Support** — combine multiple IPTV providers, local tuners, and custom sources into unified playlists
- **Mobile Responsive** — fully responsive design works on desktop, tablet, and mobile devices

---

## Installation

### Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/brycelarge/m3u4prox.git
cd m3u4prox

# Start the container
docker compose up -d
```

Access the application at [http://your-host:3005](http://your-host:3005).

### Local Development

Requires **Node 22+**.

```bash
# Install dependencies
npm install

# Start both backend and frontend
npm run dev:all
```

Or run them separately:

```bash
# Terminal 1 — Express backend on :3005
npm run dev:server

# Terminal 2 — Vite dev server on :5173 (proxies /api to :3005)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

---

## Architecture

![Architecture Diagram](/docs/architecture.svg)

The architecture diagram shows the data flow from sources through the application to various outputs.

---

## Docker Configuration

The service is defined in the root `docker-compose.yml`:

```yaml
m3u4prox:
  build:
    context: .
  ports:
    - "3005:3005"
  volumes:
    - ./data:/data      # SQLite DB
    - ./output:/output  # Generated M3U files
    - ./epg:/epg        # EPG directory (channels.xml + guide.xml)
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/sources` | List / create sources |
| PUT/DELETE | `/api/sources/:id` | Update / delete source |
| GET/POST | `/api/playlists` | List / create playlists |
| PUT/DELETE | `/api/playlists/:id` | Update / delete playlist |
| POST | `/api/playlists/:id/build` | Manually trigger M3U rebuild |
| GET/POST | `/api/epg-mappings` | List / create EPG ID overrides |
| DELETE | `/api/epg-mappings/:id` | Delete mapping |
| GET | `/api/epg/channels-xml` | Read current `channels.xml` |
| PUT | `/api/epg/channels-xml` | Save `channels.xml` |
| GET | `/api/epg/channels` | Parse guide.xml, return channel list |
| GET | `/api/epg/search?q=` | Search guide channels by name/ID |
| GET/PUT | `/api/settings` | App settings key/value store |
| GET | `/api/proxy?url=` | CORS proxy for M3U fetching |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3005` | HTTP port |
| `DATA_DIR` | `./data` | SQLite DB location |
| `DB_SYNC_INTERVAL` | `60000` | In-memory DB sync interval (ms) |
| `EPG_DIR` | `./data/epg` | EPG files directory |
| `CHANNELS_XML` | `$EPG_DIR/channels.xml` | Path to channels.xml |
| `GUIDE_XML_URL` | `http://127.0.0.1:3002/guide.xml` | EPG guide URL |
