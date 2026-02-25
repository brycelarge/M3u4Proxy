# Channel Name Cleanup Rules

## Overview
Cleanup rules allow you to strip or replace text in channel names BEFORE normalization. This helps match variants with different naming conventions.

## Example Problem
- `Channel Name Full` → normalizes to `channelnamefull`
- `Channel Name Abbrev` → normalizes to `channelnameabbrev`

These are different normalized names, so they appear as separate channels in Plex.

## Solution
Add cleanup rules to normalize text variations before normalization runs.

## How to Use

### 1. Via API (Manual Testing)
```bash
# Get source details
curl http://localhost:3005/api/sources/1

# Update source with cleanup rules
curl -X PUT http://localhost:3005/api/sources/1 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Source",
    "type": "m3u",
    "url": "http://...",
    "cleanup_rules": [
      {
        "find": "Full",
        "replace": "Abbrev",
        "useRegex": false,
        "flags": "gi",
        "enabled": true
      },
      {
        "find": "\\s+",
        "replace": " ",
        "useRegex": true,
        "flags": "g",
        "enabled": true
      }
    ]
  }'
```

### 2. Rule Format
```json
{
  "find": "text or regex pattern",
  "replace": "replacement text",
  "useRegex": false,  // true = treat find as regex
  "flags": "gi",      // regex flags (g=global, i=case-insensitive)
  "enabled": true     // false = skip this rule
}
```

### 3. Common Rules

**Replace text variants:**
```json
{ "find": "Full", "replace": "Abbrev", "useRegex": false, "flags": "gi", "enabled": true }
```

**Remove extra spaces:**
```json
{ "find": "\\s+", "replace": " ", "useRegex": true, "flags": "g", "enabled": true }
```

**Strip prefix from channel names:**
```json
{ "find": "^(PREFIX|PFX):\\s*", "replace": "", "useRegex": true, "flags": "i", "enabled": true }
```

**Remove quality indicators:**
```json
{ "find": "\\b(HD|FHD|UHD|4K|SD)\\b", "replace": "", "useRegex": true, "flags": "gi", "enabled": true }
```

## Testing

1. Add cleanup rules to a source via API
2. Refresh the source: `POST /api/sources/:id/refresh`
3. Check normalized names in database:
```sql
SELECT tvg_name, normalized_name
FROM source_channels
WHERE tvg_name LIKE '%Premier League%'
LIMIT 10;
```

## UI
The cleanup rules UI is available in the Sources page:
1. Go to Sources → Edit any playlist source
2. Click "⚙️ Channel Name Cleanup Rules" button
3. Add/remove rules with live preview
4. Save the source and refresh it to apply rules

## Order of Operations
1. **Cleanup rules** applied to raw channel name
2. **Quality extraction** (HD, FHD, etc.)
3. **Normalization** (lowercase, remove special chars)
