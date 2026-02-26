<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { api } from '../composables/useApi.js'
import TmdbMatchModal from '../components/TmdbMatchModal.vue'

const tab        = ref('mappings')
const playlists  = ref([])
const epgSources = ref([])
const mappings   = ref([])
const matches    = ref([])
const epgCount   = ref(0)
const warning    = ref('')
const loading    = ref(false)
const matching      = ref(false)
const isInitialLoad   = ref(false)
const showAcceptMenu  = ref(false)
const error      = ref('')
const showForm   = ref(false)
const form       = ref({ source_tvg_id: '', target_tvg_id: '', note: '' })
const selectedPl = ref('')
const selectedEpgSource = ref('')
const search     = ref('')
const filterMode = ref('all')
const checked    = ref(new Set())
const sortCol    = ref('score')   // 'name' | 'score' | 'status'
const sortDir    = ref('desc')

// TMDB Matches tab state
const tmdbTitles = ref([])
const tmdbStats = ref({ matched: 0, not_found: 0, unmatched: 0, blocked: 0 })

// Decode HTML entities for display
function decodeHtmlEntities(text) {
  if (!text) return text
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
const tmdbFilterStatus = ref('all')
const tmdbSearchQuery = ref('')
const tmdbSortBy = ref('title')
const tmdbLoading = ref(false)
const tmdbShowModal = ref(false)
const tmdbEditingTitle = ref(null)

// ── Edit/search modal ─────────────────────────────────────────────────────────
const editRow       = ref(null)   // the match row being edited
const editSearch    = ref('')
const editResults   = ref([])
const editSearching = ref(false)
let   editDebounce  = null

function openEdit(m) {
  editRow.value     = m
  editSearch.value  = m.tvg_name
  editResults.value = []
  // Pre-select the channel's assigned EPG source (user can override)
  if (m.epg_source_id) selectedEpgSource.value = String(m.epg_source_id)
  searchEpg(m.tvg_name)
}

function closeEdit() {
  editRow.value = null
  editSearch.value = ''
  editResults.value = []
}

async function searchEpg(q) {
  if (!q.trim()) { editResults.value = []; return }
  editSearching.value = true
  try {
    const params = new URLSearchParams({ q: q.trim() })
    if (selectedEpgSource.value) params.set('source_id', selectedEpgSource.value)
    editResults.value = await fetch(`/api/epg/search-cached?${params}`).then(r => r.json())
  } catch { editResults.value = [] }
  finally { editSearching.value = false }
}

function onEditSearchInput() {
  clearTimeout(editDebounce)
  editDebounce = setTimeout(() => searchEpg(editSearch.value), 300)
}

async function pickEpgChannel(epgCh) {
  const m = editRow.value
  if (!m) return

  // Apply EPG mapping to ALL variants of this channel (all sources)
  // Variants are channels with the same normalized_name
  const variantIds = m.variants?.map(v => v.channel_id).filter(Boolean) || []
  const allChannelIds = [m.channel_id, ...variantIds].filter(Boolean)

  // Channels WITH tvg_id → save to epg_mappings table
  if (m.tvg_id) {
    await api.bulkCreateMappings([{ source_tvg_id: m.tvg_id, target_tvg_id: epgCh.id }])
    mappings.value = await api.getEpgMappings()
  }

  // For ALL channel variants (including those without tvg_id), set custom_tvg_id
  // This ensures all variants get the same EPG mapping
  for (const channelId of allChannelIds) {
    await api.patchChannelCustomTvgId(channelId, epgCh.id)
  }

  // Update UI for all matching channels
  for (const match of matches.value) {
    if (allChannelIds.includes(match.channel_id)) {
      match.mapped_to = epgCh.id
      match.exact_match = epgCh
    }
  }

  closeEdit()
}

function sortScore(m) {
  if (m.exact_match) return 101
  if (m.mapped_to)   return 100
  return m.suggestions[0]?.score || 0
}

function setSort(col) {
  if (sortCol.value === col) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortCol.value = col; sortDir.value = col === 'name' ? 'asc' : 'desc' }
}

const filtered = computed(() => {
  let list = matches.value
  const q = search.value.toLowerCase()
  if (q) list = list.filter(m => m.tvg_name.toLowerCase().includes(q) || m.tvg_id.toLowerCase().includes(q))
  if (filterMode.value === 'unmatched') list = list.filter(m => !m.exact_match && !m.mapped_to && !m.suggestions.length)
  if (filterMode.value === 'matched')   list = list.filter(m => m.exact_match || m.mapped_to)
  if (filterMode.value === 'suggest')   list = list.filter(m => !m.exact_match && !m.mapped_to && m.suggestions.length)
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...list].sort((a, b) => {
    if (sortCol.value === 'name')   return dir * a.tvg_name.localeCompare(b.tvg_name)
    if (sortCol.value === 'status') {
      const rank = m => m.exact_match ? 0 : m.mapped_to ? 1 : m.suggestions.length ? 2 : 3
      return dir * (rank(a) - rank(b))
    }
    // Default and 'score': sort by channel number (sort_order), then by channel ID
    const aNum = a.sort_order || 999999
    const bNum = b.sort_order || 999999
    if (aNum !== bNum) return aNum - bNum
    return a.channel_id - b.channel_id
  })
})

const stats = computed(() => ({
  total:     matches.value.length,
  exact:     matches.value.filter(m => m.exact_match).length,
  mapped:    matches.value.filter(m => m.mapped_to && !m.exact_match).length,
  suggested: matches.value.filter(m => !m.exact_match && !m.mapped_to && m.suggestions.length).length,
  none:      matches.value.filter(m => !m.exact_match && !m.mapped_to && !m.suggestions.length).length,
}))

const allChecked  = computed(() => filtered.value.length > 0 && filtered.value.every(m => checked.value.has(m.channel_id)))
const someChecked = computed(() => !allChecked.value && filtered.value.some(m => checked.value.has(m.channel_id)))

async function loadAll() {
  const [pl, mp, es] = await Promise.allSettled([
    api.getPlaylists(),
    api.getEpgMappings(),
    fetch('/api/epg/sources').then(r => r.json()),
  ])
  if (pl.status === 'fulfilled') playlists.value  = pl.value
  if (mp.status === 'fulfilled') mappings.value   = mp.value
  if (es.status === 'fulfilled') epgSources.value = es.value
  if (!selectedPl.value && playlists.value.length) {
    selectedPl.value = String(playlists.value[0].id)
    // watch will trigger loadMatches
  }
}

// On playlist change: just load existing state, no auto-persist
watch(selectedPl, (val) => { if (val) loadMatches() })

async function loadMatches() {
  if (!selectedPl.value) return
  matching.value = true; isInitialLoad.value = true; warning.value = ''; error.value = ''; checked.value = new Set()
  try {
    console.log('Loading EPG matches for playlist:', selectedPl.value)
    const res = await api.autoMatchEpg(selectedPl.value)
    console.log('EPG matches response:', res)
    matches.value  = res.matches || []
    epgCount.value = res.epg_count || 0
    warning.value  = res.warning || ''

    // If we have a warning but no matches, make it an error to make it more visible
    if (warning.value && !matches.value.length) {
      error.value = warning.value
      warning.value = ''
    }
  } catch (e) {
    console.error('Error loading EPG matches:', e)
    error.value = e.message || 'Failed to load EPG matches'
  }
  finally { matching.value = false; isInitialLoad.value = false }
}

// Explicit Re-run: fetch fresh matches AND auto-persist new exact matches
async function runAutoMatch() {
  if (!selectedPl.value) return
  const existingCount = matches.value.filter(m => m.exact_match || m.mapped_to).length
  if (existingCount > 0) {
    if (!confirm(`Re-running will clear ${existingCount} previously accepted match${existingCount === 1 ? '' : 'es'} for this playlist and re-match from scratch.\n\nAre you sure?`)) return
    await api.clearPlaylistMappings(selectedPl.value)
  }
  matching.value = true; warning.value = ''; error.value = ''; checked.value = new Set()
  try {
    const res = await api.autoMatchEpg(selectedPl.value)
    matches.value  = res.matches || []
    epgCount.value = res.epg_count || 0
    warning.value  = res.warning || ''

    // Auto-persist: exact tvg_id matches + 100% Dice score suggestions
    const candidates = matches.value
      .filter(m => !m.mapped_to)
      .filter(m => m.exact_match || m.suggestions[0]?.score === 100)

    // Channels WITH tvg_id → epg_mappings table
    const toSave = candidates
      .filter(m => m.tvg_id)
      .map(m => {
        const target = m.exact_match ?? m.suggestions[0]
        return { source_tvg_id: m.tvg_id, target_tvg_id: target.id, note: m.exact_match ? 'auto-exact' : 'auto-100pct' }
      })
    if (toSave.length) {
      await api.bulkCreateMappings(toSave)
      mappings.value = await api.getEpgMappings()
    }

    // Channels WITHOUT tvg_id → patch custom_tvg_id on channel row
    const noIdCandidates = candidates.filter(m => !m.tvg_id && m.channel_id)
    await Promise.all(noIdCandidates.map(m => {
      const target = m.exact_match ?? m.suggestions[0]
      return api.patchChannelCustomTvgId(m.channel_id, target.id)
    }))

    // Update UI state for all auto-accepted
    for (const m of candidates) {
      const target = m.exact_match ?? m.suggestions[0]
      m.mapped_to   = target.id
      m.exact_match = target
    }
  } catch (e) { error.value = e.message }
  finally { matching.value = false }
}

function toggleOne(channelId) {
  const s = new Set(checked.value); s.has(channelId) ? s.delete(channelId) : s.add(channelId); checked.value = s
}
function toggleAll() {
  const s = new Set(checked.value)
  if (allChecked.value) { for (const m of filtered.value) s.delete(m.channel_id) }
  else { for (const m of filtered.value) s.add(m.channel_id) }
  checked.value = s
}
function bestSuggestion(m) {
  if (m.exact_match) return m.exact_match
  if (m.mapped_to)   return { id: m.mapped_to }
  return m.suggestions[0] || null
}
function epgLogo(m) {
  return m.exact_match?.icon || m.suggestions[0]?.icon || null
}

async function setLogo(m, logo) {
  if (!m.channel_id) return
  // Clicking the already-active logo clears the override (revert to source)
  const newLogo = (m.custom_logo === logo || (!m.custom_logo && logo === m.tvg_logo)) ? null : logo
  await api.patchChannelCustomLogo(m.channel_id, newLogo)
  m.custom_logo = newLogo
}

function scoreColor(s) { return s >= 90 ? 'text-emerald-400' : s >= 70 ? 'text-lime-400' : s >= 50 ? 'text-amber-400' : 'text-red-400' }
function scoreBg(s)    { return s >= 90 ? 'bg-emerald-500/15 border-emerald-500/30' : s >= 70 ? 'bg-lime-500/15 border-lime-500/30' : s >= 50 ? 'bg-amber-500/15 border-amber-500/30' : 'bg-red-500/15 border-red-500/30' }

async function acceptOne(m, epgChannel) {
  if (m.tvg_id) {
    await api.bulkCreateMappings([{ source_tvg_id: m.tvg_id, target_tvg_id: epgChannel.id }])
    mappings.value = await api.getEpgMappings()
  } else if (m.channel_id) {
    // No tvg_id — store directly as custom_tvg_id on the channel row
    await api.patchChannelCustomTvgId(m.channel_id, epgChannel.id)
  }
  m.mapped_to   = epgChannel.id
  m.exact_match = epgChannel
}

async function acceptChecked() {
  const toMap = []
  for (const channelId of checked.value) {
    const m = matches.value.find(x => x.channel_id === channelId)
    if (!m || m.exact_match || m.mapped_to) continue
    const best = bestSuggestion(m)
    if (!best) continue
    if (m.tvg_id) toMap.push({ source_tvg_id: m.tvg_id, target_tvg_id: best.id })
    else if (m.channel_id) await api.patchChannelCustomTvgId(m.channel_id, best.id)
    m.mapped_to = best.id; m.exact_match = best
  }
  loading.value = true
  try {
    if (toMap.length) await api.bulkCreateMappings(toMap)
    checked.value = new Set(); mappings.value = await api.getEpgMappings()
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function deleteChecked() {
  const ids = [...checked.value]
  if (!ids.length) return
  if (!confirm(`Remove ${ids.length} channel${ids.length === 1 ? '' : 's'} from this playlist?\n\nThis cannot be undone.`)) return
  loading.value = true
  try {
    await Promise.all(ids.map(id => api.deletePlaylistChannel(id)))
    matches.value = matches.value.filter(m => !checked.value.has(m.channel_id))
    checked.value = new Set()
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function acceptAllAbove(threshold) {
  const toMap = matches.value
    .filter(m => m.tvg_id && !m.exact_match && !m.mapped_to && (m.suggestions[0]?.score || 0) >= threshold)
    .map(m => ({ source_tvg_id: m.tvg_id, target_tvg_id: m.suggestions[0].id }))
  if (!toMap.length) return
  loading.value = true
  try {
    await api.bulkCreateMappings(toMap)
    for (const r of toMap) {
      const m = matches.value.find(x => x.tvg_id === r.source_tvg_id)
      if (m) { m.mapped_to = r.target_tvg_id; m.exact_match = m.suggestions[0] || null }
    }
    mappings.value = await api.getEpgMappings()
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function removeMapping(m) {
  const existing = mappings.value.find(x => x.source_tvg_id === m.tvg_id)
  if (!existing) return
  await api.deleteEpgMapping(existing.id)
  m.mapped_to = null; m.exact_match = null; mappings.value = await api.getEpgMappings()
}

async function saveManual() {
  loading.value = true; error.value = ''
  try {
    await api.createEpgMapping(form.value)
    showForm.value = false; form.value = { source_tvg_id: '', target_tvg_id: '', note: '' }
    mappings.value = await api.getEpgMappings()
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function removeManual(m) {
  if (!confirm(`Delete mapping "${m.source_tvg_id}" → "${m.target_tvg_id}"?`)) return
  await api.deleteEpgMapping(m.id); mappings.value = await api.getEpgMappings()
}

async function removeFromPlaylist(m) {
  if (!m.channel_id) return
  if (!confirm(`Remove "${m.tvg_name}" from this playlist?\n\nThis cannot be undone.`)) return
  loading.value = true
  try {
    await api.deletePlaylistChannel(m.channel_id)
    matches.value = matches.value.filter(x => x.channel_id !== m.channel_id)
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

// ── EPG Viewer ───────────────────────────────────────────────────────────────
const epgViewer      = ref(null)   // { channelName, channelId }
const epgProgrammes  = ref([])
const epgLoading     = ref(false)
const epgError       = ref('')

function formatTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  const tom = new Date(today); tom.setDate(tom.getDate() + 1)
  if (d.toDateString() === tom.toDateString()) return 'Tomorrow'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}
function isNowPlaying(prog) {
  const now = Date.now()
  return new Date(prog.start) <= now && new Date(prog.stop) > now
}

async function openEpgViewer(m) {
  const channelId = m.exact_match?.id || m.mapped_to
  if (!channelId) return
  epgViewer.value     = { channelName: m.tvg_name, channelId }
  epgProgrammes.value = []
  epgLoading.value    = true
  epgError.value      = ''
  try {
    const r = await fetch(`/api/epg/programmes?channel_id=${encodeURIComponent(channelId)}`)
    const d = await r.json()
    if (!r.ok) throw new Error(d.error)
    epgProgrammes.value = d
  } catch (e) {
    epgError.value = e.message
  } finally {
    epgLoading.value = false
  }
}

function closeEpgViewer() { epgViewer.value = null; epgProgrammes.value = [] }

// Group programmes by date
const epgByDate = computed(() => {
  const groups = []
  let lastDate = null
  for (const p of epgProgrammes.value) {
    const d = formatDate(p.start)
    if (d !== lastDate) { groups.push({ date: d, items: [] }); lastDate = d }
    groups[groups.length - 1].items.push(p)
  }
  return groups
})

// ── TMDB Matches Tab Functions ──────────────────────────────────────────────
async function loadTmdbTitles() {
  if (!selectedPl.value) return

  tmdbLoading.value = true
  try {
    // Load ALL titles from API without filters - we'll filter client-side
    const url = `/api/tmdb/titles/${selectedPl.value}`
    const response = await fetch(url)
    const data = await response.json()
    tmdbTitles.value = data.titles || []

    // Calculate stats from all titles
    tmdbStats.value = {
      matched: tmdbTitles.value.filter(t => t.status === 'matched').length,
      unmatched: tmdbTitles.value.filter(t => t.status === 'unmatched').length,
      not_found: tmdbTitles.value.filter(t => t.status === 'not_found').length,
      blocked: tmdbTitles.value.filter(t => t.status === 'blocked').length
    }
  } catch (e) {
    console.error('[tmdb] Error loading TMDB titles:', e)
  } finally {
    tmdbLoading.value = false
  }
}

// Client-side filtering and sorting for instant response
const tmdbSortedTitles = computed(() => {
  let filtered = [...tmdbTitles.value]

  // Apply status filter
  if (tmdbFilterStatus.value !== 'all') {
    filtered = filtered.filter(t => t.status === tmdbFilterStatus.value)
  }

  // Apply search filter
  if (tmdbSearchQuery.value) {
    const query = tmdbSearchQuery.value.toLowerCase()
    filtered = filtered.filter(t => t.title.toLowerCase().includes(query))
  }

  // Apply sorting
  if (tmdbSortBy.value === 'title') {
    filtered.sort((a, b) => a.title.localeCompare(b.title))
  } else if (tmdbSortBy.value === 'count') {
    filtered.sort((a, b) => b.programme_count - a.programme_count)
  } else if (tmdbSortBy.value === 'date') {
    filtered.sort((a, b) => {
      if (!a.fetched_at) return 1
      if (!b.fetched_at) return -1
      return new Date(b.fetched_at) - new Date(a.fetched_at)
    })
  }

  return filtered
})

function getTmdbStatusBadge(status) {
  const badges = {
    matched: { class: 'bg-green-500/20 text-green-400 border-green-500/30', icon: '✓', label: 'Matched' },
    not_found: { class: 'bg-red-500/20 text-red-400 border-red-500/30', icon: '⚠', label: 'Not Found' },
    unmatched: { class: 'bg-slate-500/20 text-slate-400 border-slate-500/30', icon: '⭕', label: 'Unmatched' },
    blocked: { class: 'bg-amber-500/20 text-amber-400 border-amber-500/30', icon: '🚫', label: 'Blocked' }
  }
  return badges[status] || badges.unmatched
}

function openTmdbEditModal(title) {
  tmdbEditingTitle.value = title
  tmdbShowModal.value = true
}

function closeTmdbModal() {
  tmdbShowModal.value = false
  tmdbEditingTitle.value = null
}

async function handleTmdbSave(updateData) {
  // Update the local title data immediately
  if (tmdbEditingTitle.value && updateData) {
    const titleIndex = tmdbTitles.value.findIndex(t => t.title === tmdbEditingTitle.value.title)
    if (titleIndex !== -1) {
      const title = tmdbTitles.value[titleIndex]

      if (updateData.cleared) {
        // Clear match - reset to unmatched
        title.status = 'unmatched'
        title.tmdb_id = null
        title.media_type = null
        title.poster = null
        title.description = null
        title.manual_override = false
        title.blocked = false
      } else if (updateData.blocked !== undefined) {
        // Block/unblock
        title.blocked = updateData.blocked
        title.status = updateData.blocked ? 'blocked' : 'unmatched'
      } else if (updateData.tmdb_id) {
        // New match
        title.status = 'matched'
        title.tmdb_id = updateData.tmdb_id
        title.media_type = updateData.media_type
        title.poster = updateData.poster
        title.description = updateData.description
        title.manual_override = true
      }

      // Trigger reactivity by creating new array
      tmdbTitles.value = [...tmdbTitles.value]
    }
  }

  closeTmdbModal()
}

// ── TMDB Enrichment ──────────────────────────────────────────────────────────
const enrichStatus  = ref(null)
const enriching     = ref(false)
let   enrichPoller  = null

async function loadEnrichStatus() {
  try { enrichStatus.value = await fetch('/api/epg/enrich/status').then(r => r.json()) } catch {}
}

async function triggerEnrich() {
  enriching.value = true
  error.value = ''
  try {
    const r = await fetch('/api/epg/enrich', { method: 'POST' })
    const d = await r.json()
    if (!r.ok) { error.value = d.error; enriching.value = false; return }
    enrichPoller = setInterval(async () => {
      await loadEnrichStatus()
      if (!enrichStatus.value?.inProgress) {
        clearInterval(enrichPoller)
        enriching.value = false
      }
    }, 2000)
  } catch (e) {
    error.value = e.message
    enriching.value = false
  }
}

// Watch for tab changes to load TMDB data when switching to TMDB tab
watch(tab, async (newTab) => {
  if (newTab === 'tmdb') {
    console.log('[tmdb-watch] Switched to TMDB tab, selectedPl:', selectedPl.value)
    // Auto-select first playlist if none selected
    if (!selectedPl.value && playlists.value.length > 0) {
      selectedPl.value = String(playlists.value.filter(p => p.playlist_type !== 'vod')[0]?.id || '')
      console.log('[tmdb-watch] Auto-selected playlist:', selectedPl.value)
    }
    // Load titles if we have a playlist
    if (selectedPl.value) {
      await loadTmdbTitles()
    }
  }
})

onMounted(async () => {
  await loadAll()
  await loadEnrichStatus()
  // If TMDB tab is active on mount and we have playlists, load titles
  if (tab.value === 'tmdb' && playlists.value.length > 0 && !selectedPl.value) {
    selectedPl.value = String(playlists.value.filter(p => p.playlist_type !== 'vod')[0]?.id || '')
    if (selectedPl.value) {
      await loadTmdbTitles()
    }
  }
})
onUnmounted(() => { if (enrichPoller) clearInterval(enrichPoller) })
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">

    <!-- Header -->
    <div class="flex items-center gap-3 px-6 py-4 border-b border-[#2e3250] shrink-0">
      <div class="flex-1">
        <h1 class="text-sm font-bold text-slate-100">EPG Mappings</h1>
        <p class="text-xs text-slate-500 mt-0.5">Map channel <code>tvg-id</code> values to EPG IDs — fixes guide data in Plex/Emby/Jellyfin</p>
      </div>
      <div class="flex bg-[#13151f] border border-[#2e3250] rounded-lg p-0.5">
        <button @click="tab = 'mappings'"
          :class="['px-3 py-1.5 text-xs font-medium rounded transition-colors',
            tab === 'mappings' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'text-slate-400 hover:text-slate-200']">
          🗺️ Mappings
        </button>
        <button @click="tab = 'tmdb'"
          :class="['px-3 py-1.5 text-xs font-medium rounded transition-colors',
            tab === 'tmdb' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'text-slate-400 hover:text-slate-200']">
          🎬 TMDB Matching
        </button>
      </div>
    </div>


    <!-- ── MAPPINGS TAB ──────────────────────────────────────────────────── -->
    <template v-if="tab === 'mappings'">

      <!-- Toolbar -->
      <div class="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-[#2e3250] shrink-0 bg-[#13151f]">
        <select v-model="selectedPl"
          class="bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500">
          <option value="" disabled>Select playlist…</option>
          <option v-for="p in playlists.filter(p => p.playlist_type !== 'vod')" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
        </select>

        <select v-if="epgSources.length > 1" v-model="selectedEpgSource"
          class="bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500">
          <option value="">All EPG sources</option>
          <option v-for="s in epgSources" :key="s.id" :value="String(s.id)">{{ s.name }} ({{ (s.channel_count||0).toLocaleString() }})</option>
        </select>

        <button @click="runAutoMatch" :disabled="!selectedPl || matching"
          class="flex items-center gap-1.5 px-4 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors">
          <span v-if="matching" class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
          {{ matching ? 'Matching…' : '� Re-run Match' }}
        </button>

        <template v-if="matches.length">
          <span class="text-[10px] text-slate-500">{{ epgCount.toLocaleString() }} EPG channels</span>
          <span class="flex-1"></span>
          <template v-if="checked.size > 0">
            <button @click="acceptChecked" :disabled="loading"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-500/15 border border-emerald-500/30 hover:border-emerald-400 text-emerald-300 rounded-lg transition-colors">
              ✓ Accept {{ checked.size }}
            </button>
            <button @click="deleteChecked" :disabled="loading"
              class="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-500/10 border border-red-900/40 hover:border-red-500 text-red-400 rounded-lg transition-colors">
              🗑 Delete {{ checked.size }}
            </button>
          </template>
          <div class="relative" @mouseenter="showAcceptMenu = true" @mouseleave="showAcceptMenu = false">
            <button class="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-indigo-400 text-slate-300 rounded-lg transition-colors">
              Accept all ≥ <span class="text-indigo-300 ml-1">▾</span>
            </button>
            <div v-if="showAcceptMenu" class="absolute right-0 top-full mt-1 bg-[#1a1d27] border border-[#2e3250] rounded-lg shadow-xl z-20 overflow-hidden min-w-36">
              <button v-for="t in [90,80,70,60]" :key="t" @click="acceptAllAbove(t); showAcceptMenu = false"
                class="w-full text-left px-4 py-2 text-xs hover:bg-[#22263a] flex items-center gap-2">
                <span :class="scoreColor(t)" class="font-mono font-bold w-8">≥{{ t }}%</span>
                <span class="text-slate-400">{{ matches.filter(m => !m.exact_match && !m.mapped_to && (m.suggestions[0]?.score||0) >= t).length }} channels</span>
              </button>
            </div>
          </div>
        </template>
      </div>

      <!-- Filter + search bar -->
      <div v-if="matches.length" class="flex items-center justify-center gap-2 px-6 py-2 border-b border-[#2e3250] shrink-0">
        <button @click="filterMode = 'all'"
          :class="['text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium', filterMode === 'all' ? 'bg-slate-400 border-slate-400 text-slate-900' : 'bg-transparent border-slate-500 text-slate-400 hover:border-slate-300 hover:text-slate-200']">
          All {{ stats.total }}
        </button>
        <button @click="filterMode = 'matched'"
          :class="['text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium', filterMode === 'matched' ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-transparent border-emerald-600 text-emerald-400 hover:border-emerald-400 hover:text-emerald-300']">
          ✓ {{ stats.exact }} exact · ↔ {{ stats.mapped }} mapped
        </button>
        <button @click="filterMode = 'suggest'"
          :class="['text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium', filterMode === 'suggest' ? 'bg-amber-500 border-amber-500 text-white' : 'bg-transparent border-amber-600 text-amber-400 hover:border-amber-400 hover:text-amber-300']">
          ? {{ stats.suggested }} suggested
        </button>
        <button @click="filterMode = 'unmatched'"
          :class="['text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium', filterMode === 'unmatched' ? 'bg-slate-500 border-slate-500 text-white' : 'bg-transparent border-slate-600 text-slate-400 hover:border-slate-400 hover:text-slate-300']">
          ✗ {{ stats.none }} no match
        </button>
        <input v-model="search" placeholder="Search channels…"
          class="bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-1.5 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500 w-48" />
      </div>

      <div v-if="warning" class="mx-6 mt-3 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300 shrink-0">⚠ {{ warning }}</div>
      <div v-if="error"   class="mx-6 mt-3 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300 shrink-0">⚠ {{ error }}</div>

      <!-- Empty / loading state -->
      <div v-if="matching" class="flex flex-col items-center justify-center flex-1 text-slate-500 gap-3">
        <span class="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-400 rounded-full animate-spin"></span>
        <p class="text-sm">{{ isInitialLoad ? 'Loading matches…' : 'Running auto-match…' }}</p>
      </div>
      <div v-else-if="!matches.length && error" class="flex flex-col items-center justify-center flex-1 text-slate-500 gap-3">
        <span class="text-5xl">⚠️</span>
        <p class="text-sm text-red-400">{{ error }}</p>
        <p class="text-xs text-slate-600">Try refreshing an EPG source first to populate the EPG cache</p>
        <button @click="runAutoMatch" class="mt-4 px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-xl transition-colors">
          Try Again
        </button>
      </div>
      <div v-else-if="!matches.length" class="flex flex-col items-center justify-center flex-1 text-slate-500 gap-3">
        <span class="text-5xl">🤖</span>
        <p class="text-sm">{{ selectedPl ? 'No channels found in this playlist' : 'Select a playlist to begin' }}</p>
        <p class="text-xs text-slate-600">Channels load automatically and exact matches are saved to the database</p>
        <button v-if="selectedPl" @click="runAutoMatch" class="mt-4 px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-xl transition-colors">
          Reload Data
        </button>
      </div>

      <!-- Table -->
      <div v-else class="flex-1 overflow-y-auto">
        <!-- Mobile notice -->
        <div class="md:hidden px-4 py-2 mb-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-xs">
          Swipe horizontally on table to see all content →
        </div>
        <div class="overflow-x-auto w-full" style="-webkit-overflow-scrolling: touch; max-width: 100vw;">
          <table class="w-full text-xs border-collapse min-w-[900px]">
          <thead class="sticky top-0 bg-[#13151f] border-b border-[#2e3250] z-10">
            <tr>
              <th class="w-8 px-3 py-2.5">
                <input type="checkbox" :checked="allChecked" :indeterminate="someChecked" @change="toggleAll" class="accent-indigo-500 cursor-pointer" />
              </th>
              <th class="px-3 py-2.5 text-center text-slate-400 font-medium w-16">Ch #</th>
              <th class="px-3 py-2.5 text-center text-slate-400 font-medium w-20 hidden xl:table-cell">ID</th>
              <th @click="setSort('name')" class="px-3 py-2.5 text-left text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                Channel <span class="text-slate-600">{{ sortCol === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : '↕' }}</span>
              </th>
              <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-36">Source tvg-id</th>
              <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-32 hidden lg:table-cell">Variants</th>
              <th class="px-3 py-2.5 text-center text-slate-400 font-medium w-16">
                Match %
              </th>
              <th @click="setSort('status')" class="px-3 py-2.5 text-left text-slate-400 font-medium cursor-pointer hover:text-slate-200 select-none">
                Best EPG Match <span class="text-slate-600">{{ sortCol === 'status' ? (sortDir === 'asc' ? '↑' : '↓') : '↕' }}</span>
              </th>
              <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-20 hidden xl:table-cell">Alt. Matches</th>
              <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-28 hidden lg:table-cell">EPG Source</th>
              <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-28">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in filtered" :key="m.channel_id"
              :class="['border-b border-[#2e3250]/40 transition-colors',
                checked.has(m.channel_id) ? 'bg-indigo-500/8' : 'hover:bg-[#22263a]']">

              <td class="px-3 py-2" @click.stop>
                <input type="checkbox" :checked="checked.has(m.channel_id)"
                  @change="toggleOne(m.channel_id)" class="accent-indigo-500 cursor-pointer" />
              </td>

              <td class="px-3 py-2 text-center font-mono text-slate-500 text-xs">
                {{ m.sort_order ? m.sort_order : '—' }}
              </td>

              <td class="px-3 py-2 text-center font-mono text-slate-600 text-[10px] hidden xl:table-cell">
                {{ m.channel_id }}
              </td>

              <td class="px-3 py-2">
                <div class="flex items-center gap-2">
                  <!-- Logo toggle: source logo | EPG logo — click to pick which is used in M3U -->
                  <div class="flex items-center gap-0.5 shrink-0">
                    <button
                      :title="'Use source logo' + (m.tvg_logo ? '' : ' (none)')"
                      :disabled="!m.tvg_logo"
                      @click="setLogo(m, m.tvg_logo)"
                      :class="['w-7 h-7 flex items-center justify-center rounded border transition-all',
                        !m.custom_logo ? 'border-indigo-500 ring-1 ring-indigo-500/50' : 'border-transparent opacity-40 hover:opacity-80']">
                      <img v-if="m.tvg_logo" :src="`/api/logo?url=${encodeURIComponent(m.tvg_logo)}`"
                        class="max-w-6 max-h-6 object-contain rounded"
                        @error="e => e.target.style.display='none'" />
                      <span v-else class="text-slate-700 text-xs">📺</span>
                    </button>
                    <button v-if="epgLogo(m)"
                      title="Use EPG logo"
                      @click="setLogo(m, epgLogo(m))"
                      :class="['w-7 h-7 flex items-center justify-center rounded border transition-all',
                        m.custom_logo === epgLogo(m) ? 'border-emerald-500 ring-1 ring-emerald-500/50' : 'border-transparent opacity-40 hover:opacity-80']">
                      <img :src="epgLogo(m)"
                        class="max-w-6 max-h-6 object-contain rounded"
                        @error="e => e.target.style.display='none'" />
                    </button>
                  </div>
                  <span class="font-medium text-slate-200">{{ m.tvg_name }}</span>
                </div>
              </td>

              <td class="px-3 py-2 font-mono text-slate-500 text-[10px] truncate max-w-36">{{ m.tvg_id || '—' }}</td>

              <!-- Variants (quality versions) -->
              <td class="px-3 py-2 hidden lg:table-cell">
                <div v-if="m.variants && m.variants.length > 0" class="flex items-center gap-2">
                  <span class="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded text-[10px] font-semibold" :title="`${m.variants.length} variant(s) will be updated together`">
                    🔗 {{ m.variants.length }}
                  </span>
                  <div class="flex flex-wrap gap-1">
                    <span v-for="(v, idx) in m.variants.slice(0, 3)" :key="idx"
                      :title="`${v.source_name}: ${v.tvg_name}`"
                      :class="['text-[9px] px-1.5 py-0.5 rounded border whitespace-nowrap',
                        v.quality === 'UHD' ? 'bg-purple-500/15 border-purple-500/30 text-purple-400' :
                        v.quality === 'FHD' ? 'bg-blue-500/15 border-blue-500/30 text-blue-400' :
                        v.quality === 'HD' ? 'bg-green-500/15 border-green-500/30 text-green-400' :
                        v.quality === 'SD' ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400' :
                        'bg-slate-500/15 border-slate-500/30 text-slate-400']">
                      {{ v.quality || '?' }}
                    </span>
                  </div>
                </div>
                <span v-else class="text-slate-700 text-[10px]">—</span>
              </td>

              <td class="px-3 py-2 text-center">
                <span v-if="m.exact_match"
                  class="inline-block text-[10px] px-1.5 py-0.5 rounded border bg-emerald-500/15 border-emerald-500/30 text-emerald-400 font-bold">100%</span>
                <span v-else-if="m.mapped_to"
                  class="inline-block text-[10px] px-1.5 py-0.5 rounded border bg-indigo-500/15 border-indigo-500/30 text-indigo-400">mapped</span>
                <span v-else-if="m.suggestions[0]"
                  :class="['inline-block text-[10px] px-1.5 py-0.5 rounded border font-bold', scoreBg(m.suggestions[0].score), scoreColor(m.suggestions[0].score)]">
                  {{ m.suggestions[0].score }}%
                </span>
                <span v-else class="text-slate-700">—</span>
              </td>

              <td class="px-3 py-2">
                <div v-if="m.exact_match" class="flex items-center gap-2">
                  <img v-if="m.exact_match.icon" :src="m.exact_match.icon" class="w-5 h-5 object-contain rounded-sm shrink-0" @error="e => e.target.style.display='none'" />
                  <div>
                    <span class="text-emerald-300 font-medium">{{ m.exact_match.name }}</span>
                    <span class="block text-[10px] font-mono text-emerald-600">{{ m.exact_match.id }}</span>
                  </div>
                  <span class="text-[10px] text-emerald-600 ml-1">✓ exact</span>
                </div>
                <div v-else-if="m.mapped_to" class="flex items-center gap-2">
                  <span class="text-indigo-300 font-mono text-[10px]">{{ m.mapped_to }}</span>
                  <span class="text-[10px] text-indigo-600">↔ mapped</span>
                </div>
                <div v-else-if="m.suggestions.length" class="flex items-center gap-2">
                  <img v-if="m.suggestions[0].icon" :src="m.suggestions[0].icon" class="w-5 h-5 object-contain rounded-sm shrink-0" @error="e => e.target.style.display='none'" />
                  <div class="min-w-0">
                    <span class="text-slate-200">{{ m.suggestions[0].name }}</span>
                    <span class="block text-[10px] font-mono text-slate-500 truncate">{{ m.suggestions[0].id }}</span>
                  </div>
                </div>
                <span v-else class="text-slate-700 text-[10px]">No match found</span>
              </td>

              <!-- Alt. Matches -->
              <td class="px-3 py-2 hidden xl:table-cell">
                <div v-if="m.suggestions.length > 1" class="flex flex-col gap-1">
                  <button v-for="s in m.suggestions.slice(1)" :key="s.id"
                    @click="acceptOne(m, s)" :title="s.name"
                    :class="['text-[9px] px-1.5 py-0.5 rounded border transition-colors text-left truncate max-w-[7rem]', scoreBg(s.score), scoreColor(s.score)]">
                    {{ s.score }}% {{ s.name }}
                  </button>
                </div>
                <span v-else class="text-slate-700 text-[10px]">—</span>
              </td>

              <!-- EPG Source -->
              <td class="px-3 py-2 hidden lg:table-cell">
                <template v-if="m.epg_source_id">
                  <span class="text-[10px] text-violet-400 truncate block max-w-[7rem]"
                    :title="epgSources.find(s => s.id == m.epg_source_id)?.name">
                    {{ epgSources.find(s => s.id == m.epg_source_id)?.name ?? m.epg_source_id }}
                  </span>
                  <span class="text-[10px] text-slate-600">assigned</span>
                </template>
                <span v-else-if="m.exact_match?.source_name" class="text-[10px] text-slate-500 truncate block max-w-[7rem]" :title="m.exact_match.source_name">{{ m.exact_match.source_name }}</span>
                <span v-else-if="m.suggestions[0]?.source_name" class="text-[10px] text-slate-500 truncate block max-w-[7rem]" :title="m.suggestions[0].source_name">{{ m.suggestions[0].source_name }}</span>
                <span v-else class="text-slate-700 text-[10px]">—</span>
              </td>

              <td class="px-3 py-2">
                <div class="flex gap-1.5">
                  <button v-if="!m.exact_match && !m.mapped_to && m.suggestions[0]"
                    @click="acceptOne(m, m.suggestions[0])"
                    class="px-2 py-1 text-[10px] bg-emerald-500/15 border border-emerald-500/30 hover:border-emerald-400 text-emerald-300 rounded transition-colors">
                    Accept
                  </button>
                  <button @click="openEdit(m)"
                    class="px-2 py-1 text-[10px] bg-indigo-500/15 border border-indigo-500/30 hover:border-indigo-400 text-indigo-300 rounded transition-colors">
                    Search
                  </button>
                  <button v-if="m.exact_match || m.mapped_to" @click="openEpgViewer(m)"
                    class="px-2 py-1 text-[10px] bg-violet-500/15 border border-violet-500/30 hover:border-violet-400 text-violet-300 rounded transition-colors">
                    Guide
                  </button>
                  <button v-if="m.mapped_to && !m.exact_match" @click="removeMapping(m)"
                    class="px-2 py-1 text-[10px] bg-red-500/10 border border-red-900/40 hover:border-red-500 text-red-400 rounded transition-colors">
                    Remove
                  </button>
                  <button @click="removeFromPlaylist(m)" :disabled="loading"
                    class="px-2 py-1 text-[10px] bg-red-500/10 border border-red-900/40 hover:border-red-500 hover:bg-red-500/20 text-red-400 rounded transition-colors">
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!filtered.length && matches.length" class="flex flex-col items-center justify-center py-16 text-slate-500 gap-2">
          <span class="text-3xl">🔍</span><p class="text-xs">No channels match your filter</p>
        </div>
        </div>
      </div>
    </template>

    <!-- ── TMDB MATCHES TAB ──────────────────────────────────────────────────── -->
    <template v-else-if="tab === 'tmdb'">
      <!-- TMDB Enrich Button & Stats -->
      <div class="flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-[#2e3250] shrink-0">
        <button
          @click="triggerEnrich"
          :disabled="enriching || !enrichStatus?.guideExists || !enrichStatus?.tmdbKeySet"
          :title="!enrichStatus?.tmdbKeySet ? 'Add TMDB_API_KEY to .env to enable' : !enrichStatus?.guideExists ? 'Run an EPG grab first' : 'Enrich guide.xml with TMDB posters & descriptions for mapped channels'"
          class="flex items-center gap-1.5 px-4 py-2 text-xs bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors shrink-0">
          <span v-if="enriching" class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
          {{ enriching ? 'Enriching…' : '🎥 Run TMDB Enrich' }}
        </button>

        <!-- Stats Badges -->
        <button
          @click="tmdbFilterStatus = tmdbFilterStatus === 'matched' ? 'all' : 'matched'; loadTmdbTitles()"
          :class="['flex items-center gap-2 px-2 py-1 rounded-lg border transition-colors cursor-pointer',
            tmdbFilterStatus === 'matched'
              ? 'bg-green-500/20 border-green-500/40'
              : 'bg-green-500/10 border-green-500/20 hover:bg-green-500/15']">
          <span class="text-[10px] text-green-400">✓ Matched</span>
          <span class="text-xs font-bold text-green-300">{{ tmdbStats.matched }}</span>
        </button>
        <button
          @click="tmdbFilterStatus = tmdbFilterStatus === 'unmatched' ? 'all' : 'unmatched'; loadTmdbTitles()"
          :class="['flex items-center gap-2 px-2 py-1 rounded-lg border transition-colors cursor-pointer',
            tmdbFilterStatus === 'unmatched'
              ? 'bg-slate-500/20 border-slate-500/40'
              : 'bg-slate-500/10 border-slate-500/20 hover:bg-slate-500/15']">
          <span class="text-[10px] text-slate-400">⭕ Unmatched</span>
          <span class="text-xs font-bold text-slate-300">{{ tmdbStats.unmatched }}</span>
        </button>
        <button
          @click="tmdbFilterStatus = tmdbFilterStatus === 'not_found' ? 'all' : 'not_found'; loadTmdbTitles()"
          :class="['flex items-center gap-2 px-2 py-1 rounded-lg border transition-colors cursor-pointer',
            tmdbFilterStatus === 'not_found'
              ? 'bg-red-500/20 border-red-500/40'
              : 'bg-red-500/10 border-red-500/20 hover:bg-red-500/15']">
          <span class="text-[10px] text-red-400">⚠ Not Found</span>
          <span class="text-xs font-bold text-red-300">{{ tmdbStats.not_found }}</span>
        </button>
        <button
          @click="tmdbFilterStatus = tmdbFilterStatus === 'blocked' ? 'all' : 'blocked'; loadTmdbTitles()"
          :class="['flex items-center gap-2 px-2 py-1 rounded-lg border transition-colors cursor-pointer',
            tmdbFilterStatus === 'blocked'
              ? 'bg-amber-500/20 border-amber-500/40'
              : 'bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15']">
          <span class="text-[10px] text-amber-400">🚫 Blocked</span>
          <span class="text-xs font-bold text-amber-300">{{ tmdbStats.blocked }}</span>
        </button>

        <!-- Status Message -->
        <div v-if="enriching || enrichStatus?.lastRun || enrichStatus?.lastError" class="flex items-center gap-2 flex-1 ml-2">
          <span v-if="enriching" class="w-3 h-3 border-2 border-violet-400/30 border-t-violet-400 rounded-full animate-spin shrink-0"></span>
          <span v-else-if="enrichStatus?.lastError" class="text-red-400 shrink-0">✗</span>
          <span v-else class="text-violet-400 shrink-0">★</span>
          <p class="text-[10px] font-medium flex-1 truncate" :class="enrichStatus?.lastError ? 'text-red-300' : 'text-violet-300'">
            <template v-if="enriching">{{ enrichStatus?.log?.length ? enrichStatus.log[enrichStatus.log.length - 1] : 'In progress…' }}</template>
            <template v-else-if="enrichStatus?.lastError">{{ enrichStatus.lastError }}</template>
            <template v-else>{{ enrichStatus?.enriched }} programmes · {{ enrichStatus?.lastRun ? new Date(enrichStatus.lastRun).toLocaleString() : '' }}</template>
          </p>
        </div>
        <div v-else-if="enrichStatus && !enrichStatus.tmdbKeySet" class="flex-1 ml-2">
          <span class="text-[10px] text-slate-500">Add TMDB_API_KEY to .env to enable</span>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-[#2e3250] shrink-0">
        <select v-model="selectedPl" @change="loadTmdbTitles"
          class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
          <option value="" disabled>Select playlist…</option>
          <option v-for="p in playlists.filter(p => p.playlist_type !== 'vod')" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
        </select>

        <select v-model="tmdbFilterStatus"
          class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
          <option value="all">All Status</option>
          <option value="matched">Matched</option>
          <option value="unmatched">Unmatched</option>
          <option value="not_found">Not Found</option>
          <option value="blocked">Blocked</option>
        </select>

        <select v-model="tmdbSortBy"
          class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
          <option value="title">Sort: Title (A-Z)</option>
          <option value="count">Sort: Programme Count</option>
          <option value="date">Sort: Last Fetched</option>
        </select>

        <input v-model="tmdbSearchQuery" placeholder="Search titles..."
          class="flex-1 px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
      </div>

      <!-- Title List -->
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <div v-if="tmdbLoading" class="flex items-center justify-center py-12">
          <span class="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
        </div>

        <div v-else-if="!tmdbSortedTitles.length" class="text-center py-12 text-slate-600">
          <p class="text-sm">{{ selectedPl ? 'No titles found' : 'Select a playlist to view titles' }}</p>
          <p class="text-xs text-slate-700 mt-2">Debug: tmdbTitles.length = {{ tmdbTitles.length }}, selectedPl = {{ selectedPl }}</p>
        </div>

        <div v-else class="space-y-2">
          <div v-for="title in tmdbSortedTitles" :key="title.title"
            @click="openTmdbEditModal(title)"
            class="flex items-center gap-4 p-4 bg-[#1a1d27] border border-[#2e3250] rounded-xl hover:border-indigo-500/50 cursor-pointer transition-colors">

            <!-- Poster -->
            <div class="w-16 h-24 shrink-0 rounded-lg overflow-hidden bg-[#22263a] flex items-center justify-center">
              <img v-if="title.poster" :src="title.poster" class="w-full h-full object-cover" />
              <span v-else class="text-2xl text-slate-600">🎬</span>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <h3 class="text-sm font-semibold text-slate-100 truncate">{{ decodeHtmlEntities(title.title) }}</h3>
                <span :class="['text-[9px] px-2 py-0.5 rounded-full border', getTmdbStatusBadge(title.status).class]">
                  {{ getTmdbStatusBadge(title.status).icon }} {{ getTmdbStatusBadge(title.status).label }}
                </span>
                <span v-if="title.manual_override" class="text-[9px] px-2 py-0.5 rounded-full border bg-purple-500/20 text-purple-400 border-purple-500/30">
                  ✏️ Manual
                </span>
              </div>

              <div class="flex items-center gap-3 text-xs text-slate-500">
                <span>{{ title.programme_count }} programme{{ title.programme_count !== 1 ? 's' : '' }}</span>
                <span v-if="title.runtime_minutes" class="text-amber-400">• {{ title.runtime_minutes }} min</span>
                <span v-if="title.episode_info" class="text-cyan-400">• {{ title.episode_info }}</span>
                <span v-if="title.media_type">• {{ title.media_type === 'tv' ? 'TV Show' : 'Movie' }}</span>
                <span v-if="title.tmdb_id">• TMDB ID: {{ title.tmdb_id }}</span>
                <span v-if="title.episode_count">• {{ title.episode_count }} episodes</span>
                <span v-if="title.fetched_at">• {{ new Date(title.fetched_at).toLocaleDateString() }}</span>
              </div>

              <div v-if="title.channels && title.channels.length" class="flex flex-wrap gap-1 mt-2">
                <span v-for="(ch, idx) in title.channels" :key="idx"
                  class="text-[10px] px-2 py-0.5 rounded bg-slate-500/10 border border-slate-500/20 text-slate-400">
                  {{ ch.name }} : {{ ch.group }}
                </span>
              </div>

              <p v-if="title.description" class="text-xs text-slate-600 mt-1 line-clamp-2">{{ title.description }}</p>
            </div>

            <!-- Arrow -->
            <div class="shrink-0 text-slate-600">→</div>
          </div>
        </div>
      </div>
    </template>

    <!-- EPG Search / Edit modal -->
    <Teleport to="body">
      <div v-if="editRow" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
          <div class="flex items-center gap-3 px-5 py-4 border-b border-[#2e3250] shrink-0">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-bold text-slate-100 truncate">{{ editRow.tvg_name }}</p>
              <p class="text-[10px] font-mono text-slate-500 truncate">{{ editRow.tvg_id }}</p>
            </div>
            <button @click="closeEdit" class="text-slate-500 hover:text-slate-300 text-xl leading-none shrink-0">✕</button>
          </div>

          <!-- Search bar + source filter -->
          <div class="flex gap-2 px-5 py-3 border-b border-[#2e3250] shrink-0">
            <input
              v-model="editSearch"
              @input="onEditSearchInput"
              placeholder="Search EPG channels…"
              class="flex-1 bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500"
              autofocus
            />
            <select v-if="epgSources.length > 1" v-model="selectedEpgSource" @change="searchEpg(editSearch)"
              class="bg-[#22263a] border border-[#2e3250] rounded-lg px-2 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500 shrink-0">
              <option value="">All sources</option>
              <option v-for="s in epgSources" :key="s.id" :value="String(s.id)">{{ s.name }}</option>
            </select>
          </div>

          <!-- Results -->
          <div class="flex-1 overflow-y-auto">
            <div v-if="editSearching" class="flex items-center justify-center py-10 text-slate-500 gap-2">
              <span class="w-4 h-4 border-2 border-indigo-500/30 border-t-indigo-400 rounded-full animate-spin"></span>
              <span class="text-xs">Searching…</span>
            </div>
            <div v-else-if="!editResults.length && editSearch" class="text-center py-10 text-slate-600 text-xs">No EPG channels found</div>
            <div v-else-if="!editSearch" class="text-center py-10 text-slate-600 text-xs">Type to search EPG channels</div>
            <div v-else class="divide-y divide-[#2e3250]/40">
              <button v-for="ch in editResults" :key="ch.id"
                @click="pickEpgChannel(ch)"
                class="w-full flex items-center gap-3 px-5 py-3 hover:bg-[#22263a] transition-colors text-left">
                <img v-if="ch.icon" :src="ch.icon" class="w-7 h-7 object-contain rounded shrink-0" @error="e => e.target.style.display='none'" />
                <div v-else class="w-7 h-7 rounded bg-[#22263a] shrink-0"></div>
                <div class="flex-1 min-w-0">
                  <p class="text-sm text-slate-200 truncate">{{ ch.name }}</p>
                  <p class="text-[10px] font-mono text-slate-500 truncate">{{ ch.id }}</p>
                </div>
                <span class="text-[10px] text-slate-600 shrink-0">{{ ch.source_name }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- EPG Viewer slide-out panel -->
    <Teleport to="body">
      <Transition name="epg-slide">
      <div v-if="epgViewer" class="fixed inset-0 z-50 flex justify-end" @click.self="closeEpgViewer">
        <div class="w-full max-w-lg h-full bg-[#13151f] border-l border-[#2e3250] flex flex-col shadow-2xl">

          <!-- Header -->
          <div class="flex items-center gap-3 px-5 py-4 border-b border-[#2e3250] shrink-0 bg-[#1a1d27]">
            <div class="flex-1 min-w-0">
              <p class="text-sm font-bold text-slate-100 truncate">{{ epgViewer.channelName }}</p>
              <p class="text-[10px] font-mono text-slate-500">{{ epgViewer.channelId }}</p>
            </div>
            <button @click="closeEpgViewer" class="text-slate-500 hover:text-slate-300 text-xl leading-none shrink-0">✕</button>
          </div>

          <!-- Loading -->
          <div v-if="epgLoading" class="flex-1 flex items-center justify-center gap-3 text-slate-500">
            <span class="w-6 h-6 border-2 border-violet-500/30 border-t-violet-400 rounded-full animate-spin"></span>
            <span class="text-sm">Loading guide…</span>
          </div>

          <!-- Error -->
          <div v-else-if="epgError" class="flex-1 flex items-center justify-center">
            <p class="text-sm text-red-400">⚠ {{ epgError }}</p>
          </div>

          <!-- Empty -->
          <div v-else-if="!epgProgrammes.length" class="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
            <span class="text-4xl">📭</span>
            <p class="text-sm">No programme data for this channel</p>
            <p class="text-xs text-slate-600">Run an EPG grab to populate guide.xml</p>
          </div>

          <!-- Programme list -->
          <div v-else class="flex-1 overflow-y-auto">
            <div v-for="group in epgByDate" :key="group.date">
              <!-- Date header -->
              <div class="sticky top-0 px-5 py-2 bg-[#0f1119]/95 backdrop-blur-sm border-b border-[#2e3250] z-10">
                <span class="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{{ group.date }}</span>
              </div>

              <!-- Programme rows -->
              <div v-for="prog in group.items" :key="prog.start"
                :class="['flex gap-3 px-4 py-3 border-b border-[#2e3250]/40 transition-colors',
                  isNowPlaying(prog) ? 'bg-violet-500/8 border-l-2 border-l-violet-500' : 'hover:bg-[#1a1d27]']">

                <!-- Poster -->
                <div class="shrink-0 w-14 h-20 rounded-lg overflow-hidden bg-[#22263a] flex items-center justify-center">
                  <img v-if="prog.icon" :src="prog.icon" class="w-full h-full object-cover"
                    @error="e => e.target.parentElement.innerHTML = '<span class=\'text-slate-700 text-xl\'>🎬</span>'" />
                  <span v-else class="text-slate-700 text-xl">🎬</span>
                </div>

                <!-- Info -->
                <div class="flex-1 min-w-0">
                  <div class="flex items-start justify-between gap-2">
                    <p class="text-sm font-semibold text-slate-100 leading-tight">{{ prog.title }}</p>
                    <span v-if="isNowPlaying(prog)" class="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/40 text-violet-300 font-semibold">NOW</span>
                  </div>
                  <p class="text-[11px] text-slate-500 mt-0.5">
                    {{ formatTime(prog.start) }} – {{ formatTime(prog.stop) }}
                    <span v-if="prog.category" class="ml-2 text-slate-600">· {{ prog.category }}</span>
                  </p>
                  <p v-if="prog.episode" class="text-[10px] font-mono text-slate-600 mt-0.5">{{ prog.episode }}</p>
                  <p v-if="prog.desc" class="text-[11px] text-slate-400 mt-1.5 leading-relaxed line-clamp-3">{{ prog.desc }}</p>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
      </Transition>
    </Teleport>

    <!-- Manual form modal -->
    <Teleport to="body">
      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md shadow-2xl p-6">
          <h2 class="text-sm font-bold text-slate-100 mb-4">Add EPG Mapping</h2>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-slate-500 mb-1">Source tvg-id</label>
              <input v-model="form.source_tvg_id" placeholder="e.g. BBC1.uk" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-500 mb-1">Target tvg-id</label>
              <input v-model="form.target_tvg_id" placeholder="e.g. BBC1.uk" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-500 mb-1">Note (optional)</label>
              <input v-model="form.note" placeholder="e.g. Fixed wrong EPG ID" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>
          </div>
          <div class="flex gap-3 mt-5">
            <button @click="showForm = false" class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors">Cancel</button>
            <button @click="saveManual" :disabled="loading || !form.source_tvg_id || !form.target_tvg_id"
              class="flex-1 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors">
              {{ loading ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- TMDB Match Modal -->
    <TmdbMatchModal
      v-if="tmdbShowModal"
      :title="tmdbEditingTitle"
      @close="closeTmdbModal"
      @save="handleTmdbSave"
    />

  </div>
</template>

<style scoped>
.epg-slide-enter-active,
.epg-slide-leave-active {
  transition: transform 0.25s ease;
}
.epg-slide-enter-from,
.epg-slide-leave-to {
  transform: translateX(100%);
}
</style>
