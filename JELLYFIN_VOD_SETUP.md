# Jellyfin VOD Integration Guide

This guide explains how to integrate your IPTV VOD content with Jellyfin using STRM files and NFO metadata enrichment.

## Key Features

✅ **Automatic Playlist Organization** - Each VOD playlist gets its own folder
✅ **Separate Jellyfin Libraries** - Movies, TV Series, Kids content in separate libraries
✅ **Smart Metadata Sync** - Jellyfin scrapes TMDB, M3U4Proxy uses that data
✅ **Bi-directional Enrichment** - Xtream API and M3U playlists get full metadata
✅ **No Manual File Management** - Everything automated via API calls

## Overview

The integration works in two stages:
1. **STRM Export** - Export VOD playlists to `.strm` files (one folder per playlist)
2. **NFO Sync** - Import Jellyfin's metadata back to enrich Xtream API and M3U playlists

## Architecture

```
M3U4Proxy                                    Jellyfin
┌─────────────────────────┐                 ┌──────────────────────────┐
│ VOD Playlists           │                 │ Separate Libraries       │
│                         │                 │                          │
│ ┌─────────────────────┐ │                 │ ┌──────────────────────┐ │
│ │ Movies Playlist     │ │   STRM Export   │ │ Movies Library       │ │
│ │ ├─ Movie 1          │ │   ──────────>   │ │ ├─ Movie 1           │ │
│ │ ├─ Movie 2          │ │                 │ │ ├─ Movie 2           │ │
│ │ └─ Movie 3          │ │                 │ │ └─ Movie 3           │ │
│ └─────────────────────┘ │                 │ └──────────────────────┘ │
│                         │                 │           │              │
│ ┌─────────────────────┐ │   STRM Export   │           │ Scrapes TMDB │
│ │ Series Playlist     │ │   ──────────>   │           ▼              │
│ │ ├─ Show 1           │ │                 │ ┌──────────────────────┐ │
│ │ ├─ Show 2           │ │                 │ │ Series Library       │ │
│ │ └─ Show 3           │ │                 │ │ ├─ Show 1            │ │
│ └─────────────────────┘ │                 │ │ ├─ Show 2            │ │
└─────────────────────────┘                 │ │ └─ Show 3            │ │
         │                                  │ └──────────────────────┘ │
         │                                  └──────────────────────────┘
         │                                            │
         │                                            │ Creates .nfo files
         │                                            ▼
         │                                  ┌──────────────────────────┐
         │         NFO Sync                 │ Metadata Files           │
         └──────────  <──  ─────────────────┤ ├─ movie1.nfo            │
                                            │ ├─ movie2.nfo            │
                                            │ ├─ show1.nfo             │
                                            │ └─ show2.nfo             │
                                            └──────────────────────────┘

Result: Xtream API & M3U playlists enriched with TMDB metadata
```

## Docker Compose Setup

### Directory Structure

M3U4Proxy automatically creates a subdirectory for each VOD playlist:

```
/data/vod-strm/
  ├── movies/           ← Playlist named "Movies"
  │   ├── Movie 1.strm
  │   ├── Movie 1.m3u4prox.json
  │   └── Movie 1.nfo
  ├── tv-series/        ← Playlist named "TV Series"
  │   ├── Show 1.strm
  │   ├── Show 1.m3u4prox.json
  │   └── Show 1.nfo
  └── kids/             ← Playlist named "Kids"
      ├── Kids Movie.strm
      ├── Kids Movie.m3u4prox.json
      └── Kids Movie.nfo
```

### Shared Volume Configuration

Both containers need access to the base STRM directory:

```yaml
version: '3.8'

services:
  m3u4prox:
    image: your-registry/m3u4prox:latest
    container_name: m3u4prox
    volumes:
      - /mnt/cache/m3u4prox/data:/data
      - /mnt/cache/jellyfin-vod:/data/vod-strm  # Base STRM directory
    environment:
      - PORT=3005
      - STRM_EXPORT_DIR=/data/vod-strm
    ports:
      - "3005:3005"
    networks:
      - media

  jellyfin:
    image: jellyfin/jellyfin:latest
    container_name: jellyfin
    volumes:
      - /mnt/cache/jellyfin/config:/config
      - /mnt/cache/jellyfin/cache:/cache
      # Mount each playlist subdirectory as a separate library
      - /mnt/cache/jellyfin-vod/movies:/media/iptv-movies:ro
      - /mnt/cache/jellyfin-vod/tv-series:/media/iptv-series:ro
      - /mnt/cache/jellyfin-vod/kids:/media/iptv-kids:ro
    environment:
      - JELLYFIN_PublishedServerUrl=http://your-server:8096
    ports:
      - "8096:8096"
    networks:
      - media

networks:
  media:
    driver: bridge
```

**Important Notes:**
- **One folder per playlist:** M3U4Proxy creates subdirectories based on playlist names
- **Name sanitization:** Playlist names are converted to lowercase with hyphens
  - Playlist "Movies" → `/data/vod-strm/movies/`
  - Playlist "TV Series" → `/data/vod-strm/tv-series/`
  - Playlist "Kids Content" → `/data/vod-strm/kids-content/`
- **Separate libraries:** Each subdirectory becomes a separate Jellyfin library
- **Content types:** Use "Movies" content type for movies, "Shows" for TV series

## Quick Start

```bash
# 1. Export ALL VOD playlists (creates /data/vod-strm/{playlist-name}/ for each)
curl -X POST http://localhost:3005/api/strm/export-all

# 2. Add libraries in Jellyfin pointing to /media/iptv-{playlist-name}

# 3. Wait for Jellyfin to scan and create .nfo files

# 4. Sync NFO metadata back to M3U4Proxy
curl -X POST http://localhost:3005/api/nfo/sync
```

## Step-by-Step Setup

### 1. Export STRM Files from M3U4Proxy

#### Export All VOD Playlists (Recommended)
```bash
# Export ALL VOD playlists at once
curl -X POST http://localhost:3005/api/strm/export-all
```

This automatically:
- Finds all playlists with `playlist_type = 'vod'`
- Creates a folder for each: `/data/vod-strm/{playlist-name}/`
- Exports all VOD items to `.strm` files
- Creates `.m3u4prox.json` metadata files

**Example Response:**
```json
{
  "success": true,
  "playlists": [
    {
      "playlistId": 5,
      "playlistName": "Movies",
      "success": true,
      "stats": { "created": 1250, "updated": 0, "deleted": 0 },
      "directory": "/data/vod-strm/movies"
    },
    {
      "playlistId": 6,
      "playlistName": "TV Series",
      "success": true,
      "stats": { "created": 850, "updated": 0, "deleted": 0 },
      "directory": "/data/vod-strm/tv-series"
    }
  ],
  "summary": {
    "totalPlaylists": 2,
    "successful": 2,
    "totalCreated": 2100
  }
}
```

#### Export Single Playlist (Optional)
```bash
# Export specific playlist by ID
curl -X POST http://localhost:3005/api/strm/export/5
```

#### Scheduled Export (Settings)
Add to database:
```sql
INSERT INTO settings (key, value) VALUES ('strm_export_schedule', '0 3 * * *');
```
This exports all VOD playlists daily at 3 AM.

#### What Gets Created
For each VOD item, three files are created in the playlist-specific subdirectory:
```
/data/vod-strm/movies/
  A Firefighter's Christmas Calendar (2025).strm
  A Firefighter's Christmas Calendar (2025).m3u4prox.json
  # .nfo file will be created by Jellyfin later
```

**File Contents:**

`.strm` file:
```
http://m3u4prox:3005/movie/username/password/963850
```

`.m3u4prox.json` file:
```json
{
  "channelId": "963850",
  "playlistId": "5",
  "tvgName": "A Firefighter's Christmas Calendar (2025)",
  "upstreamUrl": "http://provider.com/vod/...",
  "proxyUrl": "http://m3u4prox:3005/movie/username/password/963850",
  "lastUpdated": "2026-02-26T14:00:00Z"
}
```

### 2. Configure Jellyfin Libraries

You need to create a **separate library for each VOD playlist**. The folder path depends on your playlist name.

#### Example: Movies Playlist

If your playlist is named "Movies" (ID 5):

1. **Jellyfin Dashboard** → **Libraries** → **Add Media Library**
2. **Content type:** Movies
3. **Display name:** IPTV Movies
4. **Folders:** Add `/media/iptv-movies` (maps to `/data/vod-strm/movies/` in M3U4Proxy)
5. **Library settings:**
   - ✅ Enable "Automatically refresh metadata from the internet"
   - ✅ Enable "Save artwork into media folders"
   - ✅ Enable "Nfo" metadata saver
   - ❌ Disable "Enable automatic organization" (important!)

#### Example: TV Series Playlist

If your playlist is named "TV Series" (ID 6):

1. **Content type:** Shows (not Movies!)
2. **Display name:** IPTV Series
3. **Folders:** Add `/media/iptv-series` (maps to `/data/vod-strm/tv-series/`)
4. Same library settings as above

#### Metadata Settings (for all libraries)
1. **Metadata downloaders:** Enable TMDB
2. **Metadata savers:** Enable "Nfo"
3. **Image fetchers:** Enable TMDB

**Tip:** Create all your Jellyfin libraries first, then export all playlists at once.

### 3. Jellyfin Scans and Creates NFO Files

After adding the library, Jellyfin will:
1. Scan the directory and find `.strm` files
2. Extract movie titles from filenames
3. Search TMDB for metadata
4. Download posters and fanart
5. **Create `.nfo` files** with all metadata

Example `.nfo` file created by Jellyfin:
```xml
<?xml version="1.0" encoding="utf-8"?>
<movie>
  <title>A Firefighter's Christmas Calendar</title>
  <originaltitle>A Firefighter's Christmas Calendar</originaltitle>
  <plot>A firefighter discovers a magical advent calendar...</plot>
  <rating>7.2</rating>
  <year>2025</year>
  <releasedate>2025-11-15</releasedate>
  <runtime>95</runtime>
  <genre>Romance</genre>
  <genre>Holiday</genre>
  <director>
    <name>John Director</name>
  </director>
  <actor>
    <name>Jane Actor</name>
    <role>Lead Role</role>
  </actor>
  <tmdbid>12345</tmdbid>
  <imdbid>tt1234567</imdbid>
  <thumb>https://image.tmdb.org/t/p/original/poster.jpg</thumb>
  <fanart>https://image.tmdb.org/t/p/original/fanart.jpg</fanart>
</movie>
```

### 4. Sync NFO Metadata Back to M3U4Proxy

Once Jellyfin has created the `.nfo` files, import them:

```bash
# Sync NFO files to database
curl -X POST http://localhost:3005/api/nfo/sync
```

This will:
- Read all `.nfo` files in `/data/vod-strm`
- Parse metadata (title, plot, rating, cast, etc.)
- Store in `vod_metadata` database table
- Link to channels via `.m3u4prox.json` files

#### Scheduled NFO Sync
Add to database for automatic daily sync:
```sql
INSERT INTO settings (key, value) VALUES ('nfo_sync_schedule', '0 4 * * *');
```

### 5. Enriched Metadata Now Available

After NFO sync, your Xtream API and M3U playlists will include:

#### Xtream API (`get_vod_info`)
```json
{
  "info": {
    "tmdb_id": "12345",
    "name": "A Firefighter's Christmas Calendar",
    "plot": "A firefighter discovers a magical advent calendar...",
    "rating": "7.2",
    "rating_5based": "3.6",
    "releasedate": "2025-11-15",
    "genre": "Romance, Holiday",
    "cast": "Jane Actor, John Smith",
    "director": "John Director",
    "cover_big": "http://m3u4prox:3005/api/proxy-image?url=...",
    "movie_image": "http://m3u4prox:3005/api/proxy-image?url=..."
  }
}
```

#### M3U Playlists
```
#EXTINF:-1 tvg-name="A Firefighter's Christmas Calendar" tvg-logo="http://m3u4prox:3005/api/proxy-image?url=..." group-title="Romance",A Firefighter's Christmas Calendar
http://m3u4prox:3005/stream/963850
```

## Workflow Summary

### Initial Setup
1. Export STRM files → Jellyfin scans → NFO files created → Sync NFO back

### Ongoing Updates
1. **New VOD items added to playlist:**
   - STRM export runs (scheduled or manual)
   - New `.strm` files created
   - Jellyfin auto-scans and creates `.nfo` files
   - NFO sync runs (scheduled or manual)
   - Metadata enriched

2. **VOD items removed from playlist:**
   - STRM export runs
   - Old `.strm` files deleted
   - Jellyfin removes from library
   - NFO sync cleans up database

## Troubleshooting

### Finding Playlist Folder Names
If you're unsure what folder was created for your playlist:

```bash
# List all playlist folders
ls -la /data/vod-strm/

# Or check the export response
curl -X POST http://localhost:3005/api/strm/export/5
# Response includes: "directory": "/data/vod-strm/movies"
```

### STRM Files Not Playing in Jellyfin
- **Check network:** Jellyfin container must reach `m3u4prox:3005`
- **Check URL:** Open `.strm` file and verify URL is correct
- **Test directly:** `curl http://m3u4prox:3005/movie/user/pass/123`
- **Check folder mapping:** Ensure Jellyfin volume mount matches playlist folder name

### NFO Files Not Created
- **Enable NFO saver:** Library Settings → Metadata Savers → Enable "Nfo"
- **Enable artwork saving:** Library Settings → Enable "Save artwork into media folders"
- **Trigger scan:** Library → Scan Library
- **Check permissions:** Ensure Jellyfin can write to the mounted directory

### Metadata Not Enriching
- **Check NFO sync:** `curl -X POST http://localhost:3005/api/nfo/sync`
- **Check database:** `SELECT * FROM vod_metadata LIMIT 5`
- **Check logs:** Look for `[nfo]` and `[strm]` messages
- **Verify folder structure:** NFO sync scans all subdirectories under `/data/vod-strm/`

### Images Not Loading
- **Image proxy:** Images are proxied through `/api/proxy-image?url=...`
- **Check TMDB access:** M3U4Proxy must reach `image.tmdb.org`
- **Check logs:** Look for `[proxy-image]` errors

### Wrong Content Type in Jellyfin
- **Movies vs Shows:** Use "Movies" for films, "Shows" for TV series
- **Metadata mismatch:** If Jellyfin can't find metadata, check the content type matches the actual content

## Advanced Configuration

### Custom STRM Export Directory
```bash
# Set custom directory per playlist
curl -X POST http://localhost:3005/api/strm/export/5 \
  -H "Content-Type: application/json" \
  -d '{"exportDir": "/data/vod-strm/movies"}'
```

### Disable Auto-Organization in Jellyfin
**Important:** Jellyfin's auto-organization will rename files and break the link to `.m3u4prox.json`.

To prevent this:
1. Library Settings → Advanced
2. ❌ Disable "Enable automatic organization"
3. ❌ Disable "Automatically add to collection"

### Re-export After Playlist Changes
If you modify channel names or URLs in M3U4Proxy:
```bash
# Re-export STRM files (updates URLs in .strm files)
curl -X POST http://localhost:3005/api/strm/export/5

# Jellyfin will detect changes and re-scan
# Then re-sync NFO data
curl -X POST http://localhost:3005/api/nfo/sync
```

## Benefits

✅ **Proper Jellyfin library** - Movies appear with posters, metadata, organization
✅ **Enriched Xtream API** - IPTV clients get real metadata instead of empty fields
✅ **Enhanced M3U playlists** - Proper titles, genres, and poster URLs
✅ **Automatic updates** - Scheduled exports and syncs keep everything current
✅ **Shared metadata** - One source of truth (Jellyfin) enriches all outputs
✅ **No duplicate downloads** - STRM files stream on-demand, no local storage needed

## Example: Complete Setup Script

```bash
#!/bin/bash

# 1. Export ALL VOD playlists to STRM files
echo "Exporting all VOD playlists..."
curl -X POST http://localhost:3005/api/strm/export-all

# 2. Wait for Jellyfin to scan (or trigger manually)
echo "Waiting 60s for Jellyfin to scan..."
sleep 60

# 3. Sync NFO metadata back
echo "Syncing NFO metadata..."
curl -X POST http://localhost:3005/api/nfo/sync

echo "Setup complete!"
echo "Check folders: ls -la /data/vod-strm/"
```

## Support

For issues or questions:
- Check logs: `docker logs m3u4prox`
- Check Jellyfin logs: `docker logs jellyfin`
- Verify file permissions: `ls -la /mnt/cache/jellyfin-vod/`
