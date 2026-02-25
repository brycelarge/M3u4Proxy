import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api } from './useApi.js'
import { destroyWorker } from './useM3U.js'

// ── Persistence helpers ───────────────────────────────────────────────────────
function loadSavedSelection() {
  try {
    const raw = localStorage.getItem('m3u_selection')
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    const result = {}
    for (const [k, v] of Object.entries(parsed)) {
      result[k] = v === '__all__' ? '__all__' : new Set(v)
    }
    return result
  } catch { return {} }
}

function loadSavedGroupOverrides() {
  try {
    const raw = localStorage.getItem('m3u_group_overrides')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function loadSavedChannelNumbers() {
  try {
    const raw = localStorage.getItem('m3u_channel_numbers')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function loadSavedEpgOverrides() {
  try {
    const raw = localStorage.getItem('m3u_epg_overrides')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function loadSavedEpgSourceOverrides() {
  try {
    const raw = localStorage.getItem('m3u_epg_source_overrides')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function loadSavedNameOverrides() {
  try {
    const raw = localStorage.getItem('m3u_name_overrides')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

// ── Group classification ──────────────────────────────────────────────────────
export function classifyGroup(name) {
  const n = name.toLowerCase()
  if (/series|show|episode|season|tvshow/.test(n)) return 'Series'
  if (/vod|movie|film|cinema/.test(n)) return 'Movies VOD'
  return 'Live TV'
}

export function useBrowser() {
  // ── State ───────────────────────────────────────────────────────────────────
  const loading      = ref(false)
  const error        = ref('')
  // Active source from DB
  const activeSourceId   = ref(localStorage.getItem('m3u_source_id') ? Number(localStorage.getItem('m3u_source_id')) : null)
  const activeSourceName = ref(localStorage.getItem('m3u_source_name') || '')
  const lastFetched      = ref(localStorage.getItem('m3u_last_fetched') || '')
  // Active playlist
  const activePlaylistId   = ref(localStorage.getItem('m3u_playlist_id') ? Number(localStorage.getItem('m3u_playlist_id')) : null)
  const activePlaylistName = ref(localStorage.getItem('m3u_playlist_name') || '')
  const saving             = ref(false)
  const building           = ref(false)
  const saveError          = ref('')
  const loadingSelection   = ref(false)

  const groups       = ref([])
  const channels     = ref([])
  const groupTotal   = ref(0)   // total channels in active group (may exceed loaded page)
  const selectionMap = ref(loadSavedSelection())
  const search       = ref('')
  const groupSearch  = ref('')
  const activeGroup  = ref(null)
  const loadingGroup = ref(false)
  const copied       = ref(false)
  const urlCopied    = ref(false)
  const viewMode     = ref('grid')
  const exporting       = ref(false)
  const gridCols        = ref(6)
  const groupOverrides      = ref(loadSavedGroupOverrides())       // { channelId: 'KIDS' }
  const channelNumbers      = ref(loadSavedChannelNumbers())        // { channelId: 101 }
  const epgOverrides        = ref(loadSavedEpgOverrides())          // { channelId: 'tvg.id.here' }
  const epgSourceOverrides  = ref(loadSavedEpgSourceOverrides())    // { channelId: sourceId }
  const nameOverrides        = ref(loadSavedNameOverrides())          // { channelId: 'Custom Name' }
  const playlistTotalCount   = ref(0)                                 // Total channels in loaded playlist

  // ── Derived ─────────────────────────────────────────────────────────────────
  const currentSelected = computed(() => {
    // Build a Set of all selected channel IDs across all groups
    const allSelected = new Set()

    for (const [groupName, selection] of Object.entries(selectionMap.value)) {
      if (selection === '__all__') {
        // For '__all__' groups, add all channels from that group
        // Note: This only works for the currently loaded channels
        channels.value
          .filter(c => (c.group_title || activeGroup.value) === groupName)
          .forEach(c => allSelected.add(c.id))
      } else if (selection instanceof Set) {
        // Add all IDs from this group's selection Set
        selection.forEach(id => allSelected.add(id))
      }
    }

    return allSelected
  })

  const selectedCount = computed(() => {
    // If a playlist is loaded, use the totalCount from the API
    if (activePlaylistId.value && playlistTotalCount.value > 0) {
      return playlistTotalCount.value
    }

    // Otherwise calculate from selectionMap (for source browsing mode)
    // Use currentSelected.value which already aggregates all selections
    return currentSelected.value.size
  })

  const totalCount = computed(() =>
    groups.value.reduce((sum, g) => sum + g.count, 0)
  )

  const selectionCounts = computed(() => {
    const result = {}
    for (const g of groups.value) {
      const sel = selectionMap.value[g.name]
      if (!sel) { result[g.name] = 0; continue }
      if (sel === '__all__') { result[g.name] = g.count; continue }
      result[g.name] = sel instanceof Set ? sel.size : 0
    }
    return result
  })

  const groupState = computed(() => {
    const result = {}
    for (const g of groups.value) {
      const sel = selectionMap.value[g.name]
      if (sel === '__all__') result[g.name] = 'all'
      else if (!sel || !(sel instanceof Set) || sel.size === 0) result[g.name] = 'none'
      else if (sel.size >= g.count) result[g.name] = 'all'
      else result[g.name] = 'partial'
    }
    return result
  })

  const filtered = computed(() => {
    if (!search.value.trim()) return channels.value
    const q = search.value.toLowerCase()
    return channels.value.filter(c => c.name.toLowerCase().includes(q))
  })

  const sectionedGroups = computed(() => {
    const base = groupSearch.value.trim()
      ? groups.value.filter(g => g.name.toLowerCase().includes(groupSearch.value.toLowerCase()))
      : groups.value
    if (groupSearch.value.trim()) return [{ section: null, groups: base }]
    const sections = { 'Live TV': [], 'Series': [], 'Movies VOD': [] }
    for (const g of base) sections[classifyGroup(g.name)].push(g)
    return Object.entries(sections)
      .filter(([, gs]) => gs.length > 0)
      .map(([section, gs]) => ({ section, groups: gs }))
  })

  const filteredRows = computed(() => {
    const cols = gridCols.value
    const rows = []
    for (let i = 0; i < filtered.value.length; i += cols) {
      rows.push({ rowId: i, items: filtered.value.slice(i, i + cols) })
    }
    return rows
  })

  // ── Grid cols ────────────────────────────────────────────────────────────────
  function updateGridCols() {
    const available = window.innerWidth - 288 - 32
    gridCols.value = Math.max(2, Math.floor(available / 142))
  }

  // ── Loaders ───────────────────────────────────────────────────────────────────
  function setGroups(groupList, sourceMeta = {}) {
    groups.value      = groupList
    channels.value    = []
    activeGroup.value = null
    search.value      = ''
    if (sourceMeta.last_fetched) {
      lastFetched.value = sourceMeta.last_fetched
      localStorage.setItem('m3u_last_fetched', sourceMeta.last_fetched)
    }
  }

  // Load a playlist's saved channels as the active selection
  async function loadPlaylistSelection(playlistId, playlistName) {
    activePlaylistId.value   = playlistId
    activePlaylistName.value = playlistName
    localStorage.setItem('m3u_playlist_id',   String(playlistId))
    localStorage.setItem('m3u_playlist_name', playlistName)
    saveError.value      = ''
    loadingSelection.value = true

    // Clear immediately so UI reflects the new playlist right away
    selectionMap.value   = {}
    channelNumbers.value = {}
    epgOverrides.value   = {}
    groupOverrides.value = {}
    activeGroup.value    = null
    channels.value       = []
    groupTotal.value     = 0
    localStorage.setItem('m3u_selection', '{}')

    try {
      // Server joins playlist_channels with source_channels by URL — returns selection map directly
      const { groups, overrides, totalCount } = await api.getPlaylistSelection(playlistId)

      // Store the total count from the API
      playlistTotalCount.value = totalCount || 0

      // Convert group arrays to Sets (__all__ stays as string)
      const newMap = {}
      for (const [grp, ids] of Object.entries(groups)) {
        newMap[grp] = ids === '__all__' ? '__all__' : new Set(ids)
      }

      const newNums   = {}
      const newEpg    = {}
      const newGroups = {}
      const newNames  = {}
      for (const [id, ov] of Object.entries(overrides)) {
        if (ov.sort_order    != null) newNums[id]   = ov.sort_order
        if (ov.custom_tvg_id)         newEpg[id]    = ov.custom_tvg_id
        if (ov.group_title)           newGroups[id] = ov.group_title
        if (ov.tvg_name)              newNames[id]  = ov.tvg_name
      }

      selectionMap.value   = newMap
      channelNumbers.value = newNums
      epgOverrides.value   = newEpg
      groupOverrides.value = newGroups
      nameOverrides.value  = newNames

      const s = {}
      for (const [k, v] of Object.entries(newMap)) s[k] = v === '__all__' ? '__all__' : [...v]
      localStorage.setItem('m3u_selection',        JSON.stringify(s))
      localStorage.setItem('m3u_channel_numbers',  JSON.stringify(newNums))
      localStorage.setItem('m3u_epg_overrides',    JSON.stringify(newEpg))
      localStorage.setItem('m3u_group_overrides',  JSON.stringify(newGroups))
      localStorage.setItem('m3u_name_overrides',   JSON.stringify(newNames))

      // Load source groups so selectedCount can calculate correctly
      // Use "All Sources" mode to get all groups across sources
      activeSourceId.value = null
      activeSourceName.value = '__all__'
      const data = await api.getAllSourceGroups(playlistId)
      if (data.groups && data.groups.length > 0) {
        setGroups(data.groups, { last_fetched: data.last_fetched })

        // Auto-select the first group that has channels in the playlist
        const firstGroupWithChannels = Object.keys(newMap).find(groupName =>
          data.groups.some(g => g.name === groupName)
        )
        if (firstGroupWithChannels) {
          await selectGroup(firstGroupWithChannels)
        }
      }
    } catch (e) {
      saveError.value = e.message
    } finally {
      loadingSelection.value = false
    }
  }

  // Save current selection to the active playlist in DB.
  // Sends group selections + per-channel overrides to the server, which resolves
  // channels directly from source_channels — no large payload needed.
  async function saveToPlaylist() {
    if (!activePlaylistId.value) return
    saving.value    = true
    saveError.value = ''
    try {
      // Build groups map: groupName -> '__all__' | number[]
      const groupsPayload = {}
      for (const [groupName, sel] of Object.entries(selectionMap.value)) {
        if (!sel || (sel instanceof Set && sel.size === 0)) continue
        groupsPayload[groupName] = sel === '__all__' ? '__all__' : [...sel]
      }

      // Build overrides map: only for channels that have any override set
      const overrides = {}
      const allOverriddenIds = new Set([
        ...Object.keys(channelNumbers.value),
        ...Object.keys(epgOverrides.value),
        ...Object.keys(groupOverrides.value),
        ...Object.keys(epgSourceOverrides.value),
        ...Object.keys(nameOverrides.value),
      ])
      for (const id of allOverriddenIds) {
        const ov = {}
        if (channelNumbers.value[id]     != null) ov.sort_order    = channelNumbers.value[id]
        if (epgOverrides.value[id])                ov.custom_tvg_id = epgOverrides.value[id]
        if (groupOverrides.value[id])              ov.group_title   = groupOverrides.value[id]
        if (epgSourceOverrides.value[id]  != null) ov.epg_source_id = epgSourceOverrides.value[id]
        if (nameOverrides.value[id])               ov.tvg_name      = nameOverrides.value[id]
        if (Object.keys(ov).length) overrides[id] = ov
      }

      await api.savePlaylistByGroups(activePlaylistId.value, {
        sourceId: activeSourceId.value,
        groups:   groupsPayload,
        overrides,
      })
    } catch (e) {
      saveError.value = e.message
    } finally {
      saving.value = false
    }
  }

  // Trigger a build of the active playlist
  async function buildPlaylist() {
    if (!activePlaylistId.value) return
    building.value  = true
    saveError.value = ''
    try {
      await saveToPlaylist()
      await api.buildPlaylist(activePlaylistId.value)
    } catch (e) {
      saveError.value = e.message
    } finally {
      building.value = false
    }
  }

  // Load groups from DB cache — sourceId=null means all sources
  async function loadSourceFromCache(sourceId, sourceName) {
    loading.value = true
    error.value   = ''
    try {
      const data = sourceId === null
        ? await api.getAllSourceGroups(activePlaylistId.value)
        : await api.getSourceGroups(sourceId)
      if (!data.cached || data.groups.length === 0) {
        error.value = sourceId === null
          ? 'No sources have cached data yet. Go to Sources and click Refresh on each source.'
          : `Source "${sourceName}" has no cached data. Go to Sources and click Refresh.`
        return
      }
      activeSourceId.value   = sourceId
      activeSourceName.value = sourceName
      if (sourceId === null) {
        localStorage.removeItem('m3u_source_id')
      } else {
        localStorage.setItem('m3u_source_id', String(sourceId))
      }
      localStorage.setItem('m3u_source_name', sourceName)
      setGroups(data.groups, { last_fetched: data.last_fetched })
    } catch (e) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  const PAGE_SIZE = 500

  async function selectGroup(groupName) {
    if (activeGroup.value === groupName) return
    activeGroup.value = groupName
    search.value = ''
    channels.value = []
    groupTotal.value = 0
    loadingGroup.value = true
    try {
      let res

      // Special case for "My Selection" - show all channels in the playlist
      if (groupName === '__selected__') {
        if (activePlaylistId.value) {
          // Get all channels in the playlist
          res = await api.getPlaylistChannels(activePlaylistId.value, PAGE_SIZE, 0)
        } else {
          // If no playlist is selected, show all selected channels across all groups
          const allSelected = []
          for (const [group, selection] of Object.entries(selectionMap.value)) {
            if (selection === '__all__') {
              // For groups with all channels selected, fetch those channels
              const groupChannels = await api.getAllSourceChannels(group, PAGE_SIZE, 0)
              if (groupChannels && groupChannels.channels) {
                allSelected.push(...groupChannels.channels)
              }
            } else if (selection instanceof Set && selection.size > 0) {
              // For groups with specific channels selected
              const groupChannels = await api.getAllSourceChannels(group, PAGE_SIZE, 0)
              if (groupChannels && groupChannels.channels) {
                allSelected.push(...groupChannels.channels.filter(ch => selection.has(ch.id)))
              }
            }
          }
          res = { channels: allSelected, total: allSelected.length }
        }
      } else if (activeSourceId.value === null) {
        res = await api.getAllSourceChannels(groupName, PAGE_SIZE, 0)
      } else if (activeSourceId.value) {
        res = await api.getSourceChannels(activeSourceId.value, groupName, PAGE_SIZE, 0)
      }

      if (res) {
        channels.value = res.channels ?? res
        groupTotal.value = res.total ?? channels.value.length
      }
      if (!(groupName in selectionMap.value)) {
        selectionMap.value = { ...selectionMap.value, [groupName]: new Set() }
      }
    } finally {
      loadingGroup.value = false
    }
  }

  async function loadMoreChannels() {
    if (channels.value.length >= groupTotal.value) return
    loadingGroup.value = true
    try {
      const offset = channels.value.length
      let res

      // Special case for "My Selection" - load more channels from the playlist
      if (activeGroup.value === '__selected__') {
        if (activePlaylistId.value) {
          // Get more channels from the playlist
          res = await api.getPlaylistChannels(activePlaylistId.value, PAGE_SIZE, offset)
        }
        // Note: For the case where no playlist is selected, we've already loaded all channels
        // in the selectGroup function, so there's no need to load more
      } else if (activeSourceId.value === null) {
        res = await api.getAllSourceChannels(activeGroup.value, PAGE_SIZE, offset)
      } else if (activeSourceId.value) {
        res = await api.getSourceChannels(activeSourceId.value, activeGroup.value, PAGE_SIZE, offset)
      }

      if (res) channels.value = [...channels.value, ...(res.channels ?? res)]
    } finally {
      loadingGroup.value = false
    }
  }

  // ── Selection ────────────────────────────────────────────────────────────────
  function toggleChannel(ch) {
    // Use the channel's group_title if available, otherwise use activeGroup
    const g = ch.group_title || activeGroup.value
    if (!g) {
      console.error('[browser] toggleChannel: no group found', {
        channel: ch,
        activeGroup: activeGroup.value,
        hasGroupTitle: !!ch.group_title
      })
      return
    }

    console.log('[browser] toggleChannel:', {
      channelId: ch.id,
      channelName: ch.name,
      group: g,
      currentlySelected: currentSelected.value.has(ch.id)
    })

    const currentMap = selectionMap.value
    const s = new Set(currentMap[g] instanceof Set ? currentMap[g] : [])

    if (s.has(ch.id)) {
      s.delete(ch.id)
    } else {
      s.add(ch.id)
    }

    // Create completely new object to ensure Vue reactivity
    const newMap = {}
    for (const key in currentMap) {
      newMap[key] = currentMap[key]
    }
    newMap[g] = s
    selectionMap.value = newMap

    console.log('[browser] After toggle:', {
      group: g,
      selectionSize: s.size,
      isSelected: s.has(ch.id),
      activeGroup: activeGroup.value,
      groupMatchesActive: g === activeGroup.value
    })
  }

  function selectAll() {
    const g = activeGroup.value
    selectionMap.value = { ...selectionMap.value, [g]: new Set(filtered.value.map(c => c.id)) }
  }

  function selectNone() {
    const g = activeGroup.value
    selectionMap.value = { ...selectionMap.value, [g]: new Set() }
  }

  function toggleGroup(groupName) {
    const state = groupState.value[groupName]
    if (state === 'all') {
      selectionMap.value = { ...selectionMap.value, [groupName]: new Set() }
    } else if (groupName === activeGroup.value && channels.value.length) {
      selectionMap.value = { ...selectionMap.value, [groupName]: new Set(channels.value.map(c => c.id)) }
    } else {
      selectionMap.value = { ...selectionMap.value, [groupName]: '__all__' }
    }
  }

  function toggleSection(groupNames) {
    const allFullySelected = groupNames.every(g => {
      const state = selectionMap.value[g]
      return state === '__all__'
    })

    const next = { ...selectionMap.value }

    if (allFullySelected) {
      for (const g of groupNames) {
        next[g] = new Set()
      }
    } else {
      for (const g of groupNames) {
        next[g] = '__all__'
      }
    }

    selectionMap.value = next
  }

  // ── Channel numbers ───────────────────────────────────────────────────────────
  function setChannelNumbers(updates) {
    // updates: { channelId: number | null }
    const next = { ...channelNumbers.value }
    for (const [id, num] of Object.entries(updates)) {
      if (num === null || num === undefined) delete next[id]
      else next[id] = num
    }
    channelNumbers.value = next
    localStorage.setItem('m3u_channel_numbers', JSON.stringify(next))
  }

  // ── Group overrides ───────────────────────────────────────────────────────────
  function setGroupOverride(channelIds, groupName) {
    const next = { ...groupOverrides.value }
    for (const id of channelIds) {
      if (groupName === '') delete next[id]
      else next[id] = groupName
    }
    groupOverrides.value = next
    localStorage.setItem('m3u_group_overrides', JSON.stringify(next))
  }

  // ── EPG overrides ────────────────────────────────────────────────────────────────
  function setEpgOverride({ id, tvg_id }) {
    const next = { ...epgOverrides.value }
    if (!tvg_id) delete next[id]
    else next[id] = tvg_id
    epgOverrides.value = next
    localStorage.setItem('m3u_epg_overrides', JSON.stringify(next))
  }

  function setEpgSourceOverride({ id, source_id }) {
    const next = { ...epgSourceOverrides.value }
    if (!source_id) delete next[id]
    else next[id] = source_id
    epgSourceOverrides.value = next
    localStorage.setItem('m3u_epg_source_overrides', JSON.stringify(next))
  }

  function setNameOverride({ id, name }) {
    const next = { ...nameOverrides.value }
    if (!name) delete next[id]
    else next[id] = name
    nameOverrides.value = next
    localStorage.setItem('m3u_name_overrides', JSON.stringify(next))
  }

  // Returns flat array of all selected channel objects across all groups
  async function getAllSelectedChannels() {
    const result = []
    const seenNormalized = new Map() // Track variants by normalized_name

    for (const g of groups.value) {
      const sel = selectionMap.value[g.name]
      if (!sel || (sel instanceof Set && sel.size === 0)) continue

      let groupChannels = []
      if (activeGroup.value === g.name && channels.value.length > 0) {
        // If we already have the channels loaded for this group, use them
        groupChannels = channels.value
      } else {
        // Fetch all channels for this group
        if (activeSourceId.value === null) {
          groupChannels = await api.getAllSourceChannelsAll(g.name)
        } else {
          groupChannels = await api.getSourceChannelsAll(activeSourceId.value, g.name)
        }
      }

      const ids = sel === '__all__' ? new Set(groupChannels.map(c => c.id)) : sel
      for (const ch of groupChannels) {
        if (!ids.has(ch.id)) continue

        const normalized = ch.normalized_name
        if (normalized) {
          // Track variants by normalized_name
          if (!seenNormalized.has(normalized)) {
            seenNormalized.set(normalized, {
              ...ch,
              originalGroup: g.name,
              variantIds: [ch.id], // Track all variant IDs
              variantCount: 1
            })
          } else {
            // Add this variant's ID to the list
            const existing = seenNormalized.get(normalized)
            existing.variantIds.push(ch.id)
            existing.variantCount++
          }
        } else {
          // No normalized_name - add as-is
          result.push({ ...ch, originalGroup: g.name, variantIds: [ch.id], variantCount: 1 })
        }
      }
    }

    // Add deduplicated channels to result
    result.push(...seenNormalized.values())
    return result
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function applyOverrides(raw, channelId) {
    let line = raw
    const grp = groupOverrides.value[channelId]
    if (grp) line = line.replace(/group-title="[^"]*"/, `group-title="${grp}"`)
    const num = channelNumbers.value[channelId]
    if (num != null) {
      if (/tvg-chno="[^"]*"/.test(line)) {
        line = line.replace(/tvg-chno="[^"]*"/, `tvg-chno="${num}"`)
      } else {
        line = line.replace(/(#EXTINF:[^,]*)/, `$1 tvg-chno="${num}"`)
      }
    }
    const epgId = epgOverrides.value[channelId]
    if (epgId) line = line.replace(/tvg-id="[^"]*"/, `tvg-id="${epgId}"`)
    return line
  }

  async function buildFullM3U() {
    const lines = ['#EXTM3U']
    for (const g of groups.value) {
      const sel = selectionMap.value[g.name]
      if (!sel || (sel instanceof Set && sel.size === 0)) continue
      let groupChannels
      if (activeGroup.value === g.name) {
        groupChannels = channels.value
      } else if (activeSourceId.value === null) {
        groupChannels = await api.getAllSourceChannels(g.name)
      } else if (activeSourceId.value) {
        groupChannels = await api.getSourceChannels(activeSourceId.value, g.name)
      } else {
        continue
      }
      const ids = sel === '__all__' ? new Set(groupChannels.map(c => c.id)) : sel
      for (const ch of groupChannels) {
        if (ids.has(ch.id)) {
          lines.push(applyOverrides(ch.raw, ch.id))
          lines.push(ch.url)
        }
      }
    }
    return lines.join('\n')
  }

  async function exportM3U() {
    exporting.value = true
    try {
      const content = await buildFullM3U()
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([content], { type: 'application/x-mpegurl' })),
        download: 'playlist.m3u',
      })
      a.click()
      URL.revokeObjectURL(a.href)
    } finally {
      exporting.value = false
    }
  }

  async function copyM3U() {
    exporting.value = true
    try {
      await navigator.clipboard.writeText(await buildFullM3U())
      copied.value = true
      setTimeout(() => (copied.value = false), 2000)
    } finally {
      exporting.value = false
    }
  }

  function onImgError(e) { e.target.style.display = 'none' }

  // ── Watchers ─────────────────────────────────────────────────────────────────
  watch(selectionMap, (map) => {
    const s = {}
    for (const [k, v] of Object.entries(map)) s[k] = v instanceof Set ? [...v] : v
    localStorage.setItem('m3u_selection', JSON.stringify(s))
  }, { deep: true })

  watch(channels, (list) => {
    const g = activeGroup.value
    if (!g) return
    if (selectionMap.value[g] === '__all__') {
      selectionMap.value = { ...selectionMap.value, [g]: new Set(list.map(c => c.id)) }
    }
  })

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onMounted(async () => {
    updateGridCols()
    window.addEventListener('resize', updateGridCols)
    await loadSourceFromCache(null, '__all__')
    // Auto-restore persisted playlist selection after source groups are loaded
    const pid  = localStorage.getItem('m3u_playlist_id')
    const pname = localStorage.getItem('m3u_playlist_name')
    if (pid && pname) {
      await loadPlaylistSelection(Number(pid), pname)
    }
  })

  onUnmounted(() => {
    window.removeEventListener('resize', updateGridCols)
    destroyWorker()
  })

  return {
    // state
    loading, error, groups, channels, selectionMap,
    search, groupSearch, activeGroup, loadingGroup, copied, urlCopied,
    viewMode, exporting, gridCols,
    // computed
    currentSelected, selectedCount, totalCount, groupState, selectionCounts,
    filtered, filteredRows, sectionedGroups, groupTotal,
    // source state
    activeSourceId, activeSourceName, lastFetched,
    // playlist state
    activePlaylistId, activePlaylistName, saving, building, saveError, loadingSelection,
    // methods
    selectGroup, loadMoreChannels, loadSourceFromCache,
    loadPlaylistSelection, saveToPlaylist, buildPlaylist,
    toggleChannel, selectAll, selectNone, toggleGroup, toggleSection,
    exportM3U, copyM3U, onImgError,
    setGroupOverride, getAllSelectedChannels, groupOverrides,
    setChannelNumbers, channelNumbers,
    setEpgOverride, epgOverrides,
    setEpgSourceOverride, epgSourceOverrides,
    setNameOverride, nameOverrides,
  }
}
