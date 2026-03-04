# M3u4Prox

A full-stack IPTV playlist manager that makes IPTV easy. Supports many feeds and many outputs with a clean, responsive interface that works on desktop and mobile devices.

---

## Features

- **Sources** — save multiple M3U URLs and Xtream Codes connections with optional cron refresh schedules
- **Channel Browser** — browse source channels by group with virtual scrolling, card or table view, and select content for your playlists
- **Playlists** — create named playlists (e.g. "Live TV", "VOD"), set an output path and rebuild schedule with automatic generation
- **Composite Streams** — create multi-view streams with picture-in-picture layouts, multiple audio tracks, and real-time FFmpeg compositing for sports-style broadcasts
- **EPG Scraper** — If your IPTV provider has incomplete EPG data, then EPG Scraper is built right in to the application to scrape known sources for missing EPG data and map it to your channels
- **EPG Mappings** — override `tvg-id` values to fix EPG matching between channels and guide data
- **EPG Guide** — 24-hour TV guide with live playback support for mapped channels
- **HDHomeRun Integration** — built-in support for HDHomeRun tuners, perfect for Plex/Emby users wanting to integrate over-the-air channels
- **Xtream Codes API** — full Xtream Codes API support for IPTV apps like IPTV Smarters, TiviMate, and other popular IPTV players
- **EPG Enrichment** — automatically enrich EPG data with TMDB metadata for better guide information
- **Multi-Source Support** — combine multiple IPTV providers, local tuners, and custom sources into unified playlists
- **Mobile Responsive** — fully responsive design works on desktop, tablet, and mobile devices

---

## Getting Started Workflow

M3u4Prox follows a logical workflow to help you organize your IPTV content:

### 1. **Sources** (Start Here)
Add your IPTV sources - M3U URLs or Xtream Codes connections. This is where all your content comes from.

**What it does:**
- Fetches channel lists from your IPTV providers
- Supports automatic refresh schedules (cron)
- Manages multiple sources simultaneously
- Includes EPG Scraper tab for custom EPG data

**Tabs:**
- **Playlist Sources** - Add M3U/Xtream sources
- **EPG Scraper** - Select and scrape EPG data from iptv-org/epg repository

### 2. **Channel Browser**
Browse all channels from your sources and select which ones to include in your playlists.

**What it does:**
- View channels organized by group/category
- Search and filter channels
- Select channels for your playlists
- Switch between card and table views
- Create new playlists on the fly

**Workflow:**
- Browse channels by group
- Check boxes to select channels
- Create or switch playlists
- Selected channels are added to active playlist

### 3. **Playlists**
Manage your custom playlists and configure output settings.

**What it does:**
- View and edit playlist details
- Set playlist type (live, vod, or composite)
- Configure output path for M3U files
- Set automatic rebuild schedules
- Download M3U files
- View channel count and metadata

**Types:**
- **Live** - Live TV channels
- **VOD** - Video on demand content
- **Composite** - Channels for multi-view composite streaming

### 4. **EPG Mappings**
Fine-tune EPG data matching for accurate TV guide information.

**What it does:**
- Map channels to correct EPG IDs
- Override incorrect `tvg-id` values
- Bulk mapping tools
- Search EPG sources

**When to use:**
- Channel guide shows wrong programs
- EPG data not appearing for channels
- Multiple channels sharing same EPG ID

### 5. **Composite Streams**
Create multi-view streams with picture-in-picture layouts for sports-style broadcasts.

**What it does:**
- Combine multiple video sources into one stream
- Real-time FFmpeg compositing with HLS output
- Multiple audio tracks (switch in player)
- Built-in layout presets (Main+PiP, Quad Split, etc.)
- Visual editor with channel picker
- Uses channels from "Composite" playlists

**Workflow:**
1. Create a "Composite" playlist in Playlists page
2. Add channels to it via Channel Browser
3. Create composite stream and select channels from that playlist

**Use Cases:**
- Sports broadcasts with multiple camera angles
- Multi-game viewing (watch 4 games simultaneously)
- Main feed + stats/commentary feeds
- Racing with driver cams + main broadcast

**Layout Presets:**
- **Main + PiP Right** - Main feed with 2 PiPs on right
- **Quad Split** - 4 equal sources in 2x2 grid
- **Main + PiP Grid** - Main feed with 4 small PiPs
- **Side by Side** - 2 equal sources split vertically

**Performance:**
- Requires FFmpeg with libx264 and aac codecs
- 2-4 CPU cores per concurrent stream
- Recommended: tmpfs (RAM disk) for `/transcode` volume
- See `COMPOSITE_STREAMING_DEPLOYMENT.md` for setup

### 6. **EPG Guide**
View a 24-hour TV guide for your mapped channels with live playback.

**What it does:**
- Shows current and upcoming programs
- Displays program details (title, time, description)
- Live playback via built-in player
- Real-time NOW indicator
- Scrollable timeline view

**Features:**
- Click any program to view details
- Play button opens stream in new window
- Supports HLS and MPEG-TS streams
- Auto-updates every 30 seconds

### 7. **Active Streams**
Monitor currently active stream sessions.

**What it does:**
- View all active stream connections
- See client details and buffer status
- Kill stuck sessions
- Monitor bandwidth usage

### 8. **Users**
Manage user accounts and access control.

**What it does:**
- Create user accounts
- Set connection limits
- Configure expiration dates
- Track last connection times

### 9. **Settings**
Configure application settings and integrations.

**What it does:**
- HDHomeRun tuner configuration
- Xtream Codes API settings
- TMDB API key for EPG enrichment
- Backup and restore database
- VPN configuration

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
    - ./data:/data      # All application data (DB, output, EPG, configs, etc.)
    - type: tmpfs       # Transcode directory for composite streams (RAM disk recommended)
      target: /transcode
      tmpfs:
        size: 4G        # 1-2GB per concurrent composite stream
```

**Transcode Volume Options:**
- **tmpfs (RAM)** - Recommended for best performance and zero disk wear
- **SSD path** - Good alternative: `/mnt/cache/appdata/m3u4prox/transcode:/transcode`
- **Regular disk** - Fallback only: `./transcode:/transcode`

See `docker-compose.transcode-example.yml` and `TRANSCODE_VOLUME_SETUP.md` for detailed configuration.

---

## Built-in OpenVPN Support

M3u4Prox includes built-in OpenVPN support to bypass ISP restrictions on IPTV content. The application can route traffic through VPN tunnels to access geo-blocked IPTV sources and avoid ISP throttling.

### Supported VPN Providers

- **Custom** - Use your own OpenVPN configuration files
- **PIA** (Private Internet Access)
- **Surfshark**
- **IPVanish**
- **NordVPN**
- **VyprVPN**
- **ProtonVPN**

### VPN Configuration

The OpenVPN integration is built using [openvpn-buildtools](https://github.com/brycelarge/openvpn-buildtools) which provides automated setup and configuration management. VPN configurations are automatically downloaded and configured when you specify a provider.

### VPN Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VPN_ENABLED` | `false` | Enable/disable VPN routing |
| `OPENVPN_PROVIDER` | `CUSTOM` | VPN provider (see list above) |
| `OPENVPN_CONFIG` | - | Specific config file (optional) |
| `OPENVPN_USERNAME` | - | VPN username |
| `OPENVPN_PASSWORD` | - | VPN password |
| `LOCAL_NETWORK` | - | CIDRs to route outside VPN (optional) |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `./data` | Directory for all application data (DB, playlists, EPG) |
| `TRANSCODE_DIR` | `/transcode` | Directory for HLS segments (composite streams) - use tmpfs/SSD |
| `ADMIN_PASSWORD` | `admin` | Admin login password |
| `TMDB_API_KEY` | - | TMDB API key for EPG enrichment (optional) |
| `HOST_IP` | - | Host IP for HDHomeRun discovery (optional) |
