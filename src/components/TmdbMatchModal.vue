<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  title: { type: Object, required: true }
})

const emit = defineEmits(['close', 'save'])

// Decode HTML entities
function decodeHtmlEntities(text) {
  if (!text) return text
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

const searchQuery = ref(decodeHtmlEntities(props.title.title))
const searchType = ref('both')
const searching = ref(false)
const searchResults = ref([])
const saving = ref(false)

async function searchTmdb() {
  searching.value = true
  try {
    const response = await fetch('/api/tmdb/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: searchQuery.value, type: searchType.value })
    })
    const data = await response.json()
    searchResults.value = data.results || []
  } catch (e) {
    console.error('Search error:', e)
  } finally {
    searching.value = false
  }
}

async function selectMatch(result) {
  saving.value = true
  try {
    const response = await fetch(`/api/tmdb/matches/${encodeURIComponent(props.title.title)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tmdb_id: result.tmdb_id,
        media_type: result.media_type,
        poster: result.poster,
        description: result.description,
        blocked: false
      })
    })
    if (response.ok) {
      emit('save', {
        tmdb_id: result.tmdb_id,
        media_type: result.media_type,
        poster: result.poster,
        description: result.description
      })
    }
  } catch (e) {
    console.error('Save error:', e)
  } finally {
    saving.value = false
  }
}

async function blockTitle() {
  if (!confirm(`Block "${props.title.title}" from enrichment?`)) return

  saving.value = true
  try {
    const response = await fetch(`/api/tmdb/block/${encodeURIComponent(props.title.title)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked: true })
    })
    if (response.ok) {
      emit('save', { blocked: true })
    }
  } catch (e) {
    console.error('Block error:', e)
  } finally {
    saving.value = false
  }
}

async function unblockTitle() {
  saving.value = true
  try {
    const response = await fetch(`/api/tmdb/block/${encodeURIComponent(props.title.title)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked: false })
    })
    if (response.ok) {
      emit('save', { blocked: false })
    }
  } catch (e) {
    console.error('Unblock error:', e)
  } finally {
    saving.value = false
  }
}

async function clearMatch() {
  if (!confirm(`Clear match for "${props.title.title}"?`)) return

  saving.value = true
  try {
    const response = await fetch(`/api/tmdb/matches/${encodeURIComponent(props.title.title)}`, {
      method: 'DELETE'
    })
    if (response.ok) {
      emit('save', { cleared: true })
    }
  } catch (e) {
    console.error('Clear error:', e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-4xl flex flex-col shadow-2xl" style="max-height: 90vh">

        <!-- Header -->
        <div class="flex items-center gap-3 px-5 py-4 border-b border-[#2e3250] shrink-0">
          <div class="flex-1">
            <h2 class="text-sm font-bold text-slate-100">{{ decodeHtmlEntities(title.title) }}</h2>
            <div class="flex items-center gap-3 text-xs text-slate-500 mt-0.5">
              <span>{{ title.programme_count }} programme{{ title.programme_count !== 1 ? 's' : '' }} in XMLTV</span>
              <span v-if="title.runtime_minutes" class="text-amber-400">• {{ title.runtime_minutes }} min</span>
              <span v-if="title.episode_info" class="text-cyan-400">• {{ title.episode_info }}</span>
            </div>
          </div>
          <button @click="emit('close')" class="text-slate-500 hover:text-slate-300 text-lg leading-none">✕</button>
        </div>

        <!-- Current Match -->
        <div v-if="title.status === 'matched'" class="p-5 border-b border-[#2e3250] bg-[#13151f]">
          <p class="text-xs text-slate-500 mb-3">Current Match</p>
          <div class="flex items-center gap-4 p-4 bg-[#1a1d27] border border-green-500/30 rounded-xl">
            <div class="w-16 h-24 shrink-0 rounded-lg overflow-hidden bg-[#22263a] flex items-center justify-center">
              <img v-if="title.poster" :src="title.poster" class="w-full h-full object-cover" />
              <span v-else class="text-2xl text-slate-600">🎬</span>
            </div>
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <h3 class="text-sm font-semibold text-slate-100">{{ title.title }}</h3>
                <span class="text-[9px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">
                  {{ title.media_type === 'tv' ? 'TV Show' : 'Movie' }}
                </span>
              </div>
              <p class="text-xs text-slate-500">TMDB ID: {{ title.tmdb_id }}</p>
              <p v-if="title.description" class="text-xs text-slate-600 mt-2 line-clamp-2">{{ title.description }}</p>
            </div>
          </div>
        </div>

        <!-- Search -->
        <div class="p-5 border-b border-[#2e3250]">
          <p class="text-xs text-slate-500 mb-3">Search TMDB</p>
          <div class="flex items-center gap-2 mb-3">
            <input v-model="searchQuery" placeholder="Search title..."
              @keyup.enter="searchTmdb"
              class="flex-1 px-3 py-2 text-sm bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            <select v-model="searchType"
              class="px-3 py-2 text-sm bg-[#22263a] border border-[#2e3250] rounded-lg text-slate-200 outline-none focus:border-indigo-500">
              <option value="both">TV & Movies</option>
              <option value="tv">TV Shows</option>
              <option value="movie">Movies</option>
            </select>
            <button @click="searchTmdb" :disabled="searching || !searchQuery"
              class="px-4 py-2 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors">
              {{ searching ? 'Searching...' : 'Search' }}
            </button>
          </div>
        </div>

        <!-- Results -->
        <div class="flex-1 overflow-y-auto p-5">
          <div v-if="searching" class="flex items-center justify-center py-12">
            <span class="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
          </div>

          <div v-else-if="!searchResults.length" class="text-center py-12 text-slate-600">
            <p class="text-sm">Search for a title to see results</p>
          </div>

          <div v-else class="space-y-2">
            <div v-for="result in searchResults" :key="`${result.media_type}-${result.tmdb_id}`"
              @click="selectMatch(result)"
              class="flex items-center gap-4 p-4 bg-[#1a1d27] border border-[#2e3250] rounded-xl hover:border-indigo-500 cursor-pointer transition-colors">

              <div class="w-16 h-24 shrink-0 rounded-lg overflow-hidden bg-[#22263a] flex items-center justify-center">
                <img v-if="result.poster" :src="result.poster" class="w-full h-full object-cover" />
                <span v-else class="text-2xl text-slate-600">🎬</span>
              </div>

              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <h3 class="text-sm font-semibold text-slate-100">{{ result.title }}</h3>
                  <span class="text-[9px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                    {{ result.media_type === 'tv' ? 'TV Show' : 'Movie' }}
                  </span>
                </div>
                <p class="text-xs text-slate-500">TMDB ID: {{ result.tmdb_id }} • {{ result.release_date || 'Unknown date' }}</p>
                <p v-if="result.description" class="text-xs text-slate-600 mt-2 line-clamp-2">{{ result.description }}</p>
              </div>

              <div class="shrink-0 text-slate-600">Select →</div>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-2 px-5 py-4 border-t border-[#2e3250] shrink-0">
          <button v-if="title.blocked" @click="unblockTitle" :disabled="saving"
            class="px-4 py-2 text-sm bg-green-500 hover:bg-green-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors">
            Unblock Title
          </button>
          <button v-else @click="blockTitle" :disabled="saving"
            class="px-4 py-2 text-sm bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-white font-semibold rounded-lg transition-colors">
            🚫 Block from Enrichment
          </button>

          <button v-if="title.status === 'matched'" @click="clearMatch" :disabled="saving"
            class="px-4 py-2 text-sm bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 disabled:opacity-40 text-red-400 font-semibold rounded-lg transition-colors">
            Clear Match
          </button>

          <div class="flex-1"></div>

          <button @click="emit('close')"
            class="px-4 py-2 text-sm bg-[#22263a] border border-[#2e3250] hover:border-slate-500 text-slate-300 font-semibold rounded-lg transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
