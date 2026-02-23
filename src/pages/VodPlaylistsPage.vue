<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../composables/useApi.js'

const playlists  = ref([])
const sources    = ref([])
const loading    = ref(false)
const error      = ref('')
const copied     = ref(null)

// Create/edit form
const showForm   = ref(false)
const editing    = ref(null)
const form       = ref({ name: '', source_id: '' })

// Group picker
const showPicker = ref(null)  // playlist object being configured
const allGroups  = ref([])
const selGroups  = ref(new Set())
const groupSearch = ref('')
const saving     = ref(false)

const filteredGroups = computed(() => {
  const q = groupSearch.value.toLowerCase()
  return q ? allGroups.value.filter(g => g.group_title.toLowerCase().includes(q)) : allGroups.value
})

async function load() {
  loading.value = true
  const all = await api.getPlaylists()
  playlists.value = all.filter(p => p.playlist_type === 'vod')
  sources.value   = (await api.getSources()).filter(s => s.type === 'm3u' || s.type === 'xtream')
  loading.value   = false
}

function openCreate() {
  editing.value  = null
  form.value     = { name: '', source_id: sources.value[0]?.id || '' }
  showForm.value = true
}

function openEdit(p) {
  editing.value  = p
  form.value     = { name: p.name, source_id: p.source_id || '' }
  showForm.value = true
}

async function save() {
  if (!form.value.name) return
  loading.value = true
  error.value   = ''
  try {
    if (editing.value) {
      await fetch(`/api/playlists/${editing.value.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form.value, playlist_type: 'vod', source_id: form.value.source_id || null }),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error) }) })
    } else {
      await fetch('/api/playlists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form.value, playlist_type: 'vod', source_id: form.value.source_id || null }),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error) }) })
    }
    showForm.value = false
    await load()
  } catch (e) { error.value = e.message } finally { loading.value = false }
}

async function remove(p) {
  if (!confirm(`Delete VOD playlist "${p.name}"?`)) return
  await fetch(`/api/playlists/${p.id}`, { method: 'DELETE' })
  await load()
}

// ── Group picker ──────────────────────────────────────────────────────────────
async function openPicker(p) {
  showPicker.value = p
  allGroups.value  = []
  selGroups.value  = new Set()
  groupSearch.value = ''
  if (!p.source_id) return

  // Load all groups from source
  const groups = await fetch(`/api/sources/${p.source_id}/vod-groups`).then(r => r.json())
  allGroups.value = groups

  // Load currently selected groups from existing playlist channels
  const existing = await fetch(`/api/playlists/${p.id}/channels`).then(r => r.json())
  const existingGroups = new Set(existing.map(c => c.group_title).filter(Boolean))
  selGroups.value = existingGroups
}

function toggleGroup(g) {
  const s = new Set(selGroups.value)
  s.has(g) ? s.delete(g) : s.add(g)
  selGroups.value = s
}

function selectAllVisible() {
  const s = new Set(selGroups.value)
  for (const g of filteredGroups.value) s.add(g.group_title)
  selGroups.value = s
}

function clearAllVisible() {
  const s = new Set(selGroups.value)
  for (const g of filteredGroups.value) s.delete(g.group_title)
  selGroups.value = s
}

async function applyGroups() {
  if (!showPicker.value) return
  saving.value = true
  error.value  = ''
  try {
    const p = showPicker.value
    const groups = [...selGroups.value]

    // Fetch all channels for selected groups (paginated)
    let channels = []
    const pageSize = 1000
    let offset = 0
    while (true) {
      const batch = await fetch(
        `/api/sources/${p.source_id}/vod-channels?groups=${encodeURIComponent(groups.join(','))}&limit=${pageSize}&offset=${offset}`
      ).then(r => r.json())
      channels.push(...batch)
      if (batch.length < pageSize) break
      offset += pageSize
    }

    // Save to playlist_channels
    await fetch(`/api/playlists/${p.id}/channels`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: channels.map((ch, i) => ({
        tvg_id:      ch.tvg_id || '',
        tvg_name:    ch.tvg_name,
        tvg_logo:    ch.tvg_logo || '',
        group_title: ch.group_title || '',
        url:         ch.url,
        raw_extinf:  ch.raw_extinf || '',
        sort_order:  i,
        source_id:   p.source_id,
      })) }),
    })

    showPicker.value = null
    await load()
  } catch (e) { error.value = e.message } finally { saving.value = false }
}

function copyUrl(url, key) {
  // Check if navigator.clipboard is available (client-side only)
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(url)
    copied.value = key
    setTimeout(() => { copied.value = null }, 2000)
  }
}

function m3uUrl(p) {
  // Check if window is defined (client-side only)
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005'
  return `${baseUrl}/api/playlists/${p.id}/m3u`
}

const selectedGroupCount = computed(() => selGroups.value.size)
const selectedChannelCount = computed(() => {
  return allGroups.value
    .filter(g => selGroups.value.has(g.group_title))
    .reduce((sum, g) => sum + g.count, 0)
})

onMounted(load)
</script>

<template>
  <div class="p-3 sm:p-6 max-w-6xl mx-auto">

    <div class="flex items-center justify-between gap-3 mb-5 flex-wrap">
      <div>
        <h1 class="text-lg font-bold text-slate-100">VOD Playlists</h1>
        <p class="text-xs text-slate-500 mt-0.5">Select groups from your sources to build VOD playlists for Xtream Codes</p>
      </div>
      <button @click="openCreate"
        class="px-4 py-2 text-sm bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-xl transition-colors shrink-0">
        + New VOD Playlist
      </button>
    </div>

    <p v-if="error" class="text-xs text-red-400 mb-4">⚠ {{ error }}</p>

    <!-- Empty state -->
    <div v-if="!loading && !playlists.length" class="flex flex-col items-center justify-center py-20 text-slate-500 gap-3">
      <span class="text-4xl">🎬</span>
      <p class="text-sm">No VOD playlists yet</p>
      <button @click="openCreate" class="px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg">
        Create one
      </button>
    </div>

    <!-- Playlist cards -->
    <div class="space-y-3">
      <div v-for="p in playlists" :key="p.id"
        class="bg-[#1a1d27] border border-[#2e3250] rounded-xl p-4">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold text-slate-100">{{ p.name }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/30 text-purple-300">VOD</span>
              <span class="text-[10px] text-slate-500">{{ (p.channel_count || 0).toLocaleString() }} channels</span>
            </div>
            <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <code class="font-mono text-[10px] text-slate-500 truncate max-w-xs">{{ m3uUrl(p) }}</code>
              <a :href="m3uUrl(p)" target="_blank"
                class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border bg-[#22263a] border-[#2e3250] text-slate-500 hover:text-blue-400 hover:border-blue-500 transition-colors">
                🔗 Open M3U
              </a>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button @click="openPicker(p)" :disabled="!p.source_id"
              class="px-3 py-1.5 text-xs bg-purple-500/15 border border-purple-500/30 hover:border-purple-400 text-purple-300 rounded-lg transition-colors disabled:opacity-40">
              📂 Select Groups
            </button>
            <button @click="openEdit(p)"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-slate-500 text-slate-400 rounded-lg transition-colors">
              Edit
            </button>
            <button @click="remove(p)"
              class="px-3 py-1.5 text-xs bg-red-500/10 border border-red-900/40 hover:border-red-500 text-red-400 rounded-lg transition-colors">
              Delete
            </button>
          </div>
        </div>
        <div v-if="p.group_names?.length" class="flex flex-wrap gap-1 mt-2">
          <span v-for="g in p.group_names" :key="g"
            class="text-[10px] px-1.5 py-0.5 rounded bg-[#2e3250] text-slate-400">{{ g }}</span>
          <span v-if="p.group_count > 5" class="text-[10px] px-1.5 py-0.5 rounded bg-[#2e3250] text-slate-500">
            +{{ p.group_count - 5 }} more
          </span>
        </div>
        <p v-else-if="!p.source_id" class="text-[10px] text-amber-400 mt-2">⚠ No source assigned — edit to add one</p>
        <p v-else class="text-[10px] text-slate-600 mt-2">No groups selected yet — click "Select Groups"</p>
      </div>
    </div>

    <!-- Create/Edit modal -->
    <div v-if="showForm" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h2 class="text-sm font-bold text-slate-100 mb-4">{{ editing ? 'Edit' : 'New' }} VOD Playlist</h2>
        <div class="space-y-3">
          <div>
            <label class="text-xs text-slate-400 block mb-1">Name</label>
            <input v-model="form.name" placeholder="My VOD" @keyup.enter="save"
              class="w-full bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label class="text-xs text-slate-400 block mb-1">Source</label>
            <select v-model="form.source_id"
              class="w-full bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500">
              <option value="">— none —</option>
              <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
        </div>
        <div class="flex gap-2 mt-5">
          <button @click="save" :disabled="loading || !form.name"
            class="flex-1 py-2 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors">
            {{ loading ? 'Saving…' : 'Save' }}
          </button>
          <button @click="showForm = false"
            class="px-4 py-2 text-sm bg-[#22263a] border border-[#2e3250] text-slate-400 rounded-lg hover:text-slate-200 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>

    <!-- Group picker modal -->
    <div v-if="showPicker" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[85vh]">
        <div class="p-5 border-b border-[#2e3250] shrink-0">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-sm font-bold text-slate-100">Select Groups — {{ showPicker.name }}</h2>
            <div class="text-xs text-slate-400">
              <span class="text-indigo-300 font-semibold">{{ selectedGroupCount }}</span> groups ·
              <span class="text-purple-300 font-semibold">{{ selectedChannelCount.toLocaleString() }}</span> channels
            </div>
          </div>
          <div class="flex items-center gap-2">
            <input v-model="groupSearch" placeholder="Filter groups…"
              class="flex-1 bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-1.5 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500" />
            <button @click="selectAllVisible"
              class="px-2 py-1.5 text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 rounded-lg hover:border-indigo-400 transition-colors">
              All
            </button>
            <button @click="clearAllVisible"
              class="px-2 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] text-slate-400 rounded-lg hover:border-slate-500 transition-colors">
              None
            </button>
          </div>
        </div>

        <div class="overflow-y-auto flex-1 p-3">
          <div v-if="!allGroups.length" class="text-center py-8 text-slate-500 text-xs">Loading groups…</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
            <label v-for="g in filteredGroups" :key="g.group_title"
              :class="['flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors',
                selGroups.has(g.group_title) ? 'bg-indigo-500/15 border border-indigo-500/30' : 'hover:bg-[#22263a] border border-transparent']">
              <input type="checkbox" :checked="selGroups.has(g.group_title)"
                @change="toggleGroup(g.group_title)" class="accent-indigo-500 shrink-0" />
              <span class="text-xs text-slate-200 truncate flex-1">{{ g.group_title }}</span>
              <span class="text-[10px] text-slate-500 shrink-0">{{ g.count.toLocaleString() }}</span>
            </label>
          </div>
        </div>

        <div class="p-4 border-t border-[#2e3250] flex gap-2 shrink-0">
          <button @click="applyGroups" :disabled="saving || !selectedGroupCount"
            class="flex-1 py-2 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors">
            {{ saving ? 'Saving…' : `Apply — ${selectedChannelCount.toLocaleString()} channels` }}
          </button>
          <button @click="showPicker = null"
            class="px-4 py-2 text-sm bg-[#22263a] border border-[#2e3250] text-slate-400 rounded-lg hover:text-slate-200 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>

  </div>
</template>
