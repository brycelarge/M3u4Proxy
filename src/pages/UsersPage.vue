<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../composables/useApi.js'

const users       = ref([])
const playlists   = ref([])
const loading     = ref(false)
const error       = ref('')
const showForm    = ref(false)
const editing     = ref(null)
const copied      = ref(null)
const serverInfo  = ref(null)
const activeSessions = ref([])
const showConnInfo   = ref(null)  // user object for connection info modal
const showHistory    = ref(null)  // user object for history modal
const history        = ref([])
const historyLoading = ref(false)

const emptyForm = () => ({
  username: '', password: '', playlist_ids: [], vod_playlist_ids: [], max_connections: 1,
  expires_at: '3000-01-01', active: true, notes: '',
})
const form = ref(emptyForm())

async function load() {
  loading.value = true
  error.value   = ''
  const [u, p, s, sess] = await Promise.allSettled([
    fetch('/api/users').then(r => r.json()),
    fetch('/api/playlists').then(r => r.json()),
    fetch('/api/xtream/server').then(r => r.json()),
    fetch('/api/streams').then(r => r.json()),
  ])
  if (u.status === 'fulfilled' && Array.isArray(u.value)) users.value = u.value
  if (p.status === 'fulfilled' && Array.isArray(p.value)) playlists.value = p.value
  if (s.status === 'fulfilled') serverInfo.value = s.value
  if (sess.status === 'fulfilled' && Array.isArray(sess.value)) activeSessions.value = sess.value
  loading.value = false
}

function activeStreamsFor(username) {
  return activeSessions.value.filter(s => s.username === username).length
}

async function openHistory(u) {
  showHistory.value = u
  historyLoading.value = true
  history.value = []
  try {
    history.value = await fetch(`/api/stream-history?username=${encodeURIComponent(u.username)}&limit=50`).then(r => r.json())
  } finally {
    historyLoading.value = false
  }
}

function generatePassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%'
  form.value.password = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function expiresInDays(u) {
  if (!u.expires_at || isNeverExpires(u.expires_at)) return null
  return Math.ceil((new Date(u.expires_at) - new Date()) / 86400000)
}

function xtreamConnInfo(u) {
  if (!serverInfo.value) return null
  const base = serverInfo.value.lan_base || serverInfo.value.player_api.replace('/xtream/player_api.php', '')
  return {
    server:   base,
    username: u.username,
    m3u:      `${base}/xtream/get.php?username=${encodeURIComponent(u.username)}&password=***&type=m3u_plus&output=ts`,
    api:      `${base}/xtream/player_api.php`,
    xmltv:    `${base}/xtream/xmltv.php?username=${encodeURIComponent(u.username)}&password=***`,
  }
}

function openCreate() {
  editing.value = null
  form.value    = emptyForm()
  showForm.value = true
}

function openEdit(u) {
  editing.value = u

  // Parse playlist_ids from JSON, or migrate from old playlist_id
  let liveIds = []
  try {
    liveIds = JSON.parse(u.playlist_ids || '[]')
  } catch {
    if (u.playlist_id) {
      liveIds = [u.playlist_id]
    }
  }

  // Parse vod_playlist_ids from JSON, or migrate from old vod_playlist_id
  let vodIds = []
  try {
    vodIds = JSON.parse(u.vod_playlist_ids || '[]')
  } catch {
    if (u.vod_playlist_id) {
      vodIds = [u.vod_playlist_id]
    }
  }

  form.value = {
    username:          u.username,
    password:          '',
    playlist_ids:      liveIds,
    vod_playlist_ids:  vodIds,
    max_connections:   u.max_connections,
    expires_at:        u.expires_at ? u.expires_at.slice(0, 10) : '3000-01-01',
    active:            !!u.active,
    notes:             u.notes || '',
  }
  showForm.value = true
}

async function save() {
  loading.value = true
  error.value   = ''
  try {
    const payload = {
      ...form.value,
      playlist_id:     form.value.playlist_id ? Number(form.value.playlist_id) : null,
      max_connections: Number(form.value.max_connections) || 1,
      expires_at:      form.value.expires_at || null,
    }
    if (editing.value) {
      await fetch(`/api/users/${editing.value.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error) }) })
    } else {
      await fetch('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error) }) })
    }
    showForm.value = false
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function remove(u) {
  if (!confirm(`Delete user "${u.username}"?`)) return
  await fetch(`/api/users/${u.id}`, { method: 'DELETE' })
  await load()
}

async function toggleActive(u) {
  await fetch(`/api/users/${u.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username:        u.username,
      password:        u.password,
      playlist_id:     u.playlist_id || null,
      max_connections: u.max_connections,
      expires_at:      u.expires_at || '3000-01-01',
      active:          !u.active,
      notes:           u.notes || null,
    }),
  })
  await load()
}

function copyText(text, key) {
  navigator.clipboard.writeText(text)
  copied.value = key
  setTimeout(() => { copied.value = null }, 2000)
}

function xtreamUrl(u) {
  if (!serverInfo.value) return ''
  const base = serverInfo.value.player_api.replace('/xtream/player_api.php', '')
  return `${base}/xtream/get.php?username=${encodeURIComponent(u.username)}&password=${encodeURIComponent(u.password)}&type=m3u_plus&output=ts`
}

function relativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)   return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60)   return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)   return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30)   return `${d}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function isNeverExpires(dateStr) {
  return !dateStr || dateStr.startsWith('3000')
}
function isExpired(u) {
  return u.expires_at && !isNeverExpires(u.expires_at) && new Date(u.expires_at) < new Date()
}

const activeCount   = computed(() => users.value.filter(u => u.active && !isExpired(u)).length)
const expiredCount  = computed(() => users.value.filter(u => isExpired(u)).length)
const expiringCount = computed(() => users.value.filter(u => { const d = expiresInDays(u); return d !== null && d > 0 && d <= 7 }).length)

onMounted(load)
</script>

<template>
  <div class="p-3 sm:p-6 max-w-6xl mx-auto">

    <!-- Header -->
    <div class="flex items-center justify-between gap-3 mb-5 flex-wrap">
      <div>
        <h1 class="text-lg font-bold text-slate-100">Users</h1>
        <p class="text-xs text-slate-500 mt-0.5">Client portal — each user gets a playlist via Xtream Codes</p>
      </div>
      <button @click="openCreate" class="px-4 py-2 text-sm bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-xl transition-colors shrink-0">
        + New User
      </button>
    </div>

    <p v-if="error" class="text-xs text-red-400 mb-4">⚠ {{ error }}</p>

    <!-- Server info bar -->
    <div v-if="serverInfo" class="mb-5 p-3 bg-[#1a1d27] border border-[#2e3250] rounded-xl text-xs space-y-2">
      <!-- LAN IP — what to use from other devices -->
      <div v-if="serverInfo.lan_base" class="flex flex-wrap items-center gap-2">
        <span class="text-emerald-400 font-semibold shrink-0">📱 Server URL for apps:</span>
        <code class="text-emerald-300 font-mono">{{ serverInfo.lan_base }}</code>
        <button
          @click="copyText(serverInfo.lan_base, 'lan')"
          :class="['shrink-0 px-2 py-1 rounded border transition-colors',
            copied === 'lan' ? 'bg-green-500/20 border-green-500/30 text-green-400' : 'bg-[#22263a] border-[#2e3250] text-slate-400 hover:text-slate-200']"
        >{{ copied === 'lan' ? '✓ Copied' : 'Copy' }}</button>
      </div>
      <!-- Local URL -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-slate-500 shrink-0">Local:</span>
        <code class="text-slate-400 font-mono truncate flex-1 min-w-0">{{ serverInfo.player_api }}</code>
        <button
          @click="copyText(serverInfo.player_api, 'server')"
          :class="['shrink-0 px-2 py-1 rounded border transition-colors',
            copied === 'server' ? 'bg-green-500/20 border-green-500/30 text-green-400' : 'bg-[#22263a] border-[#2e3250] text-slate-400 hover:text-slate-200']"
        >{{ copied === 'server' ? '✓' : 'Copy' }}</button>
      </div>
    </div>

    <!-- Stats row -->
    <div class="flex gap-3 mb-5 flex-wrap">
      <div class="flex items-center gap-2 px-3 py-2 bg-[#1a1d27] border border-[#2e3250] rounded-xl text-xs">
        <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="text-slate-400">Active</span>
        <span class="font-bold text-slate-200">{{ activeCount }}</span>
      </div>
      <div v-if="expiredCount" class="flex items-center gap-2 px-3 py-2 bg-[#1a1d27] border border-red-900/40 rounded-xl text-xs">
        <span class="w-2 h-2 rounded-full bg-red-400"></span>
        <span class="text-slate-400">Expired</span>
        <span class="font-bold text-red-300">{{ expiredCount }}</span>
      </div>
      <div v-if="expiringCount" class="flex items-center gap-2 px-3 py-2 bg-[#1a1d27] border border-amber-900/40 rounded-xl text-xs">
        <span class="w-2 h-2 rounded-full bg-amber-400"></span>
        <span class="text-slate-400">Expiring soon</span>
        <span class="font-bold text-amber-300">{{ expiringCount }}</span>
      </div>
      <div class="flex items-center gap-2 px-3 py-2 bg-[#1a1d27] border border-[#2e3250] rounded-xl text-xs">
        <span class="text-slate-400">Total</span>
        <span class="font-bold text-slate-200">{{ users.length }}</span>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="!users.length && !loading" class="text-center py-16 text-slate-500 bg-[#1a1d27] border border-[#2e3250] rounded-2xl">
      <p class="text-4xl mb-3">👤</p>
      <p class="text-sm font-medium text-slate-400">No users yet</p>
      <p class="text-xs mt-1">Create a user and assign them a playlist to give Xtream Codes access.</p>
    </div>

    <!-- Users table -->
    <div v-else-if="users.length" class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl overflow-hidden">
      <!-- Mobile notice -->
      <div class="md:hidden px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-xs">
        Scroll horizontally to see all content →
      </div>
      <div class="overflow-x-auto w-full" style="-webkit-overflow-scrolling: touch; max-width: 100vw;">
        <table class="w-full text-sm min-w-[900px]">
          <thead>
            <tr class="border-b border-[#2e3250] text-[10px] uppercase tracking-widest text-slate-500">
              <th class="text-left px-4 py-3 font-semibold">User</th>
              <th class="text-left px-3 py-3 font-semibold hidden sm:table-cell">Playlist</th>
              <th class="text-center px-3 py-3 font-semibold">Streams</th>
              <th class="text-left px-3 py-3 font-semibold hidden md:table-cell">Expires</th>
              <th class="text-left px-3 py-3 font-semibold hidden lg:table-cell">Last Seen</th>
              <th class="text-center px-3 py-3 font-semibold">Status</th>
              <th class="text-right px-4 py-3 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="u in users" :key="u.id"
              :class="['border-b border-[#2e3250] last:border-0 transition-colors',
                !u.active || isExpired(u) ? 'opacity-60' : 'hover:bg-[#22263a]/40']"
            >
              <!-- User info -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <p class="font-semibold text-slate-100 text-sm">{{ u.username }}</p>
                  <span v-if="expiresInDays(u) !== null && expiresInDays(u) <= 7 && expiresInDays(u) > 0"
                    class="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30 text-amber-400 font-semibold">
                    Expires in {{ expiresInDays(u) }}d
                  </span>
                </div>
                <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  <button
                    @click="showConnInfo = u"
                    class="text-[10px] px-1.5 py-0.5 rounded border transition-colors bg-indigo-500/10 border-indigo-500/30 text-indigo-400 hover:border-indigo-400"
                  >📋 Connect</button>
                  <button
                    @click="openHistory(u)"
                    class="text-[10px] px-1.5 py-0.5 rounded border transition-colors bg-[#22263a] border-[#2e3250] text-slate-500 hover:text-slate-300"
                  >📜 History</button>
                </div>
                <p v-if="u.notes" class="text-[10px] text-slate-600 mt-0.5 truncate max-w-[180px]">{{ u.notes }}</p>
              </td>

              <!-- Playlist -->
              <td class="px-3 py-3 hidden sm:table-cell">
                <span v-if="u.playlist_name" class="text-xs text-slate-300">{{ u.playlist_name }}</span>
                <span v-else class="text-xs text-slate-600 italic">None assigned</span>
              </td>

              <!-- Active streams / max -->
              <td class="px-3 py-3 text-center">
                <span :class="['text-xs font-semibold', activeStreamsFor(u.username) > 0 ? 'text-emerald-400' : 'text-slate-500']">{{ activeStreamsFor(u.username) }}</span>
                <span class="text-slate-600 text-xs">/{{ u.max_connections }}</span>
              </td>

              <!-- Expires -->
              <td class="px-3 py-3 hidden md:table-cell">
                <span v-if="u.expires_at && !isNeverExpires(u.expires_at)" :class="['text-xs', isExpired(u) ? 'text-red-400' : 'text-slate-400']">
                  {{ isExpired(u) ? '⚠ ' : '' }}{{ new Date(u.expires_at).toLocaleDateString() }}
                </span>
                <span v-else class="text-xs text-slate-600">Never</span>
              </td>

              <!-- Last seen -->
              <td class="px-3 py-3 hidden lg:table-cell">
                <span v-if="u.last_connected_at" class="text-xs text-slate-400" :title="new Date(u.last_connected_at).toLocaleString()">{{ relativeTime(u.last_connected_at) }}</span>
                <span v-else class="text-xs text-slate-600">Never</span>
              </td>

              <!-- Status badge -->
              <td class="px-3 py-3 text-center">
                <button
                  @click="toggleActive(u)"
                  :class="['text-[10px] font-semibold px-2 py-0.5 rounded-full border transition-colors',
                    isExpired(u)
                      ? 'bg-red-500/15 border-red-500/30 text-red-400'
                      : u.active
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400 hover:bg-red-500/15 hover:border-red-500/30 hover:text-red-400'
                        : 'bg-slate-500/15 border-slate-500/30 text-slate-500 hover:bg-emerald-500/15 hover:border-emerald-500/30 hover:text-emerald-400']"
                  :title="isExpired(u) ? 'Expired' : u.active ? 'Click to disable' : 'Click to enable'"
                >
                  {{ isExpired(u) ? 'Expired' : u.active ? 'Active' : 'Disabled' }}
                </button>
              </td>

              <!-- Actions -->
              <td class="px-4 py-3">
                <div class="flex items-center gap-1.5 justify-end">
                  <button
                    @click="openEdit(u)"
                    class="px-2.5 py-1.5 text-xs bg-indigo-500/15 border border-indigo-500/30 rounded-lg hover:border-indigo-400 text-indigo-300 transition-colors"
                    title="Edit"
                  >✏</button>
                  <button
                    @click="remove(u)"
                    class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-red-900/50 rounded-lg hover:border-red-500 text-red-400 transition-colors"
                    title="Delete"
                  >✕</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Connection Info Modal -->
    <Teleport to="body">
      <div v-if="showConnInfo" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" @click.self="showConnInfo = null">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md p-6 shadow-2xl">
          <div class="flex items-center gap-3 mb-5">
            <span class="text-xl">📋</span>
            <h2 class="text-base font-bold">Connection Info — {{ showConnInfo.username }}</h2>
            <button @click="showConnInfo = null" class="ml-auto text-slate-500 hover:text-slate-300 text-xl leading-none">✕</button>
          </div>
          <div v-if="xtreamConnInfo(showConnInfo)" class="space-y-2">
            <div v-for="(val, label) in { 'Server': xtreamConnInfo(showConnInfo).server, 'Username': showConnInfo.username, 'API URL': xtreamConnInfo(showConnInfo).api, 'M3U URL': xtreamConnInfo(showConnInfo).m3u, 'XMLTV': xtreamConnInfo(showConnInfo).xmltv }" :key="label"
              class="flex items-center gap-2 bg-[#22263a] rounded-lg px-3 py-2">
              <span class="text-[10px] uppercase tracking-widest text-slate-500 w-16 shrink-0">{{ label }}</span>
              <span class="flex-1 font-mono text-[10px] text-slate-300 truncate">{{ val }}</span>
              <button @click="copyText(val, 'ci-' + label)" :class="['text-[10px] px-2 py-0.5 rounded border transition-colors shrink-0', copied === 'ci-' + label ? 'bg-green-500/20 border-green-500/30 text-green-400' : 'border-[#3a3f5c] text-slate-500 hover:text-slate-200']">{{ copied === 'ci-' + label ? '✓' : 'Copy' }}</button>
            </div>
          </div>
          <p v-else class="text-xs text-slate-500">Server info not available</p>
        </div>
      </div>
    </Teleport>

    <!-- Stream History Modal -->
    <Teleport to="body">
      <div v-if="showHistory" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" @click.self="showHistory = null">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-2xl p-6 shadow-2xl max-h-[80vh] flex flex-col">
          <div class="flex items-center gap-3 mb-4 shrink-0">
            <span class="text-xl">📜</span>
            <h2 class="text-base font-bold">Stream History — {{ showHistory.username }}</h2>
            <button @click="showHistory = null" class="ml-auto text-slate-500 hover:text-slate-300 text-xl leading-none">✕</button>
          </div>
          <div v-if="historyLoading" class="flex items-center gap-2 text-xs text-slate-500 py-4">
            <span class="w-3 h-3 border-2 border-slate-600 border-t-indigo-400 rounded-full animate-spin"></span> Loading…
          </div>
          <div v-else-if="!history.length" class="text-xs text-slate-600 py-4">No stream history yet for this user.</div>
          <div v-else class="overflow-y-auto flex-1">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-[#1a1d27]">
                <tr class="border-b border-[#2e3250] text-[10px] uppercase tracking-widest text-slate-500">
                  <th class="text-left py-2 pr-3">Channel</th>
                  <th class="text-left py-2 pr-3">Group</th>
                  <th class="text-left py-2 pr-3">Started</th>
                  <th class="text-right py-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="h in history" :key="h.id" class="border-b border-[#2e3250]/50 last:border-0">
                  <td class="py-2 pr-3 text-slate-300">{{ h.tvg_name || '—' }}</td>
                  <td class="py-2 pr-3 text-slate-500 text-[10px]">{{ h.group_title || '—' }}</td>
                  <td class="py-2 pr-3 text-slate-600 text-[10px]">{{ new Date(h.started_at).toLocaleString() }}</td>
                  <td class="py-2 text-right text-slate-400">
                    {{ h.duration_s ? (h.duration_s >= 3600 ? Math.floor(h.duration_s/3600) + 'h ' : '') + Math.floor((h.duration_s%3600)/60) + 'm' : '—' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Form modal -->
    <Teleport to="body">
      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md p-6 shadow-2xl">
          <div class="flex items-center gap-3 mb-5">
            <span class="text-xl">👤</span>
            <h2 class="text-base font-bold">{{ editing ? 'Edit User' : 'New User' }}</h2>
            <button @click="showForm = false" class="ml-auto text-slate-500 hover:text-slate-300 text-xl leading-none">✕</button>
          </div>

          <div class="space-y-3">
            <!-- Username -->
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Username</label>
              <input
                v-model="form.username"
                placeholder="john_doe"
                autocomplete="off"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500"
              />
            </div>

            <!-- Password -->
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">
                Password
                <span v-if="editing" class="text-slate-600 ml-1">(leave blank to keep current)</span>
              </label>
              <div class="flex gap-2">
                <input
                  v-model="form.password"
                  type="text"
                  placeholder="secret123"
                  autocomplete="new-password"
                  class="flex-1 bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="button"
                  @click="generatePassword"
                  title="Generate random password"
                  class="px-3 py-2.5 bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-400 hover:text-slate-200 hover:border-indigo-500 transition-colors text-sm shrink-0"
                >🎲</button>
              </div>
            </div>

            <!-- Live Playlists (Multi-select) -->
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Live Playlists <span class="text-slate-600">(optional, select multiple)</span></label>
              <div class="bg-[#22263a] border border-[#2e3250] rounded-xl p-3 max-h-32 overflow-y-auto">
                <div v-if="!playlists.filter(p => p.playlist_type !== 'vod').length" class="text-xs text-slate-600 text-center py-2">
                  No live playlists available
                </div>
                <label
                  v-for="p in playlists.filter(p => p.playlist_type !== 'vod')"
                  :key="p.id"
                  class="flex items-center gap-2 py-1.5 cursor-pointer hover:text-slate-200 transition-colors"
                >
                  <input
                    type="checkbox"
                    :value="p.id"
                    v-model="form.playlist_ids"
                    class="accent-indigo-500"
                  />
                  <span class="text-sm text-slate-300">{{ p.name }}</span>
                </label>
              </div>
            </div>

            <!-- VOD Playlists (Multi-select) -->
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">VOD Playlists <span class="text-slate-600">(optional, select multiple)</span></label>
              <div class="bg-[#22263a] border border-[#2e3250] rounded-xl p-3 max-h-32 overflow-y-auto">
                <div v-if="!playlists.filter(p => p.playlist_type === 'vod').length" class="text-xs text-slate-600 text-center py-2">
                  No VOD playlists available
                </div>
                <label
                  v-for="p in playlists.filter(p => p.playlist_type === 'vod')"
                  :key="p.id"
                  class="flex items-center gap-2 py-1.5 cursor-pointer hover:text-slate-200 transition-colors"
                >
                  <input
                    type="checkbox"
                    :value="p.id"
                    v-model="form.vod_playlist_ids"
                    class="accent-indigo-500"
                  />
                  <span class="text-sm text-slate-300">{{ p.name }}</span>
                </label>
              </div>
            </div>

            <!-- Max connections + Expires row -->
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-slate-500 mb-1.5">Max Streams</label>
                <input
                  v-model.number="form.max_connections"
                  type="number" min="1" max="99"
                  class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1.5">Expires</label>
                <input
                  v-model="form.expires_at"
                  type="date"
                  min="2024-01-01"
                  max="3000-01-01"
                  class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500"
                />
                <p class="text-[10px] text-slate-600 mt-1">Set to 3000-01-01 for no expiry</p>
              </div>
            </div>

            <!-- Notes -->
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Notes <span class="text-slate-600">(optional)</span></label>
              <input
                v-model="form.notes"
                placeholder="e.g. John's living room TV"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500"
              />
            </div>

            <!-- Active toggle -->
            <div class="flex items-center gap-3 pt-1">
              <button
                type="button"
                @click="form.active = !form.active"
                :class="['relative inline-flex w-10 h-5 rounded-full transition-colors duration-200 shrink-0 focus:outline-none',
                  form.active ? 'bg-indigo-500' : 'bg-slate-700']"
              >
                <span :class="['absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200',
                  form.active ? 'left-5' : 'left-0.5']"></span>
              </button>
              <span class="text-xs text-slate-400">{{ form.active ? 'Active — user can connect' : 'Disabled — access blocked' }}</span>
            </div>
          </div>

          <p v-if="error" class="text-xs text-red-400 mt-3">⚠ {{ error }}</p>

          <div class="flex gap-3 mt-5">
            <button @click="showForm = false" class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors">
              Cancel
            </button>
            <button
              @click="save"
              :disabled="loading || !form.username || (!editing && !form.password)"
              class="flex-1 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
            >
              <span v-if="loading" class="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1.5 align-middle"></span>
              {{ editing ? 'Save Changes' : 'Create User' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>
