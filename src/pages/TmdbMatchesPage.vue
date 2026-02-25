<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../composables/useApi.js'
import TmdbMatchModal from '../components/TmdbMatchModal.vue'

const loading = ref(true)
const titles = ref([])
const stats = ref({ matched: 0, not_found: 0, unmatched: 0, blocked: 0 })
const filterStatus = ref('all')
const searchQuery = ref('')
const sortBy = ref('title')
const selectedPlaylist = ref(1)
const playlists = ref([])
const showModal = ref(false)
const editingTitle = ref(null)

async function loadPlaylists() {
  try {
    playlists.value = await api.getPlaylists()
    if (playlists.value.length > 0 && !selectedPlaylist.value) {
      selectedPlaylist.value = playlists.value[0].id
    }
  } catch (e) {
    console.error('Error loading playlists:', e)
  }
}

async function loadTitles() {
  if (!selectedPlaylist.value) return
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filterStatus.value !== 'all') params.append('filter', filterStatus.value)
    if (searchQuery.value) params.append('search', searchQuery.value)
    
    const response = await fetch(`/api/tmdb/titles/${selectedPlaylist.value}?${params}`)
    const data = await response.json()
    titles.value = data.titles || []
    stats.value = data.stats || { matched: 0, not_found: 0, unmatched: 0, blocked: 0 }
  } catch (e) {
    console.error('Error loading titles:', e)
  } finally {
    loading.value = false
  }
}

const sortedTitles = computed(() => {
  const sorted = [...titles.value]
  if (sortBy.value === 'title') {
    sorted.sort((a, b) => a.title.localeCompare(b.title))
  } else if (sortBy.value === 'count') {
    sorted.sort((a, b) => b.programme_count - a.programme_count)
  } else if (sortBy.value === 'date') {
    sorted.sort((a, b) => {
      if (!a.fetched_at) return 1
      if (!b.fetched_at) return -1
      return new Date(b.fetched_at) - new Date(a.fetched_at)
    })
  }
  return sorted
})

function getStatusBadge(status) {
  const badges = {
    matched: { class: 'bg-green-500/20 text-green-400 border-green-500/30', icon: '✓', label: 'Matched' },
    not_found: { class: 'bg-red-500/20 text-red-400 border-red-500/30', icon: '⚠', label: 'Not Found' },
    unmatched: { class: 'bg-slate-500/20 text-slate-400 border-slate-500/30', icon: '⭕', label: 'Unmatched' },
    blocked: { class: 'bg-amber-500/20 text-amber-400 border-amber-500/30', icon: '🚫', label: 'Blocked' }
  }
  return badges[status] || badges.unmatched
}

function openEditModal(title) {
  editingTitle.value = title
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  editingTitle.value = null
}

async function handleSave() {
  closeModal()
  await loadTitles()
}

onMounted(async () => {
  await loadPlaylists()
  await loadTitles()
})
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden bg-[#13151f]">
    <!-- Header -->
    <div class="flex items-center gap-4 px-6 py-4 bg-[#1a1d27] border-b border-[#2e3250] shrink-0">
      <div class="flex-1">
        <h1 class="text-sm font-bold text-slate-100">TMDB Match Corrector</h1>
        <p class="text-xs text-slate-500">Review and correct TMDB enrichment matches</p>
      </div>
    </div>

    <!-- Stats Bar -->
    <div class="flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-[#2e3250] shrink-0">
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20">
        <span class="text-xs text-green-400">✓ Matched</span>
        <span class="text-sm font-bold text-green-300">{{ stats.matched }}</span>
      </div>
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-500/10 border border-slate-500/20">
        <span class="text-xs text-slate-400">⭕ Unmatched</span>
        <span class="text-sm font-bold text-slate-300">{{ stats.unmatched }}</span>
      </div>
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
        <span class="text-xs text-red-400">⚠ Not Found</span>
        <span class="text-sm font-bold text-red-300">{{ stats.not_found }}</span>
      </div>
      <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
        <span class="text-xs text-amber-400">🚫 Blocked</span>
        <span class="text-sm font-bold text-amber-300">{{ stats.blocked }}</span>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex items-center gap-3 px-6 py-3 bg-[#1a1d27] border-b border-[#2e3250] shrink-0">
      <select v-model="selectedPlaylist" @change="loadTitles" 
        class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
        <option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      
      <select v-model="filterStatus" @change="loadTitles"
        class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
        <option value="all">All Status</option>
        <option value="matched">Matched</option>
        <option value="unmatched">Unmatched</option>
        <option value="not_found">Not Found</option>
        <option value="blocked">Blocked</option>
      </select>

      <select v-model="sortBy"
        class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
        <option value="title">Sort: Title (A-Z)</option>
        <option value="count">Sort: Programme Count</option>
        <option value="date">Sort: Last Fetched</option>
      </select>

      <input v-model="searchQuery" @input="loadTitles" placeholder="Search titles..."
        class="flex-1 px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
    </div>

    <!-- Title List -->
    <div class="flex-1 overflow-y-auto px-6 py-4">
      <div v-if="loading" class="flex items-center justify-center py-12">
        <span class="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
      </div>

      <div v-else-if="!sortedTitles.length" class="text-center py-12 text-slate-600">
        <p class="text-sm">No titles found</p>
      </div>

      <div v-else class="space-y-2">
        <div v-for="title in sortedTitles" :key="title.title"
          @click="openEditModal(title)"
          class="flex items-center gap-4 p-4 bg-[#1a1d27] border border-[#2e3250] rounded-xl hover:border-indigo-500/50 cursor-pointer transition-colors">
          
          <!-- Poster -->
          <div class="w-16 h-24 shrink-0 rounded-lg overflow-hidden bg-[#22263a] flex items-center justify-center">
            <img v-if="title.poster" :src="title.poster" class="w-full h-full object-cover" />
            <span v-else class="text-2xl text-slate-600">🎬</span>
          </div>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <h3 class="text-sm font-semibold text-slate-100 truncate">{{ title.title }}</h3>
              <span :class="['text-[9px] px-2 py-0.5 rounded-full border', getStatusBadge(title.status).class]">
                {{ getStatusBadge(title.status).icon }} {{ getStatusBadge(title.status).label }}
              </span>
              <span v-if="title.manual_override" class="text-[9px] px-2 py-0.5 rounded-full border bg-purple-500/20 text-purple-400 border-purple-500/30">
                ✏️ Manual
              </span>
            </div>
            
            <div class="flex items-center gap-3 text-xs text-slate-500">
              <span>{{ title.programme_count }} programme{{ title.programme_count !== 1 ? 's' : '' }}</span>
              <span v-if="title.media_type">• {{ title.media_type === 'tv' ? 'TV Show' : 'Movie' }}</span>
              <span v-if="title.tmdb_id">• TMDB ID: {{ title.tmdb_id }}</span>
              <span v-if="title.episode_count">• {{ title.episode_count }} episodes</span>
              <span v-if="title.fetched_at">• {{ new Date(title.fetched_at).toLocaleDateString() }}</span>
            </div>

            <p v-if="title.description" class="text-xs text-slate-600 mt-1 line-clamp-2">{{ title.description }}</p>
          </div>

          <!-- Arrow -->
          <div class="shrink-0 text-slate-600">→</div>
        </div>
      </div>
    </div>

    <!-- Modal -->
    <TmdbMatchModal 
      v-if="showModal"
      :title="editingTitle"
      @close="closeModal"
      @save="handleSave"
    />
  </div>
</template>
