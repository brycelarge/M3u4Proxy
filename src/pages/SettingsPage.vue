<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../composables/useApi.js'

const tab         = ref('hdhr')
const playlists   = ref([])
const settings    = ref({})
const hdhrStatus  = ref(null)
const hdhrDevices = ref([])   // legacy per-playlist virtual devices
const saving      = ref(false)
const saved       = ref(false)
const error       = ref('')
const copied      = ref(null)

// ── Multi-device HDHomeRun ────────────────────────────────────────────────────
const virtualDevices  = ref([])
const showDeviceForm  = ref(false)
const editingDevice   = ref(null)
const deviceError     = ref('')
const deviceSaving    = ref(false)
const emptyDevice = () => ({ name: 'M3U Tuner', playlist_id: '', port: 5004, tuner_count: 4, active: true })
const deviceForm  = ref(emptyDevice())

async function loadVirtualDevices() {
  try { virtualDevices.value = await fetch('/api/hdhr/virtual-devices').then(r => r.json()) } catch {}
}

function openCreateDevice() {
  editingDevice.value = null
  deviceForm.value    = emptyDevice()
  deviceError.value   = ''
  showDeviceForm.value = true
}

function openEditDevice(d) {
  editingDevice.value = d
  deviceForm.value = { name: d.name, playlist_id: d.playlist_id || '', port: d.port, tuner_count: d.tuner_count, active: !!d.active }
  deviceError.value   = ''
  showDeviceForm.value = true
}

async function saveDevice() {
  deviceSaving.value = true
  deviceError.value  = ''
  try {
    const payload = { ...deviceForm.value, playlist_id: deviceForm.value.playlist_id ? Number(deviceForm.value.playlist_id) : null, port: Number(deviceForm.value.port), tuner_count: Number(deviceForm.value.tuner_count) }
    const url    = editingDevice.value ? `/api/hdhr/virtual-devices/${editingDevice.value.id}` : '/api/hdhr/virtual-devices'
    const method = editingDevice.value ? 'PUT' : 'POST'
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Save failed')
    showDeviceForm.value = false
    await loadVirtualDevices()
  } catch (e) { deviceError.value = e.message } finally { deviceSaving.value = false }
}

async function deleteDevice(d) {
  if (!confirm(`Delete device "${d.name}" (port ${d.port})?`)) return
  await fetch(`/api/hdhr/virtual-devices/${d.id}`, { method: 'DELETE' })
  await loadVirtualDevices()
}

// Backup & Restore
const restoreFile   = ref(null)
const restoring     = ref(false)
const restoreResult = ref(null)
const restoreError  = ref('')

function onRestoreFile(e) {
  restoreFile.value   = e.target.files[0] || null
  restoreResult.value = null
  restoreError.value  = ''
}

async function doRestore() {
  if (!restoreFile.value) return
  const confirmed = confirm(`This will overwrite ALL current data with the backup "${restoreFile.value.name}". Are you sure?`)
  if (!confirmed) return
  restoring.value     = true
  restoreResult.value = null
  restoreError.value  = ''
  try {
    const buf = await restoreFile.value.arrayBuffer()
    const r   = await fetch('/api/restore', {
      method:  'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body:    buf,
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Restore failed')
    restoreResult.value = data.restored
    restoreFile.value   = null
    await load()
  } catch (e) {
    restoreError.value = e.message
  } finally {
    restoring.value = false
  }
}

// Xtream Codes
const xtreamDevices  = ref([])
const xtreamEdits    = ref({})  // { [id]: { username, password } }
const xtreamSaving   = ref(null)
const xtreamSaved    = ref(null)

async function loadXtream() {
  try {
    const d = await fetch('/api/xtream/devices').then(r => r.json()).catch(() => [])
    xtreamDevices.value = d
    const edits = {}
    for (const dev of d) edits[dev.playlist_id] = { username: dev.username, password: dev.password }
    xtreamEdits.value = edits
  } catch {}
}

async function saveXtreamCreds(id) {
  xtreamSaving.value = id
  try {
    await fetch(`/api/xtream/${id}/credentials`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(xtreamEdits.value[id]),
    })
    xtreamSaved.value = id
    setTimeout(() => { xtreamSaved.value = null }, 2000)
    await loadXtream()
  } catch {} finally {
    xtreamSaving.value = null
  }
}

// Scheduler
const schedules      = ref([])   // [{ id, name, schedule, last_built, channel_count, schedule_valid }]
const scheduleEdits  = ref({})   // { [id]: string }
const scheduleSaving = ref(null) // id currently saving
const scheduleError  = ref({})   // { [id]: string }

const CRON_PRESETS = [
  { label: 'Every 6h',   value: '0 */6 * * *' },
  { label: 'Every 12h',  value: '0 */12 * * *' },
  { label: 'Daily 3am',  value: '0 3 * * *' },
  { label: 'Daily 4am',  value: '0 4 * * *' },
  { label: 'Weekly',     value: '0 4 * * 0' },
  { label: 'Disabled',   value: '' },
]

const form = ref({
  hdhr_device_name:  'M3u4Proxy',
  hdhr_tuner_count:  '4',
  hdhr_playlist_id:  '',
})

async function load() {
  try {
    const [s, p, h, d, sc] = await Promise.all([
      api.getSettings(),
      api.getPlaylists(),
      api.getHdhrStatus(),
      fetch('/api/hdhr/devices').then(r => r.json()).catch(() => []),
      api.getSchedules(),
    ])
    settings.value    = s
    playlists.value   = p
    hdhrStatus.value  = h
    hdhrDevices.value = d
    schedules.value   = sc
    await Promise.all([loadXtream(), loadVirtualDevices()])
    // Init edits from current schedule values
    const edits = {}
    for (const pl of sc) edits[pl.id] = pl.schedule || ''
    scheduleEdits.value = edits
    form.value = {
      hdhr_device_name: s.hdhr_device_name || 'M3u4Prox',
      hdhr_tuner_count: s.hdhr_tuner_count || '4',
      hdhr_playlist_id: s.hdhr_playlist_id || '',
    }
  } catch (e) {
    error.value = e.message
  }
}

async function saveSchedule(id) {
  scheduleSaving.value = id
  scheduleError.value  = { ...scheduleError.value, [id]: '' }
  try {
    await api.saveSchedule(id, scheduleEdits.value[id] || null)
    await load()
  } catch (e) {
    scheduleError.value = { ...scheduleError.value, [id]: e.message }
  } finally {
    scheduleSaving.value = null
  }
}

function scheduleChanged(id) {
  const pl = schedules.value.find(p => p.id === id)
  return (scheduleEdits.value[id] || '') !== (pl?.schedule || '')
}

async function save() {
  saving.value = true
  error.value  = ''
  try {
    await api.saveSettings(form.value)
    saved.value = true
    setTimeout(() => { saved.value = false }, 2500)
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

function copyUrl(url, key) {
  navigator.clipboard.writeText(url)
  if (key) { copied.value = key; setTimeout(() => { copied.value = null }, 2000) }
}

const TABS = [
  { id: 'hdhr',        label: 'HDHomeRun',   icon: '📡' },
  { id: 'xtream',      label: 'Xtream Codes', icon: '📺' },
  { id: 'scheduler',   label: 'Scheduler',    icon: '🕐' },
  { id: 'proxy',       label: 'Proxy',        icon: '⚡' },
  { id: 'backup',      label: 'Backup',       icon: '💾' },
  { id: 'diagnostics',  label: 'Diagnostics',  icon: '🔧' },
  { id: 'architecture', label: 'Architecture', icon: '🗺️' },
]

// ── Proxy settings ───────────────────────────────────────────────────────────
const proxySettings     = ref({ bufferSeconds: 0 })
const proxySaving       = ref(false)
const proxySaved        = ref(false)
const proxyError        = ref('')
const proxyBufferInput  = ref(0)

async function loadProxySettings() {
  try {
    const d = await fetch('/api/proxy-settings').then(r => r.json())
    proxySettings.value    = d
    proxyBufferInput.value = d.bufferSeconds
  } catch {}
}

async function saveProxySettings() {
  proxySaving.value = true
  proxyError.value  = ''
  proxySaved.value  = false
  try {
    const r = await fetch('/api/proxy-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bufferSeconds: proxyBufferInput.value }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error)
    proxySettings.value = d
    proxySaved.value = true
    setTimeout(() => { proxySaved.value = false }, 2500)
  } catch (e) {
    proxyError.value = e.message
  } finally {
    proxySaving.value = false
  }
}

// ── Diagnostics state ────────────────────────────────────────────────────────
const diagIp        = ref(null)
const diagVpn       = ref(null)
const diagSpeed     = ref(null)
const diagRunning   = ref({ ip: false, vpn: false, speed: false })
const diagError     = ref({ ip: null, vpn: null, speed: null })

async function runIpCheck() {
  diagRunning.value.ip = true; diagError.value.ip = null; diagIp.value = null
  try { diagIp.value = await fetch('/api/diagnostics/ip').then(r => r.json()) }
  catch (e) { diagError.value.ip = e.message }
  finally { diagRunning.value.ip = false }
}

async function runVpnCheck() {
  diagRunning.value.vpn = true; diagError.value.vpn = null; diagVpn.value = null
  try { diagVpn.value = await fetch('/api/diagnostics/vpn').then(r => r.json()) }
  catch (e) { diagError.value.vpn = e.message }
  finally { diagRunning.value.vpn = false }
}

async function runSpeedTest() {
  diagRunning.value.speed = true; diagError.value.speed = null; diagSpeed.value = null
  try { diagSpeed.value = await fetch('/api/diagnostics/speedtest').then(r => r.json()) }
  catch (e) { diagError.value.speed = e.message }
  finally { diagRunning.value.speed = false }
}

async function runAll() {
  await Promise.all([runIpCheck(), runVpnCheck()])
  await runSpeedTest()
}

// ── Dead channels ─────────────────────────────────────────────────────────────
const deadChannels     = ref(null)
const deadLoading      = ref(false)
const deadClearing     = ref(false)

async function loadDeadChannels() {
  deadLoading.value = true
  try { deadChannels.value = await fetch('/api/diagnostics/dead-channels').then(r => r.json()) }
  finally { deadLoading.value = false }
}

async function clearDeadChannels() {
  if (!confirm('Clear all dead channel records?')) return
  deadClearing.value = true
  try {
    await fetch('/api/diagnostics/dead-channels', { method: 'DELETE' })
    deadChannels.value = { total: 0, rows: [] }
  } finally { deadClearing.value = false }
}

onMounted(async () => { await load(); await loadProxySettings() })
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">

    <!-- Header + Tabs -->
    <div class="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-[#2e3250] shrink-0 flex-wrap">
      <div class="flex-1 min-w-0">
        <h1 class="text-sm font-bold text-slate-100">Settings</h1>
        <p class="text-xs text-slate-500 mt-0.5">Server configuration and integrations</p>
      </div>
      <!-- Mobile notice -->
      <div class="md:hidden w-full px-4 py-2 mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-xs">
        Scroll horizontally to see all tabs →
      </div>
      <div class="overflow-x-auto w-full md:w-auto pb-2 md:pb-0">
        <div class="flex bg-[#13151f] border border-[#2e3250] rounded-lg p-0.5 shrink-0 min-w-max">
          <button v-for="t in TABS" :key="t.id" @click="tab = t.id"
            :class="['px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap',
              tab === t.id ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'text-slate-400 hover:text-slate-200']">
            {{ t.icon }} {{ t.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
    <p v-if="error" class="text-xs text-red-400">⚠ {{ error }}</p>

    <!-- ── HDHomeRun Tab ── -->
    <template v-if="tab === 'hdhr'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-blue-500/20 text-blue-400 flex items-center justify-center text-lg shrink-0">📡</div>
        <div>
          <h2 class="text-sm font-bold text-slate-100">HDHomeRun Simulation</h2>
          <p class="text-xs text-slate-500">Makes this server appear as a network tuner to Plex, Emby, and Jellyfin</p>
        </div>
      </div>

      <!-- Status URLs -->
      <div v-if="hdhrStatus" class="mb-5 space-y-2">
        <div class="flex items-center gap-2 bg-[#22263a] rounded-xl px-4 py-2.5">
          <span class="text-[10px] uppercase tracking-widest text-slate-500 w-20 shrink-0">Discover</span>
          <span class="flex-1 font-mono text-xs text-slate-300 truncate">{{ hdhrStatus.discoverUrl }}</span>
          <button @click="copyUrl(hdhrStatus.discoverUrl)" class="text-[10px] text-slate-500 hover:text-slate-300 shrink-0 transition-colors">Copy</button>
        </div>
        <div class="flex items-center gap-2 bg-[#22263a] rounded-xl px-4 py-2.5">
          <span class="text-[10px] uppercase tracking-widest text-slate-500 w-20 shrink-0">Lineup</span>
          <span class="flex-1 font-mono text-xs text-slate-300 truncate">{{ hdhrStatus.lineupUrl }}</span>
          <button @click="copyUrl(hdhrStatus.lineupUrl)" class="text-[10px] text-slate-500 hover:text-slate-300 shrink-0 transition-colors">Copy</button>
        </div>
        <p class="text-[10px] text-slate-600 px-1">
          In Plex: Settings → Live TV & DVR → Set Up Plex Tuner → enter your server IP. In Emby/Jellyfin: Live TV → Add Tuner → HDHomeRun → enter the discover URL above.
        </p>
      </div>

      <div class="space-y-4">
        <!-- Device name -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Device Name</label>
          <input
            v-model="form.hdhr_device_name"
            placeholder="M3u4Proxy"
            class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500"
          />
          <p class="text-xs text-slate-600 mt-1">Name shown in Plex/Emby/Jellyfin tuner list</p>
        </div>

        <!-- Tuner count -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Tuner Count</label>
          <input
            v-model="form.hdhr_tuner_count"
            type="number" min="1" max="32"
            class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500"
          />
          <p class="text-xs text-slate-600 mt-1">Max simultaneous streams advertised to clients (set to match your upstream limits)</p>
        </div>

        <!-- Lineup playlist -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Lineup Playlist</label>
          <div class="relative">
            <select
              v-model="form.hdhr_playlist_id"
              class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 pr-8 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500 appearance-none"
            >
              <option value="">— None (lineup will be empty) —</option>
              <option v-for="p in playlists" :key="p.id" :value="String(p.id)">
                {{ p.name }} ({{ (p.channel_count || 0).toLocaleString() }} channels)
              </option>
            </select>
            <span class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-[10px] pointer-events-none">▾</span>
          </div>
          <p class="text-xs text-slate-600 mt-1">Which playlist's channels appear in the HDHomeRun lineup. Channel URLs are proxied through <code class="text-slate-400">/stream/:id</code></p>
        </div>
      </div>
    </div>

    <!-- Virtual HDHomeRun devices — multi-device management -->
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-4">
        <div class="w-9 h-9 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center text-lg shrink-0">📺</div>
        <div class="flex-1">
          <h2 class="text-sm font-bold text-slate-100">Virtual Tuner Devices</h2>
          <p class="text-xs text-slate-500">Each device runs on its own port — add each as a separate tuner in Plex/Emby/Jellyfin</p>
        </div>
        <button @click="openCreateDevice" class="px-3 py-1.5 text-xs bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-lg transition-colors shrink-0">+ Add Device</button>
      </div>
      <div v-if="!virtualDevices.length" class="text-center py-8 text-slate-600 text-sm">No devices yet — click Add Device to create one.</div>
      <div v-else class="space-y-3">
        <div v-for="d in virtualDevices" :key="d.id" :class="['bg-[#13151f] border rounded-xl p-4', d.active ? 'border-[#2e3250]' : 'border-[#2e3250] opacity-55']">
          <div class="flex items-center gap-3 mb-3 flex-wrap">
            <div class="flex-1">
              <p class="text-sm font-semibold text-slate-100">{{ d.name }}</p>
              <p class="text-[10px] text-slate-500 mt-0.5">Port <span class="font-mono text-indigo-300">{{ d.port }}</span> · {{ d.tuner_count }} tuners · {{ d.playlist_name || 'No playlist' }}</p>
            </div>
            <div class="flex items-center gap-2">
              <span :class="['text-[10px] px-2 py-0.5 rounded-full border font-semibold', d.active ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : 'bg-slate-500/15 border-slate-500/30 text-slate-500']">{{ d.active ? 'Active' : 'Off' }}</span>
              <button @click="openEditDevice(d)" class="px-2.5 py-1.5 text-xs bg-indigo-500/15 border border-indigo-500/30 rounded-lg hover:border-indigo-400 text-indigo-300 transition-colors">✏</button>
              <button @click="deleteDevice(d)" class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-red-900/50 rounded-lg hover:border-red-500 text-red-400 transition-colors">✕</button>
            </div>
          </div>
          <div class="space-y-1">
            <div v-for="(entry, idx) in [
              { label: 'Plex',     url: d.plex_url,     hint: 'Enter this IP in Plex DVR setup' },
              { label: 'Discover', url: d.discover_url, hint: 'Emby/Jellyfin HDHomeRun URL' },
              { label: 'Lineup',   url: d.lineup_url },
              { label: 'M3U',      url: d.m3u_url },
              ...(d.xmltv_url ? [{ label: 'XMLTV', url: d.xmltv_url, hint: 'EPG guide URL' }] : []),
            ]" :key="entry.label" class="flex items-center gap-2 bg-[#22263a] rounded-lg px-3 py-1.5">
              <span class="text-[10px] uppercase tracking-widest text-slate-500 w-14 shrink-0">{{ entry.label }}</span>
              <span class="flex-1 font-mono text-[10px] text-slate-400 truncate" :title="entry.hint">{{ entry.url }}</span>
              <span v-if="entry.hint" class="text-[9px] text-slate-600 shrink-0 hidden lg:block">{{ entry.hint }}</span>
              <button @click="copyUrl(entry.url, d.id + entry.label)" :class="['text-[10px] px-2 py-0.5 rounded border transition-colors shrink-0', copied === d.id + entry.label ? 'bg-green-500/20 border-green-500/30 text-green-400' : 'border-[#3a3f5c] text-slate-500 hover:text-slate-200']">{{ copied === d.id + entry.label ? '✓' : 'Copy' }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <!-- Save button for HDHomeRun global settings -->
    <div class="flex items-center gap-3">
      <button @click="save" :disabled="saving" class="px-6 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors">{{ saving ? 'Saving…' : 'Save Settings' }}</button>
      <span v-if="saved" class="text-xs text-green-400">✓ Saved</span>
    </div>
    </template> <!-- end hdhr tab -->

    <!-- ── Xtream Codes Tab ── -->
    <template v-if="tab === 'xtream'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-orange-500/20 text-orange-400 flex items-center justify-center text-lg shrink-0">📡</div>
        <div>
          <h2 class="text-sm font-bold text-slate-100">Xtream Codes API</h2>
          <p class="text-xs text-slate-500">One Xtream endpoint per playlist — compatible with TiviMate, IPTV Smarters, GSE IPTV, Perfect Player</p>
        </div>
      </div>

      <div class="space-y-4">
        <div v-for="dev in xtreamDevices" :key="dev.playlist_id"
          class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">

          <div class="flex items-center gap-3 mb-3">
            <span class="text-sm font-semibold text-slate-100 flex-1">{{ dev.playlist_name }}</span>
            <span v-if="xtreamSaved === dev.playlist_id" class="text-[10px] text-green-400">✓ Saved</span>
          </div>

          <!-- Credentials editor -->
          <div class="flex items-center gap-2 mb-3 flex-wrap">
            <div class="flex items-center gap-1.5">
              <label class="text-[10px] text-slate-500 shrink-0">Username</label>
              <input v-model="xtreamEdits[dev.playlist_id].username"
                class="w-28 bg-[#22263a] border border-[#2e3250] focus:border-orange-500 rounded-lg px-2 py-1.5 text-xs text-slate-200 font-mono outline-none" />
            </div>
            <div class="flex items-center gap-1.5">
              <label class="text-[10px] text-slate-500 shrink-0">Password</label>
              <input v-model="xtreamEdits[dev.playlist_id].password"
                class="w-28 bg-[#22263a] border border-[#2e3250] focus:border-orange-500 rounded-lg px-2 py-1.5 text-xs text-slate-200 font-mono outline-none" />
            </div>
            <button @click="saveXtreamCreds(dev.playlist_id)" :disabled="xtreamSaving === dev.playlist_id"
              class="px-3 py-1.5 text-xs bg-orange-500 hover:bg-orange-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors shrink-0">
              {{ xtreamSaving === dev.playlist_id ? 'Saving…' : 'Save Creds' }}
            </button>
          </div>

          <!-- URLs -->
          <div class="space-y-1.5">
            <div v-for="(url, label) in { 'Player API': dev.player_api, 'M3U (get.php)': dev.get_php, 'XMLTV': dev.xmltv }" :key="label"
              class="flex items-center gap-2 bg-[#22263a] rounded-lg px-3 py-2">
              <span class="text-[10px] uppercase tracking-widest text-slate-500 w-24 shrink-0">{{ label }}</span>
              <span class="flex-1 font-mono text-xs text-slate-300 truncate">{{ url }}</span>
              <button @click="copyUrl(url, dev.playlist_id + label)"
                :class="['text-[10px] px-2 py-0.5 rounded border transition-colors shrink-0',
                  copied === dev.playlist_id + label
                    ? 'bg-green-500/20 border-green-500/30 text-green-400'
                    : 'border-[#3a3f5c] text-slate-500 hover:text-slate-200 hover:border-slate-500']">
                {{ copied === dev.playlist_id + label ? '✓' : 'Copy' }}
              </button>
            </div>
          </div>

          <p class="text-[10px] text-slate-600 mt-2">
            In TiviMate: Add Playlist → Xtream Codes → enter the server URL <code class="text-slate-400">{{ dev.player_api.split('/player_api')[0] }}</code>, username and password above.
          </p>
        </div>
      </div>
    </div>

    </template> <!-- end xtream tab -->

    <!-- Scheduler Tab -->
    <template v-if="tab === 'scheduler'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-lg shrink-0">🕐</div>
        <div>
          <h2 class="text-sm font-bold text-slate-100">Playlist Auto-Build Scheduler</h2>
          <p class="text-xs text-slate-500">Automatically rebuild M3U files on a schedule. Requires an output path to be set.</p>
        </div>
      </div>

      <div v-if="!schedules.length" class="text-center py-8 text-slate-600 text-sm">
        No playlists yet — create one first.
      </div>

      <div v-else class="space-y-3">
        <div v-for="pl in schedules" :key="pl.id"
          class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">

          <!-- Playlist header -->
          <div class="flex items-center gap-3 mb-3">
            <span class="text-sm font-semibold text-slate-100 flex-1 truncate">{{ pl.name }}</span>
            <span class="text-[10px] text-slate-600">{{ (pl.channel_count || 0).toLocaleString() }} ch</span>
            <!-- Status badge -->
            <span v-if="!pl.output_path" class="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">
              No output path
            </span>
            <span v-else-if="pl.schedule && pl.schedule_valid" class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
              ● Scheduled
            </span>
            <span v-else class="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-500 border border-slate-500/20">
              Manual only
            </span>
          </div>

          <!-- Last built -->
          <p class="text-[10px] text-slate-600 mb-3">
            Last built:
            <span :class="pl.last_built ? 'text-slate-400' : 'text-slate-700'">
              {{ pl.last_built ? new Date(pl.last_built + 'Z').toLocaleString() : 'Never' }}
            </span>
            <span v-if="pl.output_path" class="ml-2 font-mono text-slate-700">{{ pl.output_path }}</span>
          </p>

          <!-- Cron editor -->
          <div class="flex items-center gap-2 flex-wrap">
            <!-- Presets -->
            <div class="flex gap-1 flex-wrap">
              <button
                v-for="p in CRON_PRESETS" :key="p.label"
                @click="scheduleEdits[pl.id] = p.value"
                :class="['text-[10px] px-2 py-1 rounded border transition-colors',
                  scheduleEdits[pl.id] === p.value
                    ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                    : 'bg-[#22263a] border-[#2e3250] text-slate-500 hover:text-slate-300 hover:border-slate-500']"
              >{{ p.label }}</button>
            </div>

            <!-- Custom cron input -->
            <input
              v-model="scheduleEdits[pl.id]"
              placeholder="cron expression or leave blank to disable"
              :class="['flex-1 min-w-48 bg-[#22263a] border rounded-lg px-3 py-1.5 text-xs font-mono outline-none transition-colors',
                scheduleEdits[pl.id] && !schedules.find(s => s.id === pl.id)?.schedule_valid && scheduleEdits[pl.id] !== (schedules.find(s => s.id === pl.id)?.schedule || '')
                  ? 'border-red-500/50 text-red-300 focus:border-red-500'
                  : 'border-[#2e3250] text-slate-200 focus:border-indigo-500']"
            />

            <!-- Save button -->
            <button
              @click="saveSchedule(pl.id)"
              :disabled="scheduleSaving === pl.id || !scheduleChanged(pl.id) || !pl.output_path"
              :class="['px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shrink-0',
                scheduleChanged(pl.id) && pl.output_path
                  ? 'bg-indigo-500 hover:bg-indigo-400 text-white'
                  : 'bg-[#22263a] border border-[#2e3250] text-slate-600 cursor-not-allowed']"
            >
              <span v-if="scheduleSaving === pl.id" class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block"></span>
              <span v-else>Save</span>
            </button>
          </div>

          <p v-if="scheduleError[pl.id]" class="text-[10px] text-red-400 mt-1.5">⚠ {{ scheduleError[pl.id] }}</p>
          <p v-if="!pl.output_path" class="text-[10px] text-amber-500/70 mt-1.5">Set an output path in the playlist settings to enable scheduling.</p>
        </div>
      </div>
    </div>

    </template> <!-- end scheduler tab -->

    <!-- Proxy Tab -->
    <template v-if="tab === 'proxy'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-lg shrink-0">⚡</div>
        <div>
          <h2 class="text-sm font-bold text-slate-100">Stream Proxy</h2>
          <p class="text-xs text-slate-500">Configure how the proxy buffers stream data before sending to clients</p>
        </div>
      </div>

      <!-- Buffer seconds setting -->
      <div class="space-y-5">
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">
          <div class="flex items-start gap-4">
            <div class="flex-1">
              <p class="text-sm font-medium text-slate-200">Pre-buffer Duration</p>
              <p class="text-xs text-slate-500 mt-1">
                Accumulate this many seconds of stream data before sending to clients.
                Helps absorb upstream jitter and gives players a smoother start.
                Set to <code class="text-slate-400">0</code> to disable (default — lowest latency).
              </p>
              <div class="mt-3 flex items-center gap-3">
                <input
                  v-model.number="proxyBufferInput"
                  type="number" min="0" max="30" step="0.5"
                  class="w-28 bg-[#22263a] border border-[#2e3250] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 font-mono"
                />
                <span class="text-xs text-slate-500">seconds (0 – 30)</span>
              </div>
              <div class="mt-2 flex gap-2 flex-wrap">
                <button v-for="preset in [0, 1, 2, 3, 5]" :key="preset"
                  @click="proxyBufferInput = preset"
                  :class="['px-2.5 py-1 text-xs rounded-lg border transition-colors',
                    proxyBufferInput === preset
                      ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                      : 'bg-[#22263a] border-[#2e3250] text-slate-500 hover:text-slate-300']"
                >{{ preset === 0 ? 'Off' : preset + 's' }}</button>
              </div>
            </div>
            <div class="shrink-0 text-right">
              <p class="text-[10px] text-slate-600 mb-1">Current</p>
              <p class="text-2xl font-bold text-slate-200 font-mono">{{ proxySettings.bufferSeconds }}<span class="text-sm text-slate-500 font-normal">s</span></p>
            </div>
          </div>
        </div>

        <!-- How it works -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4 space-y-2 text-xs text-slate-500">
          <p class="font-semibold text-slate-400">How it works</p>
          <p>• The proxy accumulates the first <strong class="text-slate-300">N seconds</strong> of each stream before forwarding data to any client.</p>
          <p>• When a second client joins an already-running stream, the buffered data is flushed to them immediately so they don't start from a blank screen.</p>
          <p>• The setting takes effect immediately — no restart required. Active streams will pick it up on their next reconnect.</p>
          <p class="text-amber-500/70">⚠ Higher values increase startup delay but reduce buffering mid-stream. 2–3s is a good starting point for most setups.</p>
        </div>

        <p v-if="proxyError" class="text-xs text-red-400">⚠ {{ proxyError }}</p>

        <div class="flex justify-end">
          <button
            @click="saveProxySettings"
            :disabled="proxySaving || proxyBufferInput === proxySettings.bufferSeconds"
            class="px-5 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors flex items-center gap-2"
          >
            <span v-if="proxySaving" class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            <span v-else-if="proxySaved">✓ Saved</span>
            <span v-else>Save</span>
          </button>
        </div>
      </div>
    </div>
    </template> <!-- end proxy tab -->

    <!-- Backup Tab -->
    <template v-if="tab === 'backup'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-slate-500/20 text-slate-400 flex items-center justify-center text-lg shrink-0">💾</div>
        <div>
          <h2 class="text-sm font-bold text-slate-100">Backup & Restore</h2>
          <p class="text-xs text-slate-500">Full export of all database tables, EPG files, and environment config to a single compressed file</p>
        </div>
      </div>

      <div class="flex flex-col gap-4">
        <!-- What's included -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl px-4 py-3 space-y-2">
          <p class="text-xs font-semibold text-slate-400">What's included</p>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-[11px] text-slate-500">
            <span>✓ sources</span>
            <span>✓ playlists</span>
            <span>✓ playlist_channels</span>
            <span>✓ epg_mappings</span>
            <span>✓ epg_site_channels</span>
            <span>✓ settings</span>
            <span>✓ users</span>
            <span>✓ stream_history</span>
            <span>✓ admin_sessions</span>
            <span>✓ failed_streams</span>
            <span>✓ channels.xml</span>
            <span>✓ guide.xml</span>
            <span>✓ .env <span class="text-slate-600">(merge on restore)</span></span>
          </div>
        </div>

        <!-- Backup -->
        <div class="flex items-center gap-4 bg-[#13151f] border border-[#2e3250] rounded-xl px-4 py-3">
          <div class="flex-1">
            <p class="text-sm text-slate-200 font-medium">Export Backup</p>
            <p class="text-xs text-slate-600 mt-0.5">Downloads a <code class="text-slate-400">.json.gz</code> file with all your data</p>
          </div>
          <a href="/api/backup" download
            class="px-4 py-2 text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-lg transition-colors shrink-0">
            ⬇ Download Backup
          </a>
        </div>

        <!-- Restore -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl px-4 py-4">
          <p class="text-sm text-slate-200 font-medium mb-1">Restore from Backup</p>
          <p class="text-xs text-slate-600 mb-3">⚠ This will <strong class="text-amber-400">overwrite all current data</strong>. Upload a <code class="text-slate-400">.json.gz</code> backup file.</p>

          <div class="flex items-center gap-3 flex-wrap">
            <label class="flex-1 min-w-48 flex items-center gap-2 bg-[#22263a] border border-[#2e3250] hover:border-indigo-500 rounded-lg px-3 py-2 cursor-pointer transition-colors">
              <span class="text-slate-500 text-sm">📁</span>
              <span class="text-xs text-slate-400 truncate flex-1">{{ restoreFile ? restoreFile.name : 'Choose backup file…' }}</span>
              <input type="file" accept=".gz,.json.gz" class="hidden" @change="onRestoreFile" />
            </label>
            <button
              @click="doRestore"
              :disabled="!restoreFile || restoring"
              class="px-4 py-2 text-xs bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors shrink-0">
              {{ restoring ? 'Restoring…' : '↺ Restore' }}
            </button>
          </div>

          <div v-if="restoreResult" class="mt-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
            <p class="text-xs text-emerald-400 font-semibold mb-1">✓ Restore complete</p>
            <div class="flex flex-wrap gap-3 text-[10px] text-slate-400">
              <span v-for="(count, table) in restoreResult" :key="table">
                <span class="text-slate-300 font-medium">{{ count }}</span> {{ table }}
              </span>
            </div>
          </div>
          <p v-if="restoreError" class="mt-2 text-xs text-red-400">⚠ {{ restoreError }}</p>
        </div>
      </div>
    </div>

    </template> <!-- end backup tab -->

    <!-- ── Diagnostics Tab ── -->
    <template v-if="tab === 'diagnostics'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center text-lg shrink-0">🔧</div>
        <div class="flex-1">
          <h2 class="text-sm font-bold text-slate-100">Network Diagnostics</h2>
          <p class="text-xs text-slate-500">Check VPN status, public IP, and download speed from inside the container</p>
        </div>
        <button @click="runAll" :disabled="diagRunning.ip || diagRunning.vpn || diagRunning.speed"
          class="px-4 py-2 text-xs bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors shrink-0">
          {{ (diagRunning.ip || diagRunning.vpn || diagRunning.speed) ? 'Running…' : '▶ Run All' }}
        </button>
      </div>

      <div class="space-y-3">

        <!-- Public IP -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">
          <div class="flex items-center gap-3 mb-3">
            <span class="text-sm font-semibold text-slate-100 flex-1">🌐 Public IP</span>
            <button @click="runIpCheck" :disabled="diagRunning.ip"
              class="px-3 py-1 text-xs bg-[#22263a] border border-[#2e3250] hover:border-cyan-500 text-slate-400 hover:text-cyan-300 disabled:opacity-40 rounded-lg transition-colors">
              {{ diagRunning.ip ? '…' : 'Check' }}
            </button>
          </div>
          <div v-if="diagRunning.ip" class="flex items-center gap-2 text-xs text-slate-500">
            <span class="w-3 h-3 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin inline-block"></span> Checking…
          </div>
          <div v-else-if="diagIp" class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div class="bg-[#22263a] rounded-lg px-3 py-2">
              <p class="text-[10px] text-slate-500 mb-0.5">IP</p>
              <p class="text-xs font-mono text-slate-200">{{ diagIp.ip }}</p>
            </div>
            <div class="bg-[#22263a] rounded-lg px-3 py-2">
              <p class="text-[10px] text-slate-500 mb-0.5">Country</p>
              <p class="text-xs font-mono text-slate-200">{{ diagIp.country || '—' }}</p>
            </div>
            <div class="bg-[#22263a] rounded-lg px-3 py-2">
              <p class="text-[10px] text-slate-500 mb-0.5">City</p>
              <p class="text-xs font-mono text-slate-200">{{ diagIp.city || '—' }}</p>
            </div>
            <div class="bg-[#22263a] rounded-lg px-3 py-2">
              <p class="text-[10px] text-slate-500 mb-0.5">ISP / Org</p>
              <p class="text-xs font-mono text-slate-200 truncate">{{ diagIp.org || '—' }}</p>
            </div>
          </div>
          <p v-else-if="diagError.ip" class="text-xs text-red-400">⚠ {{ diagError.ip }}</p>
          <p v-else class="text-xs text-slate-600">Not checked yet</p>
        </div>

        <!-- VPN Status -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">
          <div class="flex items-center gap-3 mb-3">
            <span class="text-sm font-semibold text-slate-100 flex-1">🔒 VPN Status</span>
            <button @click="runVpnCheck" :disabled="diagRunning.vpn"
              class="px-3 py-1 text-xs bg-[#22263a] border border-[#2e3250] hover:border-cyan-500 text-slate-400 hover:text-cyan-300 disabled:opacity-40 rounded-lg transition-colors">
              {{ diagRunning.vpn ? '…' : 'Check' }}
            </button>
          </div>
          <div v-if="diagRunning.vpn" class="flex items-center gap-2 text-xs text-slate-500">
            <span class="w-3 h-3 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin inline-block"></span> Checking…
          </div>
          <div v-else-if="diagVpn" class="flex items-center gap-4 flex-wrap">
            <div class="flex items-center gap-2">
              <span :class="diagVpn.vpnActive ? 'text-emerald-400' : 'text-red-400'">{{ diagVpn.vpnActive ? '✓' : '✗' }}</span>
              <span class="text-xs" :class="diagVpn.vpnActive ? 'text-emerald-300' : 'text-red-300'">tun0 {{ diagVpn.vpnActive ? 'UP' : 'DOWN' }}</span>
            </div>
            <div class="flex items-center gap-2">
              <span :class="diagVpn.defaultViaTun ? 'text-emerald-400' : 'text-amber-400'">{{ diagVpn.defaultViaTun ? '✓' : '⚠' }}</span>
              <span class="text-xs" :class="diagVpn.defaultViaTun ? 'text-emerald-300' : 'text-amber-300'">Traffic {{ diagVpn.defaultViaTun ? 'routed via VPN' : 'NOT routed via VPN' }}</span>
            </div>
          </div>
          <p v-else-if="diagError.vpn" class="text-xs text-red-400">⚠ {{ diagError.vpn }}</p>
          <p v-else class="text-xs text-slate-600">Not checked yet</p>
        </div>

        <!-- Speed Test -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">
          <div class="flex items-center gap-3 mb-3">
            <span class="text-sm font-semibold text-slate-100 flex-1">⚡ Download Speed</span>
            <span class="text-[10px] text-slate-600">25MB via Cloudflare</span>
            <button @click="runSpeedTest" :disabled="diagRunning.speed"
              class="px-3 py-1 text-xs bg-[#22263a] border border-[#2e3250] hover:border-cyan-500 text-slate-400 hover:text-cyan-300 disabled:opacity-40 rounded-lg transition-colors">
              {{ diagRunning.speed ? '…' : 'Run' }}
            </button>
          </div>
          <div v-if="diagRunning.speed" class="flex items-center gap-2 text-xs text-slate-500">
            <span class="w-3 h-3 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin inline-block"></span> Downloading 25MB test file…
          </div>
          <div v-else-if="diagSpeed" class="flex items-center gap-6 flex-wrap">
            <div>
              <p class="text-[10px] text-slate-500 mb-0.5">Speed</p>
              <p class="text-2xl font-bold" :class="diagSpeed.mbps > 50 ? 'text-emerald-400' : diagSpeed.mbps > 10 ? 'text-amber-400' : 'text-red-400'">
                {{ diagSpeed.mbps }} <span class="text-sm font-normal text-slate-400">Mbps</span>
              </p>
            </div>
            <div>
              <p class="text-[10px] text-slate-500 mb-0.5">Downloaded</p>
              <p class="text-sm text-slate-300">{{ diagSpeed.mb }} MB</p>
            </div>
            <div>
              <p class="text-[10px] text-slate-500 mb-0.5">Duration</p>
              <p class="text-sm text-slate-300">{{ diagSpeed.elapsed }}s</p>
            </div>
          </div>
          <p v-else-if="diagError.speed" class="text-xs text-red-400">⚠ {{ diagError.speed }}</p>
          <p v-else class="text-xs text-slate-600">Not tested yet</p>
        </div>

        <!-- Dead Channels Report -->
        <div class="bg-[#13151f] border border-[#2e3250] rounded-xl p-4">
          <div class="flex items-center gap-3 mb-3 flex-wrap">
            <span class="text-sm font-semibold text-slate-100 flex-1">💀 Dead Channel Report</span>
            <span class="text-[10px] text-slate-600">Channels that failed to stream — tracked automatically</span>
            <button @click="loadDeadChannels" :disabled="deadLoading"
              class="px-3 py-1 text-xs bg-[#22263a] border border-[#2e3250] hover:border-cyan-500 text-slate-400 hover:text-cyan-300 disabled:opacity-40 rounded-lg transition-colors">
              {{ deadLoading ? '…' : 'Load Report' }}
            </button>
            <button v-if="deadChannels?.rows?.length" @click="clearDeadChannels" :disabled="deadClearing"
              class="px-3 py-1 text-xs bg-[#22263a] border border-red-900/50 hover:border-red-500 text-red-400 disabled:opacity-40 rounded-lg transition-colors">
              {{ deadClearing ? '…' : 'Clear All' }}
            </button>
          </div>

          <div v-if="deadLoading" class="flex items-center gap-2 text-xs text-slate-500">
            <span class="w-3 h-3 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin inline-block"></span> Loading…
          </div>

          <div v-else-if="deadChannels">
            <p v-if="!deadChannels.rows.length" class="text-xs text-slate-600">No failed streams recorded yet. Failures are tracked automatically when a stream can't connect.</p>
            <div v-else>
              <p class="text-xs text-slate-500 mb-2">{{ deadChannels.total }} total failures — showing top {{ deadChannels.rows.length }} by fail count</p>
              <div class="overflow-x-auto">
                <table class="w-full text-xs min-w-[500px]">
                  <thead>
                    <tr class="border-b border-[#2e3250] text-[10px] uppercase tracking-widest text-slate-500">
                      <th class="text-left py-2 pr-3">Channel</th>
                      <th class="text-left py-2 pr-3">Group</th>
                      <th class="text-center py-2 pr-3">Fails</th>
                      <th class="text-left py-2 pr-3">Error</th>
                      <th class="text-left py-2">Last Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="ch in deadChannels.rows" :key="ch.id"
                      class="border-b border-[#2e3250]/50 last:border-0 hover:bg-[#22263a]/30">
                      <td class="py-2 pr-3 text-slate-300 font-medium">{{ ch.tvg_name || '—' }}</td>
                      <td class="py-2 pr-3 text-slate-500">{{ ch.group_title || '—' }}</td>
                      <td class="py-2 pr-3 text-center">
                        <span :class="['px-1.5 py-0.5 rounded text-[10px] font-bold', ch.fail_count >= 10 ? 'bg-red-500/20 text-red-400' : ch.fail_count >= 3 ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-500/20 text-slate-400']">
                          {{ ch.fail_count }}
                        </span>
                      </td>
                      <td class="py-2 pr-3 text-slate-600 font-mono truncate max-w-[180px]">{{ ch.error || '—' }}</td>
                      <td class="py-2 text-slate-600 text-[10px]">{{ ch.last_failed }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <p v-else class="text-xs text-slate-600">Click "Load Report" to see channels that have failed to stream.</p>
        </div>

      </div>
    </div>
    </template> <!-- end diagnostics tab -->

    <!-- ── Architecture Tab ── -->
    <template v-if="tab === 'architecture'">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6">
      <div class="flex items-center gap-3 mb-5">
        <div class="w-9 h-9 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center text-lg shrink-0">🗺️</div>
        <div class="flex-1">
          <h2 class="text-sm font-bold text-slate-100">System Architecture</h2>
          <p class="text-xs text-slate-500">Data flow from sources through channel selection to final outputs</p>
        </div>
        <a href="/docs/architecture.svg" target="_blank"
          class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-indigo-500 text-slate-400 hover:text-indigo-300 rounded-lg transition-colors shrink-0">
          ↗ Open full size
        </a>
      </div>
      <div class="overflow-x-auto rounded-xl bg-[#0d0f18] p-4">
        <img src="/docs/architecture.svg" alt="M3u4Proxy Architecture Diagram" class="w-full max-w-none" style="min-width:900px"/>
      </div>
    </div>
    </template> <!-- end architecture tab -->

    </div> <!-- end scrollable content -->

    <!-- Device form modal -->
    <Teleport to="body">
      <div v-if="showDeviceForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-sm p-6 shadow-2xl">
          <div class="flex items-center gap-3 mb-5">
            <span class="text-xl">📡</span>
            <h2 class="text-base font-bold">{{ editingDevice ? 'Edit Device' : 'New HDHomeRun Device' }}</h2>
            <button @click="showDeviceForm = false" class="ml-auto text-slate-500 hover:text-slate-300 text-xl leading-none">✕</button>
          </div>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Device Name</label>
              <input v-model="deviceForm.name" placeholder="Living Room TV" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Playlist</label>
              <div class="relative">
                <select v-model="deviceForm.playlist_id" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl pl-3 pr-7 py-2.5 text-sm text-slate-200 outline-none focus:border-blue-500 appearance-none cursor-pointer">
                  <option value="">— No playlist —</option>
                  <option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
                <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-[10px] pointer-events-none">▾</span>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-slate-500 mb-1.5">Port</label>
                <input v-model.number="deviceForm.port" type="number" min="1024" max="65535" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-blue-500" />
                <p class="text-[10px] text-slate-600 mt-1">e.g. 5004, 5005…</p>
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1.5">Tuner Count</label>
                <input v-model.number="deviceForm.tuner_count" type="number" min="1" max="32" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-blue-500" />
              </div>
            </div>
            <div class="flex items-center gap-3 pt-1">
              <button type="button" @click="deviceForm.active = !deviceForm.active"
                :class="['relative inline-flex w-10 h-5 rounded-full transition-colors duration-200 shrink-0 focus:outline-none', deviceForm.active ? 'bg-blue-500' : 'bg-slate-700']">
                <span :class="['absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all duration-200', deviceForm.active ? 'left-5' : 'left-0.5']"></span>
              </button>
              <span class="text-xs text-slate-400">{{ deviceForm.active ? 'Active' : 'Disabled' }}</span>
            </div>
          </div>
          <p v-if="deviceError" class="text-xs text-red-400 mt-3">⚠ {{ deviceError }}</p>
          <div class="flex gap-3 mt-5">
            <button @click="showDeviceForm = false" class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors">Cancel</button>
            <button @click="saveDevice" :disabled="deviceSaving || !deviceForm.port" class="flex-1 py-2.5 text-sm bg-blue-500 hover:bg-blue-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors">
              <span v-if="deviceSaving" class="inline-block w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1.5 align-middle"></span>
              {{ editingDevice ? 'Save Changes' : 'Create Device' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>
