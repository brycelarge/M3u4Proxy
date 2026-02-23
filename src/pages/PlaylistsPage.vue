<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../composables/useApi.js'
import GroupOrderModal from '../components/GroupOrderModal.vue'

const playlists      = ref([])
const sources        = ref([])
const loading        = ref(false)
const building       = ref(null)
const error          = ref('')
const showForm       = ref(false)
const editing        = ref(null)
const filterSourceId = ref('')
const copied         = ref(null)
const showAdvanced   = ref(false)
const showGroupOrder = ref(null)  // playlist object or null

function proxyUrl(p) {
  // Check if window is defined (client-side only)
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005'
  return `${baseUrl}/api/playlists/${p.id}/m3u`
}

function xmltvUrl(p) {
  // Check if window is defined (client-side only)
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005'
  return `${baseUrl}/api/playlists/${p.id}/xmltv`
}

function copyProxyUrl(p) {
  // Check if navigator.clipboard is available (client-side only)
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(proxyUrl(p))
    copied.value = p.id
    setTimeout(() => { copied.value = null }, 2000)
  }
}

function copyUrl(url, key) {
  // Check if navigator.clipboard is available (client-side only)
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(url)
    copied.value = key
    setTimeout(() => { copied.value = null }, 2000)
  }
}

const filteredPlaylists = computed(() => {
  if (!filterSourceId.value) return playlists.value
  return playlists.value.filter(p => String(p.source_id) === String(filterSourceId.value))
})

function sourceNameFor(id) {
  return sources.value.find(s => s.id === id)?.name || ''
}

const form = ref({ name: '', output_path: '', schedule: '0 */6 * * *', playlist_type: 'live' })

async function load() {
  ;[playlists.value, sources.value] = await Promise.all([api.getPlaylists(), api.getSources()])
}

function openCreate() {
  editing.value = null
  showAdvanced.value = false
  form.value = { name: '', output_path: '', schedule: '0 */6 * * *', playlist_type: 'live' }
  showForm.value = true
}

function openEdit(p) {
  editing.value = p
  showAdvanced.value = !!p.output_path
  form.value = { name: p.name, output_path: p.output_path || '', schedule: p.schedule || '0 */6 * * *', playlist_type: p.playlist_type || 'live' }
  showForm.value = true
}

async function save() {
  loading.value = true
  error.value = ''
  try {
    if (editing.value) {
      await api.updatePlaylist(editing.value.id, form.value)
    } else {
      await api.createPlaylist(form.value)
    }
    showForm.value = false
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function remove(p) {
  if (!confirm(`Delete playlist "${p.name}"?`)) return
  await api.deletePlaylist(p.id)
  await load()
}

async function build(p) {
  building.value = p.id
  error.value = ''
  try {
    const result = await api.buildPlaylist(p.id)
    alert(`✓ Built "${p.name}" → ${result.path}\n${result.channels} channels`)
    await load()
  } catch (e) {
    error.value = e.message
  } finally {
    building.value = null
  }
}

const emit = defineEmits(['open-editor'])

onMounted(load)
</script>

<template>
  <div class="p-3 sm:p-6 max-w-6xl mx-auto">
    <div class="flex items-center justify-between gap-3 mb-4 flex-wrap">
      <div>
        <h1 class="text-lg font-bold text-slate-100">Playlists</h1>
        <p class="text-xs text-slate-500 mt-0.5">Named channel selections that get written to disk for Tuliprox</p>
      </div>
      <div class="flex items-center gap-3">
        <div v-if="sources.length > 1" class="relative">
          <select
            v-model="filterSourceId"
            class="bg-[#22263a] border border-[#2e3250] rounded-xl pl-3 pr-7 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500 appearance-none cursor-pointer hover:border-indigo-400 transition-colors"
          >
            <option value="">All Sources</option>
            <option v-for="s in sources" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <span class="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 text-[10px] pointer-events-none">▾</span>
        </div>
        <button @click="openCreate" class="px-4 py-2 text-sm bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-xl transition-colors">
          + New Playlist
        </button>
      </div>
    </div>

    <p v-if="error" class="text-xs text-red-400 mb-4">⚠ {{ error }}</p>

    <!-- Empty state -->
    <div v-if="!playlists.length" class="text-center py-16 text-slate-500">
      <p class="text-4xl mb-3">📝</p>
      <p class="text-sm">No playlists yet. Create one and select channels to include.</p>
    </div>

    <!-- Table -->
    <div v-else class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl overflow-hidden">
      <!-- Mobile notice -->
      <div class="md:hidden px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-xs">
        Swipe horizontally to see all content →
      </div>
      <div class="overflow-x-auto w-full" style="-webkit-overflow-scrolling: touch; max-width: 100vw;">
      <table class="w-full text-sm min-w-[800px]">
        <thead>
          <tr class="border-b border-[#2e3250] text-[10px] uppercase tracking-widest text-slate-500">
            <th class="text-left px-4 py-3 font-semibold">Playlist</th>
            <th class="text-center px-3 py-3 font-semibold hidden sm:table-cell">Type</th>
            <th class="text-center px-3 py-3 font-semibold">Channels</th>
            <th class="text-center px-3 py-3 font-semibold hidden sm:table-cell">Groups</th>
            <th class="text-center px-3 py-3 font-semibold hidden sm:table-cell">Sources</th>
            <th class="text-left px-3 py-3 font-semibold hidden lg:table-cell">Last Built</th>
            <th class="text-right px-4 py-3 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in filteredPlaylists" :key="p.id"
            class="border-b border-[#2e3250] last:border-0 hover:bg-[#22263a]/40 transition-colors"
          >
            <!-- Type badge -->
            <td class="px-3 py-4 text-center hidden sm:table-cell">
              <span :class="['text-[10px] font-semibold px-2 py-0.5 rounded-full border',
                p.playlist_type === 'vod'
                  ? 'bg-purple-500/15 border-purple-500/30 text-purple-300'
                  : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300']"
              >{{ p.playlist_type === 'vod' ? 'VOD' : 'Live' }}</span>
            </td>
            <!-- Name + M3U URL + groups preview -->
            <td class="px-5 py-4">
              <p class="font-semibold text-slate-100">{{ p.name }}</p>
              <!-- M3U URL row -->
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class="font-mono text-[10px] text-slate-500 truncate max-w-xs">{{ proxyUrl(p) }}</span>
                <a :href="proxyUrl(p)" target="_blank"
                  class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border bg-[#22263a] border-[#2e3250] text-slate-500 hover:text-blue-400 hover:border-blue-500 transition-colors"
                  @click.stop
                >🔗 M3U</a>
                <a :href="xmltvUrl(p)" target="_blank"
                  class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border bg-[#22263a] border-[#2e3250] text-slate-500 hover:text-purple-400 hover:border-purple-500 transition-colors"
                  @click.stop
                >🔗 XMLTV</a>
              </div>
              <!-- VOD note -->
              <div v-if="p.playlist_type === 'vod'" class="flex items-center gap-1.5 mt-1.5">
                <span class="text-[10px] px-1.5 py-0.5 rounded border bg-purple-500/10 border-purple-500/30 text-purple-300">📺 Xtream Codes API</span>
                <span class="text-[10px] text-slate-600">This VOD playlist is served as VOD content via the Xtream Codes API — not as an M3U file. Use it in TiviMate, IPTV Smarters, etc. via the Streams page credentials.</span>
              </div>
              <div v-if="p.group_names?.length" class="flex flex-wrap gap-1 mt-1.5">
                <span
                  v-for="g in p.group_names" :key="g"
                  class="text-[10px] px-1.5 py-0.5 rounded bg-[#2e3250] text-slate-400"
                >{{ g }}</span>
                <span v-if="p.group_count > 5" class="text-[10px] px-1.5 py-0.5 rounded bg-[#2e3250] text-slate-500">
                  +{{ p.group_count - 5 }} more
                </span>
              </div>
            </td>

            <!-- Channel count -->
            <td class="px-4 py-4 text-center">
              <span class="text-slate-200 font-semibold">{{ (p.channel_count || 0).toLocaleString() }}</span>
            </td>

            <!-- Group count -->
            <td class="px-3 py-4 text-center hidden sm:table-cell">
              <span class="text-slate-400">{{ p.group_count || 0 }}</span>
            </td>

            <!-- Source count -->
            <td class="px-3 py-4 text-center hidden sm:table-cell">
              <span class="text-slate-400">{{ p.source_count || 0 }}</span>
            </td>

            <!-- Last built -->
            <td class="px-4 py-4 hidden lg:table-cell">
              <span v-if="p.last_built" class="text-xs text-slate-500">
                {{ new Date(p.last_built + 'Z').toLocaleString() }}
              </span>
              <span v-else class="text-xs text-slate-700">Never</span>
            </td>

            <!-- Actions -->
            <td class="px-5 py-4">
              <div class="flex items-center gap-1.5 justify-end flex-wrap">
                <!-- Build -->
                <button
                  @click="build(p)"
                  :disabled="building === p.id || !p.output_path"
                  class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-emerald-500 text-slate-300 disabled:opacity-40 transition-colors"
                  title="Build M3U to disk"
                >
                  <span v-if="building === p.id" class="w-3 h-3 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin inline-block"></span>
                  <span v-else>⚙</span>
                </button>

                <!-- Group order -->
                <button
                  @click="showGroupOrder = p"
                  class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-purple-500 text-slate-400 transition-colors"
                  title="Reorder groups"
                >☰</button>

                <!-- Edit channels -->
                <button
                  @click="emit('open-editor', p)"
                  class="px-2.5 py-1.5 text-xs bg-indigo-500/20 border border-indigo-500/40 rounded-lg hover:border-indigo-400 text-indigo-300 transition-colors"
                  title="Browse &amp; select channels"
                >📺 Channels</button>

                <!-- Settings -->
                <button
                  @click="openEdit(p)"
                  class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-slate-500 text-slate-400 transition-colors"
                  title="Edit playlist settings"
                >✏</button>

                <!-- Delete -->
                <button
                  @click="remove(p)"
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

    <!-- Form modal -->
    <Teleport to="body">
      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md p-6 shadow-2xl">
          <h2 class="text-base font-bold mb-5">{{ editing ? 'Playlist Settings' : 'New Playlist' }}</h2>

          <div class="space-y-3">
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Playlist Name</label>
              <input v-model="form.name" placeholder="US Channels" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>

            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Type</label>
              <div class="flex gap-2">
                <button type="button" @click="form.playlist_type = 'live'"
                  :class="['flex-1 py-2 text-xs font-semibold rounded-xl border transition-colors',
                    form.playlist_type === 'live'
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                      : 'bg-[#22263a] border-[#2e3250] text-slate-500 hover:border-slate-500']">
                  📺 Live
                </button>
                <button type="button" @click="form.playlist_type = 'vod'"
                  :class="['flex-1 py-2 text-xs font-semibold rounded-xl border transition-colors',
                    form.playlist_type === 'vod'
                      ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                      : 'bg-[#22263a] border-[#2e3250] text-slate-500 hover:border-slate-500']">
                  🎬 VOD
                </button>
              </div>
              <p v-if="form.playlist_type === 'vod'" class="text-[10px] text-slate-600 mt-1">VOD playlists are managed via the VOD Playlists page and excluded from EPG mapping</p>
            </div>

            <!-- Auto-generated M3U URL — only shown when editing an existing playlist -->
            <div v-if="editing" class="rounded-xl bg-[#22263a] border border-[#2e3250] px-3 py-2.5">
              <p class="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">M3U Stream URL</p>
              <div class="flex items-center gap-2">
                <span class="flex-1 font-mono text-xs text-emerald-400 truncate">{{ proxyUrl(editing) }}</span>
                <button
                  type="button"
                  @click="copyProxyUrl(editing)"
                  :class="['shrink-0 text-[10px] px-2 py-1 rounded-lg border transition-colors',
                    copied === editing.id
                      ? 'bg-green-500/20 border-green-500/30 text-green-400'
                      : 'border-[#3a3f5c] text-slate-400 hover:text-slate-200 hover:border-slate-500']"
                >{{ copied === editing.id ? '✓ Copied' : 'Copy' }}</button>
              </div>
              <p class="text-[10px] text-slate-600 mt-1.5">Use this URL in Emby, Jellyfin, Plex, or any IPTV app</p>
            </div>

            <!-- Advanced: disk output for Tuliprox -->
            <div>
              <button
                type="button"
                @click="showAdvanced = !showAdvanced"
                class="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                <span :class="['transition-transform text-[10px]', showAdvanced ? 'rotate-90' : '']">▶</span>
                Advanced — Disk output (Tuliprox)
              </button>
              <div v-if="showAdvanced" class="mt-2 space-y-3">
                <div>
                  <label class="block text-xs text-slate-500 mb-1.5">Output Path</label>
                  <input v-model="form.output_path" placeholder="/output/us-channels.m3u" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
                  <p class="text-xs text-slate-600 mt-1">Path inside the container. Mount <code>/output</code> to your Tuliprox config dir.</p>
                </div>
                <div>
                  <label class="block text-xs text-slate-500 mb-1.5">Auto-rebuild Schedule (cron)</label>
                  <input v-model="form.schedule" placeholder="0 */6 * * *" class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
                  <p class="text-xs text-slate-600 mt-1">e.g. <code>0 */6 * * *</code> = every 6 hours</p>
                </div>
              </div>
            </div>
          </div>

          <p v-if="error" class="text-xs text-red-400 mt-3">⚠ {{ error }}</p>

          <div class="flex gap-3 mt-5">
            <button @click="showForm = false" class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors">Cancel</button>
            <button @click="save" :disabled="loading || !form.name" class="flex-1 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors">
              {{ loading ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <GroupOrderModal
      v-if="showGroupOrder"
      :playlist-id="showGroupOrder.id"
      :playlist-name="showGroupOrder.name"
      @close="showGroupOrder = null"
      @saved="load"
    />
  </div>
</template>
