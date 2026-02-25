<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../composables/useApi.js'
import { useBrowser } from '../composables/useBrowser.js'
import GroupSidebar       from '../components/GroupSidebar.vue'
import ChannelGrid        from '../components/ChannelGrid.vue'
import ChannelTable       from '../components/ChannelTable.vue'
import ReviewSelectionModal from '../components/ReviewSelectionModal.vue'

const {
  loading, error, groups, channels, selectionMap,
  search, groupSearch, activeGroup, loadingGroup, copied, urlCopied,
  viewMode, exporting, gridCols,
  currentSelected, selectedCount, totalCount, groupState, selectionCounts,
  filtered, filteredRows, sectionedGroups, groupTotal,
  activeSourceId, activeSourceName, lastFetched,
  activePlaylistId, activePlaylistName, saving, building, saveError, loadingSelection,
  selectGroup, loadMoreChannels, loadSourceFromCache,
  loadPlaylistSelection, saveToPlaylist, buildPlaylist,
  toggleChannel, selectAll, selectNone, toggleGroup, toggleSection,
  exportM3U, copyM3U, copyPlaylistUrl, openInWebPlayer,
  setGroupOverride, getAllSelectedChannels, groupOverrides,
  setChannelNumbers, channelNumbers,
  setEpgOverride, epgOverrides,
  setEpgSourceOverride, epgSourceOverrides,
  setNameOverride, nameOverrides,
} = useBrowser()

const allSources   = ref([])
const allPlaylists = ref([])
const showPlaylistModal = ref(false)
const playlistForm = ref({ name: '', type: 'live' })
const isEditingPlaylist = ref(false)

// Find Other Sources modal
const showVariantsModal = ref(false)
const variantsLoading = ref(false)
const variantsChannel = ref(null)
const channelVariants = ref([])

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

function openCreatePlaylistModal() {
  playlistForm.value = { name: '', type: 'live' }
  isEditingPlaylist.value = false
  showPlaylistModal.value = true
}

async function createPlaylist() {
  if (!playlistForm.value.name.trim()) return

  try {
    const playlist = await api.createPlaylist({
      name: playlistForm.value.name,
      playlist_type: playlistForm.value.type,
    })
    allPlaylists.value.push(playlist)
    showPlaylistModal.value = false
    await switchPlaylist(playlist)
  } catch (e) {
    error.value = `Error creating playlist: ${e.message}`
  }
}

async function editPlaylist() {
  if (!playlistForm.value.name.trim()) return

  try {
    await api.updatePlaylist(activePlaylistId.value, {
      name: playlistForm.value.name,
      playlist_type: playlistForm.value.type
    })
    const playlist = allPlaylists.value.find(p => p.id === activePlaylistId.value)
    if (playlist) {
      playlist.name = playlistForm.value.name
      playlist.playlist_type = playlistForm.value.type
    }
    activePlaylistName.value = playlistForm.value.name
    showPlaylistModal.value = false
  } catch (e) {
    error.value = `Error updating playlist: ${e.message}`
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

async function findOtherSourcesBulk() {
  showVariantsModal.value = true
  variantsLoading.value = true
  channelVariants.value = []

  try {
    const selected = await getAllSelectedChannels()

    // Deduplicate by normalized_name - only search for one channel per normalized name
    const seenNames = new Map()
    for (const ch of selected) {
      if (ch.normalized_name && !seenNames.has(ch.normalized_name)) {
        seenNames.set(ch.normalized_name, ch.id)
      }
    }

    const channelIds = Array.from(seenNames.values())

    const response = await fetch('/api/source-channels/bulk-variants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelIds })
    }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`)
      return r.json()
    })

    channelVariants.value = response
  } catch (e) {
    alert(`Failed to load variants: ${e.message}`)
  } finally {
    variantsLoading.value = false
  }
}

// Check if a variant is currently in the selection
function isVariantSelected(variant) {
  // Check all groups in selectionMap for this variant ID
  for (const [groupName, selection] of Object.entries(selectionMap.value)) {
    if (selection instanceof Set && selection.has(variant.id)) {
      return true
    }
  }
  return false
}

// Toggle a variant in/out of selection
function toggleVariant(variant) {
  toggleChannel(variant)
}

// Add all variants for a specific channel
function addChannelVariants(variants) {
  for (const variant of variants) {
    if (!isVariantSelected(variant)) {
      toggleChannel(variant)
    }
  }
}

// Add all unselected variants
function addAllVariants() {
  for (const item of channelVariants.value) {
    for (const variant of item.variants) {
      if (!isVariantSelected(variant)) {
        toggleChannel(variant)
      }
    }
  }
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
        @toggle-section="toggleSection"
        @set-active="selectGroup"
        @close="sidebarOpen = false"
        @switch-source="switchSource"
        @switch-playlist="switchPlaylist"
        @create-playlist="openCreatePlaylistModal"
        @edit-playlist="openEditPlaylistModal"
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
              @find-variants="findOtherSources"
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
              v-if="selectedCount > 0"
              @click="findOtherSourcesBulk"
              class="flex items-center justify-center gap-1.5 px-4 py-2 text-xs bg-cyan-500/10 border border-cyan-500/30 rounded-xl hover:border-cyan-400 text-cyan-300 transition-colors font-medium w-full sm:w-auto"
            >🔍 Find Other Sources ({{ selectedCount.toLocaleString() }})</button>
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

    <!-- Playlist Form Modal -->
    <Teleport to="body">
      <div v-if="showPlaylistModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" @click.self="showPlaylistModal = false">
        <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md p-6 shadow-2xl">
          <h2 class="text-base font-bold mb-5">{{ isEditingPlaylist ? 'Edit Playlist' : 'New Playlist' }}</h2>

          <div class="space-y-4">
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Playlist Name</label>
              <input
                v-model="playlistForm.name"
                type="text"
                placeholder="e.g. Live TV, Movies, etc."
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500"
                @keyup.enter="isEditingPlaylist ? editPlaylist() : createPlaylist()"
              />
            </div>

            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Playlist Type</label>
              <div class="flex gap-2">
                <button
                  @click="playlistForm.type = 'live'"
                  :class="['flex-1 px-4 py-2.5 text-sm rounded-xl transition-colors font-medium',
                    playlistForm.type === 'live'
                      ? 'bg-indigo-500 text-white'
                      : 'bg-[#22263a] text-slate-400 hover:text-slate-200 border border-[#2e3250]']"
                >
                  📺 Live
                </button>
                <button
                  @click="playlistForm.type = 'vod'"
                  :class="['flex-1 px-4 py-2.5 text-sm rounded-xl transition-colors font-medium',
                    playlistForm.type === 'vod'
                      ? 'bg-indigo-500 text-white'
                      : 'bg-[#22263a] text-slate-400 hover:text-slate-200 border border-[#2e3250]']"
                >
                  🎬 VOD
                </button>
              </div>
              <p class="text-xs text-slate-600 mt-1.5">Live for TV channels, VOD for movies/series</p>
            </div>
          </div>

          <div class="flex gap-3 mt-6">
            <button
              @click="showPlaylistModal = false"
              class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors"
            >
              Cancel
            </button>
            <button
              @click="isEditingPlaylist ? editPlaylist() : createPlaylist()"
              :disabled="!playlistForm.name.trim()"
              class="flex-1 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors"
            >
              {{ isEditingPlaylist ? 'Save' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Find Other Sources Modal -->
    <Teleport to="body">
      <div v-if="showVariantsModal" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" @click.self="showVariantsModal = false">
        <div class="bg-[#13151f] border border-[#2e3250] rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] flex flex-col">
          <!-- Header -->
          <div class="flex items-center justify-between p-5 border-b border-[#2e3250]">
            <div>
              <h2 class="text-lg font-semibold text-slate-100">🔍 Other Sources</h2>
              <p class="text-xs text-slate-500 mt-1">{{ variantsChannel?.name }}</p>
            </div>
            <button @click="showVariantsModal = false" class="text-slate-500 hover:text-slate-300 text-2xl leading-none">&times;</button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto p-5">
            <div v-if="variantsLoading" class="flex flex-col items-center justify-center gap-3 py-12 text-slate-500">
              <span class="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
              <p class="text-base font-medium text-slate-300">Searching for variants...</p>
              <p class="text-xs text-slate-500">Looking for channels with the same name in other sources</p>
            </div>

            <div v-else-if="!channelVariants.length" class="flex flex-col items-center justify-center gap-3 py-12 text-slate-500">
              <span class="text-4xl">🔍</span>
              <p class="text-sm">No other sources found for selected channels</p>
            </div>

            <div v-else class="space-y-4">
              <div class="flex items-center justify-between mb-3">
                <p class="text-xs text-slate-500">Found variants for {{ channelVariants.length }} channel(s)</p>
                <button
                  @click="addAllVariants"
                  class="px-3 py-1.5 text-xs bg-cyan-500 hover:bg-cyan-400 text-white rounded-lg transition-colors whitespace-nowrap"
                >
                  Add All Variants
                </button>
              </div>

              <!-- Each channel with its variants -->
              <div v-for="item in channelVariants" :key="item.channel.id" class="space-y-2">
                <div class="flex items-center gap-2 px-3 py-2 bg-[#1a1d27] border-l-2 border-indigo-500 rounded">
                  <span class="font-semibold text-sm text-slate-200">{{ item.channel.tvg_name }}</span>
                  <span class="text-xs text-slate-600">•</span>
                  <span class="text-xs text-slate-500">{{ item.variants.length }} variant(s)</span>
                  <button
                    @click="addChannelVariants(item.variants)"
                    class="ml-auto px-2 py-1 text-[10px] bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-cyan-300 rounded transition-colors whitespace-nowrap"
                  >
                    Add All
                  </button>
                </div>

                <!-- Variants for this channel -->
                <div class="ml-4 space-y-2">
                  <div
                    v-for="variant in item.variants"
                    :key="variant.id"
                    class="flex items-center gap-3 p-3 bg-[#1a1d27] border border-[#2e3250] rounded-lg hover:border-cyan-500/50 transition-colors"
                  >
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-medium text-sm text-slate-200 truncate">{{ variant.tvg_name }}</span>
                        <span
                          v-if="variant.quality"
                          :class="['text-[9px] px-1.5 py-0.5 rounded border whitespace-nowrap',
                            variant.quality === 'UHD' ? 'bg-purple-500/15 border-purple-500/30 text-purple-400' :
                            variant.quality === 'FHD' ? 'bg-blue-500/15 border-blue-500/30 text-blue-400' :
                            variant.quality === 'HD' ? 'bg-green-500/15 border-green-500/30 text-green-400' :
                            variant.quality === 'SD' ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400' :
                            'bg-slate-500/15 border-slate-500/30 text-slate-400']"
                        >
                          {{ variant.quality }}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="text-xs text-slate-500">{{ variant.source_name }}</span>
                        <span class="text-xs text-slate-600">•</span>
                        <span class="text-xs text-slate-600 truncate">{{ variant.group_title }}</span>
                      </div>
                    </div>
                    <label class="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        :checked="isVariantSelected(variant)"
                        @change="toggleVariant(variant)"
                        class="w-4 h-4 rounded border-2 border-slate-600 bg-[#22263a] checked:bg-indigo-500 checked:border-indigo-500 cursor-pointer"
                      />
                      <span class="text-xs text-slate-400">{{ isVariantSelected(variant) ? 'Selected' : 'Select' }}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="flex justify-end gap-3 p-5 border-t border-[#2e3250]">
            <button
              @click="showVariantsModal = false"
              class="px-4 py-2 text-sm bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-300 hover:border-slate-500 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Teleport>

  </div>
</template>
