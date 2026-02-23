<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../composables/useApi.js'
import { useBrowser } from '../composables/useBrowser.js'
import GroupSidebar       from '../components/GroupSidebar.vue'
import ChannelGrid        from '../components/ChannelGrid.vue'
import ChannelTable       from '../components/ChannelTable.vue'
import ReviewSelectionModal from '../components/ReviewSelectionModal.vue'

const {
  loading, error, groups, channels,
  search, groupSearch, activeGroup, loadingGroup, copied, urlCopied,
  viewMode, exporting, gridCols,
  currentSelected, selectedCount, totalCount, groupState, selectionCounts,
  filtered, filteredRows, sectionedGroups, groupTotal,
  activeSourceId, activeSourceName, lastFetched,
  activePlaylistId, activePlaylistName, saving, building, saveError, loadingSelection,
  selectGroup, loadMoreChannels, loadSourceFromCache,
  loadPlaylistSelection, saveToPlaylist, buildPlaylist,
  toggleChannel, selectAll, selectNone, toggleGroup,
  exportM3U, copyM3U, copyPlaylistUrl, openInWebPlayer,
  setGroupOverride, getAllSelectedChannels, groupOverrides,
  setChannelNumbers, channelNumbers,
  setEpgOverride, epgOverrides,
  setEpgSourceOverride, epgSourceOverrides,
  setNameOverride, nameOverrides,
} = useBrowser()

const allSources   = ref([])
const allPlaylists = ref([])

async function loadMeta() {
  try {
    const [sources, playlists] = await Promise.all([api.getSources(), api.getPlaylists()])
    allSources.value   = sources.filter(s => s.category !== 'epg')
    allPlaylists.value = playlists
  } catch {}
}

async function switchSource(s) {
  // s=null means All Sources
  await loadSourceFromCache(s ? s.id : null, s ? s.name : '__all__')
}

async function switchPlaylist(p) {
  await loadPlaylistSelection(p.id, p.name)
}

async function createPlaylist() {
  const name = prompt('Enter new playlist name:')
  if (!name) return

  try {
    const playlist = await api.createPlaylist({
      name,
      playlist_type: 'live',
    })
    allPlaylists.value.push(playlist)
    await switchPlaylist(playlist)
  } catch (e) {
    alert(`Error creating playlist: ${e.message}`)
  }
}

async function editPlaylist() {
  if (!activePlaylistId.value) return

  const playlist = allPlaylists.value.find(p => p.id === activePlaylistId.value)
  if (!playlist) return

  const name = prompt('Enter new playlist name:', playlist.name)
  if (!name || name === playlist.name) return

  try {
    await api.updatePlaylist(playlist.id, { name })
    playlist.name = name
    activePlaylistName.value = name
  } catch (e) {
    alert(`Error updating playlist: ${e.message}`)
  }
}

async function deletePlaylist() {
  if (!activePlaylistId.value) return

  const playlist = allPlaylists.value.find(p => p.id === activePlaylistId.value)
  if (!playlist) return

  if (!confirm(`Are you sure you want to delete the playlist "${playlist.name}"?`)) return

  try {
    await api.deletePlaylist(playlist.id)
    allPlaylists.value = allPlaylists.value.filter(p => p.id !== playlist.id)
    activePlaylistId.value = null
    activePlaylistName.value = ''
    selectNone()
  } catch (e) {
    alert(`Error deleting playlist: ${e.message}`)
  }
}

async function saveAndRefresh() {
  await saveToPlaylist()
  allPlaylists.value = await api.getPlaylists()
}

async function buildAndRefresh() {
  await buildPlaylist()
  allPlaylists.value = await api.getPlaylists()
}

onMounted(loadMeta)

const sidebarOpen     = ref(false)
const showReview      = ref(false)
const reviewChannels  = ref([])
const reviewLoading   = ref(false)
const epgChannels     = ref([])

async function openReview() {
  showReview.value = true
  reviewLoading.value = true
  reviewChannels.value = []
  reviewChannels.value = await getAllSelectedChannels()
  reviewLoading.value = false
  // Load EPG channel IDs lazily when review opens
  if (!epgChannels.value.length) {
    try { epgChannels.value = await api.getCachedEpgChannels() } catch {}
  }
}

function onSetGroup({ ids, group }) {
  setGroupOverride(ids, group)
  reviewChannels.value = [...reviewChannels.value]
}

function onSetNumbers(updates) {
  setChannelNumbers(updates)
  reviewChannels.value = [...reviewChannels.value]
}

function onSetEpgId(payload) {
  setEpgOverride(payload)
}

function onSetEpgSource(payload) {
  setEpgSourceOverride(payload)
}

function onSetName(payload) {
  setNameOverride(payload)
}
</script>

<template>
  <div class="flex flex-col flex-1 overflow-hidden">
    <!-- Review Selection Modal -->
    <ReviewSelectionModal
      :show="showReview"
      :channels="reviewChannels"
      :group-overrides="groupOverrides"
      :channel-numbers="channelNumbers"
      :epg-overrides="epgOverrides"
      :epg-source-overrides="epgSourceOverrides"
      :name-overrides="nameOverrides"
      :epg-channels="epgChannels"
      :loading="reviewLoading"
      @close="showReview = false"
      @set-group="onSetGroup"
      @set-numbers="onSetNumbers"
      @set-epg-id="onSetEpgId"
      @set-epg-source="onSetEpgSource"
      @set-name="onSetName"
    />


    <div class="flex flex-1 overflow-hidden">

      <!-- Sidebar -->
      <GroupSidebar
        :groups="groups"
        :sectioned-groups="sectionedGroups"
        :group-state="groupState"
        :selection-counts="selectionCounts"
        :active-group="activeGroup"
        :group-search="groupSearch"
        v-model:group-search="groupSearch"
        :selected-count="selectedCount"
        :total-count="totalCount"
        :open="sidebarOpen"
        :loading-selection="loadingSelection"
        :all-sources="allSources"
        :all-playlists="allPlaylists"
        :active-source-id="activeSourceId"
        :active-source-name="activeSourceName"
        :active-playlist-id="activePlaylistId"
        :active-playlist-name="activePlaylistName"
        @select-group="selectGroup"
        @toggle-group="toggleGroup"
        @set-active="selectGroup"
        @close="sidebarOpen = false"
        @switch-source="switchSource"
        @switch-playlist="switchPlaylist"
        @create-playlist="createPlaylist"
        @edit-playlist="editPlaylist"
        @delete-playlist="deletePlaylist"
      />

      <!-- Content area -->
      <div class="flex flex-col flex-1 overflow-hidden">

        <!-- Middle scrollable area -->
        <div class="flex-1 flex flex-col overflow-hidden">

          <!-- Empty state -->
          <div v-if="!groups.length" class="flex flex-col flex-1 items-center justify-center gap-4 text-slate-500 p-10 text-center">
            <span class="text-6xl">📺</span>
            <h2 class="text-lg font-semibold text-slate-300">No playlist loaded</h2>
            <p class="text-sm max-w-xs leading-relaxed">
              Add a source on the <strong class="text-slate-200">Sources</strong> page, then select it from the dropdown above.
            </p>
          </div>

          <!-- Select group prompt -->
          <div
            v-else-if="!activeGroup || activeGroup === '__all__'"
            class="flex flex-col flex-1 items-center justify-center gap-3 text-slate-500 p-10 text-center"
          >
            <span class="text-5xl">👈</span>
            <h2 class="text-base font-semibold text-slate-300">Select a group to view channels</h2>
            <p class="text-sm">{{ groups.length.toLocaleString() }} groups · {{ totalCount.toLocaleString() }} total channels</p>
          </div>

          <!-- Loading group -->
          <div v-else-if="loadingGroup" class="flex flex-col flex-1 items-center justify-center gap-3 text-slate-500">
            <span class="w-8 h-8 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
            <p class="text-sm">Loading channels…</p>
          </div>

          <!-- Channel view -->
          <template v-else>
            <!-- Toolbar -->
            <div class="flex items-center gap-4 px-4 py-3 border-b border-[#2e3250] shrink-0 flex-wrap bg-[#13151f]">
              <!-- Mobile sidebar toggle button -->
              <button
                @click="sidebarOpen = !sidebarOpen"
                class="md:hidden flex items-center justify-center w-10 h-10 bg-indigo-600 rounded-lg text-white">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <div class="min-w-0">
                <h2 class="text-base font-semibold text-white truncate max-w-[160px] sm:max-w-none">{{ activeGroup }}</h2>
                <p class="text-xs text-slate-500 mt-0.5">All Channels</p>
              </div>
              <div class="relative flex-1 min-w-[120px]">
                <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">🔍</span>
                <input
                  v-model="search"
                  placeholder="Search channels..."
                  class="w-full bg-[#22263a] border border-[#2e3250] rounded pl-7 pr-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500"
                />
              </div>
              <div class="flex gap-1.5 shrink-0">
                <button @click="selectAll"  class="hidden sm:block px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 transition-colors">All</button>
                <button @click="selectNone" class="hidden sm:block px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 transition-colors">None</button>
                <button
                  @click="toggleGroup(activeGroup)"
                  :class="['px-2.5 py-1.5 text-xs rounded-lg border transition-colors font-medium whitespace-nowrap',
                    groupState[activeGroup] === 'all'
                      ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                      : 'bg-[#22263a] border-[#2e3250] text-slate-300 hover:border-indigo-400']"
                >{{ groupState[activeGroup] === 'all' ? '✓ Selected' : 'Select' }}</button>
                <!-- View toggle -->
                <div class="flex border border-[#2e3250] rounded-lg overflow-hidden">
                  <button
                    @click="viewMode = 'grid'"
                    :class="['px-2.5 py-1.5 text-xs transition-colors', viewMode === 'grid' ? 'bg-indigo-500 text-white' : 'bg-[#22263a] text-slate-400 hover:text-slate-200']"
                    title="Card view"
                  >
                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                      <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/>
                      <rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
                    </svg>
                  </button>
                  <button
                    @click="viewMode = 'table'"
                    :class="['px-2.5 py-1.5 text-xs transition-colors border-l border-[#2e3250]', viewMode === 'table' ? 'bg-indigo-500 text-white' : 'bg-[#22263a] text-slate-400 hover:text-slate-200']"
                    title="Table view"
                  >
                    <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 16 16">
                      <rect x="1" y="2" width="14" height="2" rx="1"/><rect x="1" y="7" width="14" height="2" rx="1"/>
                      <rect x="1" y="12" width="14" height="2" rx="1"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>

            <!-- Grid or Table -->
            <ChannelGrid
              v-if="viewMode === 'grid'"
              :filtered-rows="filteredRows"
              :grid-cols="gridCols"
              :current-selected="currentSelected"
              @toggle-channel="toggleChannel"
            />
            <ChannelTable
              v-else
              :filtered="filtered"
              :current-selected="currentSelected"
              @toggle-channel="toggleChannel"
              @select-all="selectAll"
              @select-none="selectNone"
            />

            <!-- Load more -->
            <div v-if="channels.length < groupTotal" class="shrink-0 flex items-center justify-center gap-3 py-3 border-t border-[#2e3250]">
              <span class="text-xs text-slate-500">Showing {{ channels.length.toLocaleString() }} of {{ groupTotal.toLocaleString() }}</span>
              <button
                @click="loadMoreChannels"
                :disabled="loadingGroup"
                class="px-4 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 disabled:opacity-40 transition-colors"
              >
                <span v-if="loadingGroup" class="w-3 h-3 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin inline-block mr-1"></span>
                Load more
              </button>
            </div>
          </template>

        </div><!-- end middle area -->

        <!-- Bottom action bar -->
        <div v-if="groups.length" class="flex flex-col sm:flex-row items-start sm:items-center gap-2 px-3 py-2.5 border-t border-[#2e3250] bg-[#1a1d27] shrink-0">
          <span class="text-xs text-slate-500 mb-2 sm:mb-0">{{ selectedCount.toLocaleString() }} selected</span>
          <span class="hidden sm:block flex-1"></span>

          <!-- Playlist mode: Save + Build -->
          <div v-if="activePlaylistId" class="flex flex-col-reverse sm:flex-row w-full sm:w-auto gap-2">
            <button
              v-if="selectedCount > 0 && allPlaylists.find(p => p.id === activePlaylistId)?.playlist_type !== 'vod'"
              @click="openReview"
              class="flex items-center justify-center gap-1.5 px-4 py-2 text-xs bg-amber-500/10 border border-amber-500/30 rounded-xl hover:border-amber-400 text-amber-300 transition-colors font-medium w-full sm:w-auto"
            >🗂️ Review &amp; Group ({{ selectedCount.toLocaleString() }})</button>
            <button
              @click="saveAndRefresh"
              :disabled="saving"
              class="flex items-center justify-center gap-1.5 px-4 py-2 text-xs bg-indigo-500/10 border border-indigo-500/40 rounded-xl hover:border-indigo-400 text-indigo-300 disabled:opacity-40 transition-colors font-medium w-full sm:w-auto"
            >
              <span v-if="saving" class="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin"></span>
              {{ saving ? 'Saving…' : '💾 Save to Playlist' }}
            </button>
          </div>

          <!-- No playlist: raw export fallback -->
          <template v-else>
            <button
              @click="copyM3U"
              :disabled="!selectedCount || exporting"
              class="flex items-center gap-1.5 px-4 py-2 text-xs bg-[#22263a] border border-[#2e3250] rounded-xl hover:border-indigo-400 text-slate-300 disabled:opacity-40 transition-colors"
            >
              <span v-if="exporting" class="w-3 h-3 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin"></span>
              {{ copied ? '✓ Copied!' : exporting ? 'Building…' : '📋 Copy M3U' }}
            </button>
            <button
              @click="exportM3U"
              :disabled="!selectedCount || exporting"
              class="flex items-center gap-1.5 px-4 py-2 text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl disabled:opacity-40 transition-colors"
            >
              <span v-if="exporting" class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
              {{ exporting ? 'Building…' : '⬇ Save M3U' }}
            </button>
          </template>
        </div>

      </div>
    </div>
  </div>
</template>
