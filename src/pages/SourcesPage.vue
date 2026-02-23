<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../composables/useApi.js'

const sources      = ref([])
const loading      = ref(false)
const error        = ref('')
const showForm     = ref(false)
const editing      = ref(null)
const refreshing   = ref({})

// ── EPG grab status ─────────────────────────────────────────────────────────────────
const grabStatus = ref(null)
let grabPoller = null

async function pollGrabStatus() {
  try { grabStatus.value = await api.getEpgGrabStatus() } catch {}
}

const form = ref({ name: '', category: 'playlist', type: 'm3u', url: '', username: '', password: '', refresh_cron: '0 */6 * * *', max_streams: 0 })

const playlistSources = computed(() => sources.value.filter(s => s.category !== 'epg'))
const epgSources      = computed(() => sources.value.filter(s => s.category === 'epg'))

async function load() {
  sources.value = await api.getSources()
}

function openCreate(category = 'playlist') {
  editing.value = null
  form.value = { name: '', category, type: category === 'epg' ? 'epg' : 'm3u', url: '', username: '', password: '', refresh_cron: '0 */6 * * *', max_streams: 0 }
  showForm.value = true
}

function openEdit(s) {
  editing.value = s
  form.value = { name: s.name, category: s.category || 'playlist', type: s.type, url: s.url, username: s.username || '', password: s.password || '', refresh_cron: s.refresh_cron || '0 */6 * * *', max_streams: s.max_streams || 0 }
  showForm.value = true
}

async function save() {
  loading.value = true
  error.value = ''
  try {
    if (editing.value) {
      await api.updateSource(editing.value.id, form.value)
    } else {
      await api.createSource(form.value)
    }
    showForm.value = false
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function remove(s) {
  if (!confirm(`Delete source "${s.name}"?`)) return
  await api.deleteSource(s.id)
  await load()
}

async function refresh(s) {
  refreshing.value = { ...refreshing.value, [s.id]: true }
  error.value = ''
  try {
    await api.refreshSource(s.id)
    await load()
  } catch (e) {
    error.value = `Failed to refresh "${s.name}": ${e.message}`
  } finally {
    const next = { ...refreshing.value }
    delete next[s.id]
    refreshing.value = next
  }
}

onMounted(async () => {
  await load()
  await pollGrabStatus()
  grabPoller = setInterval(pollGrabStatus, 3000)
})

onUnmounted(() => { if (grabPoller) clearInterval(grabPoller) })
</script>

<template>
  <div class="p-6 max-w-6xl mx-auto space-y-8">

    <div>
      <h1 class="text-lg font-bold text-slate-100">Sources</h1>
      <p class="text-xs text-slate-500 mt-0.5">Manage playlist and EPG feed sources</p>
    </div>

    <p v-if="error" class="text-xs text-red-400">⚠ {{ error }}</p>

    <!-- ── Playlist Sources ──────────────────────────────────────────────── -->
    <section>
      <!-- Mobile notice -->
      <div class="md:hidden px-4 py-2 mb-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-400 text-xs">
        Swipe horizontally on tables to see all content →
      </div>

      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span class="text-base">📋</span>
          <h2 class="text-sm font-bold text-slate-200">Playlist Sources</h2>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">{{ playlistSources.length }}</span>
        </div>
        <button @click="openCreate('playlist')" class="px-3 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-xl transition-colors">
          + Add Playlist Source
        </button>
      </div>

      <div class="space-y-2">
        <div v-if="!playlistSources.length" class="text-center py-10 text-slate-600 bg-[#1a1d27] border border-[#2e3250] rounded-2xl">
          <p class="text-sm">No playlist sources yet</p>
        </div>
        <div
          v-for="s in playlistSources" :key="s.id"
          class="flex flex-col sm:flex-row sm:items-center gap-3 bg-[#1a1d27] border border-[#2e3250] rounded-2xl px-4 py-3"
        >
          <div class="flex items-center gap-3 flex-1 min-w-0">
            <div class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-base"
              :class="s.type === 'xtream' ? 'bg-purple-500/20 text-purple-400' : 'bg-indigo-500/20 text-indigo-400'">
              {{ s.type === 'xtream' ? '⚡' : '📋' }}
            </div>
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-sm text-slate-100">{{ s.name }}</p>
              <p class="text-xs text-slate-500 truncate">{{ s.url }}</p>
              <div class="flex flex-wrap gap-2 mt-0.5 text-xs text-slate-600">
                <span class="uppercase font-mono">{{ s.type }}</span>
                <span v-if="s.channel_count" class="text-slate-400">· {{ s.channel_count.toLocaleString() }} ch</span>
                <span v-if="s.last_fetched" class="hidden sm:inline">· {{ new Date(s.last_fetched + 'Z').toLocaleString() }}</span>
                <span v-else class="text-amber-600">· Not fetched</span>
              </div>
            </div>
          </div>
          <div class="flex gap-1.5 shrink-0 flex-wrap">
            <a :href="s.url" target="_blank" rel="noopener"
              class="hidden sm:flex items-center gap-1 px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-sky-400 text-slate-300 hover:text-sky-300 transition-colors">
              ↗
            </a>
            <button @click="refresh(s)" :disabled="refreshing[s.id]"
              class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-green-400 text-slate-300 hover:text-green-300 disabled:opacity-50 transition-colors">
              <span v-if="refreshing[s.id]" class="w-3 h-3 border-2 border-green-500/30 border-t-green-400 rounded-full animate-spin"></span>
              <span v-else>↻</span>
              <span class="hidden sm:inline">{{ refreshing[s.id] ? 'Refreshing…' : 'Refresh' }}</span>
            </button>
            <button @click="openEdit(s)" class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 transition-colors">Edit</button>
            <button @click="remove(s)" class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-red-900/50 rounded-lg hover:border-red-500 text-red-400 transition-colors">✕</button>
          </div>
        </div>
      </div>
    </section>

    <!-- ── EPG Sources ───────────────────────────────────────────────────── -->
    <section>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span class="text-base">🗓️</span>
          <h2 class="text-sm font-bold text-slate-200">EPG Sources</h2>
          <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">{{ epgSources.length }}</span>
          <!-- Grab in-progress badge -->
          <span v-if="grabStatus?.inProgress" class="flex items-center gap-1.5 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300">
            <span class="w-2 h-2 border border-amber-400/40 border-t-amber-400 rounded-full animate-spin"></span>
            Grabbing EPG{{ grabStatus.progress?.site ? ` · ${grabStatus.progress.site}` : '' }}{{ grabStatus.progress?.channelTotal ? ` (${grabStatus.progress.channelDone}/${grabStatus.progress.channelTotal} requests)` : '' }}
          </span>
          <span v-else-if="grabStatus?.guideExists" class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
            ✓ guide.xml ready
          </span>
        </div>
        <button @click="openCreate('epg')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl transition-colors">
          + Add EPG Source
        </button>
      </div>

      <!-- Grab error banner -->
      <div v-if="grabStatus?.lastError && !grabStatus?.inProgress" class="flex items-center gap-3 mb-3 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300">
        <span class="shrink-0">⚠</span>
        <span class="flex-1">Last EPG grab failed: {{ grabStatus.lastError }}</span>
        <a href="#" @click.prevent="$router.push ? $router.push('/epg-scraper') : null" class="shrink-0 text-red-400 hover:text-red-300">Go to EPG Scraper →</a>
      </div>

      <div class="space-y-2">
        <div v-if="!epgSources.length" class="text-center py-10 text-slate-600 bg-[#1a1d27] border border-[#2e3250] rounded-2xl">
          <p class="text-sm">No EPG sources yet. Add an XMLTV URL.</p>
        </div>
        <div
          v-for="s in epgSources" :key="s.id"
          class="flex flex-col sm:flex-row sm:items-center gap-3 bg-[#1a1d27] border border-[#2e3250] rounded-2xl px-4 py-3"
        >
          <div class="flex items-center gap-3 flex-1 min-w-0">
            <div class="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 text-base">🗓️</div>
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-sm text-slate-100">{{ s.name }}</p>
              <p class="text-xs text-slate-500 truncate">{{ s.url }}</p>
              <div class="flex flex-wrap gap-2 mt-0.5 text-xs text-slate-600">
                <span class="uppercase font-mono text-emerald-700">xmltv</span>
                <span v-if="s.channel_count" class="text-slate-400">· {{ s.channel_count.toLocaleString() }} ch</span>
                <span v-if="s.last_fetched" class="hidden sm:inline">· {{ new Date(s.last_fetched + 'Z').toLocaleString() }}</span>
                <span v-else class="text-amber-600">· Not fetched</span>
              </div>
            </div>
          </div>
          <div class="flex gap-1.5 shrink-0 flex-wrap">
            <a :href="s.url" target="_blank" rel="noopener"
              class="hidden sm:flex items-center gap-1 px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-sky-400 text-slate-300 hover:text-sky-300 transition-colors">
              ↗
            </a>
            <button @click="refresh(s)" :disabled="refreshing[s.id]"
              class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-green-400 text-slate-300 hover:text-green-300 disabled:opacity-50 transition-colors">
              <span v-if="refreshing[s.id]" class="w-3 h-3 border-2 border-green-500/30 border-t-green-400 rounded-full animate-spin"></span>
              <span v-else>↻</span>
              <span class="hidden sm:inline">{{ refreshing[s.id] ? 'Refreshing…' : 'Refresh' }}</span>
            </button>
            <button @click="openEdit(s)" class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 transition-colors">Edit</button>
            <button @click="remove(s)" class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-red-900/50 rounded-lg hover:border-red-500 text-red-400 transition-colors">✕</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Form modal -->
    <Teleport to="body">
      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md p-6 shadow-2xl">
          <h2 class="text-base font-bold mb-5">{{ editing ? 'Edit Source' : (form.category === 'epg' ? 'Add EPG Source' : 'Add Playlist Source') }}</h2>

          <div class="space-y-3">
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Name</label>
              <input v-model="form.name" placeholder="My Source" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>

            <!-- Playlist-only: type selector -->
            <div v-if="form.category !== 'epg'">
              <label class="block text-xs text-slate-500 mb-1.5">Type</label>
              <select v-model="form.type" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-indigo-500">
                <option value="m3u">M3U URL</option>
                <option value="xtream">Xtream Codes API</option>
              </select>
            </div>

            <div>
              <label class="block text-xs text-slate-500 mb-1.5">
                {{ form.category === 'epg' ? 'XMLTV URL' : form.type === 'xtream' ? 'Server URL' : 'M3U URL' }}
              </label>
              <input v-model="form.url"
                :placeholder="form.category === 'epg' ? 'http://server/epg.xml' : form.type === 'xtream' ? 'http://server:port' : 'http://server/playlist.m3u'"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>

            <template v-if="form.category !== 'epg' && form.type === 'xtream'">
              <div>
                <label class="block text-xs text-slate-500 mb-1.5">Username</label>
                <input v-model="form.username" placeholder="username" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1.5">Password</label>
                <input v-model="form.password" type="password" placeholder="password" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
              </div>
            </template>

            <div v-if="form.category !== 'epg'">
              <label class="block text-xs text-slate-500 mb-1.5">Max Concurrent Streams</label>
              <input v-model.number="form.max_streams" type="number" min="0" placeholder="0 = unlimited"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
              <p class="text-xs text-slate-600 mt-1">How many simultaneous streams your provider allows. 0 = unlimited.</p>
            </div>

            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Refresh Schedule (cron)</label>
              <input v-model="form.refresh_cron" placeholder="0 */6 * * *" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
              <p class="text-xs text-slate-600 mt-1">e.g. <code>0 */6 * * *</code> = every 6 hours</p>
            </div>
          </div>

          <p v-if="error" class="text-xs text-red-400 mt-3">⚠ {{ error }}</p>

          <div class="flex gap-3 mt-5">
            <button @click="showForm = false" class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors">Cancel</button>
            <button @click="save" :disabled="loading || !form.name || !form.url" class="flex-1 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors">
              {{ loading ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
