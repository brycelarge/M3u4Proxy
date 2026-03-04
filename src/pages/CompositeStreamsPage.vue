<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../composables/useApi.js'
import CompositeStreamEditor from '../components/CompositeStreamEditor.vue'

const streams = ref([])
const loading = ref(true)
const error = ref('')
const showEditor = ref(false)
const editingStream = ref(null)
const activeSessions = ref([])

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [streamsData, sessionsData] = await Promise.all([
      api.getCompositeStreams(),
      api.getActiveSessions()
    ])
    streams.value = streamsData
    activeSessions.value = sessionsData
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingStream.value = null
  showEditor.value = true
}

function openEdit(stream) {
  editingStream.value = stream
  showEditor.value = true
}

async function deleteStream(stream) {
  if (!confirm(`Delete composite stream "${stream.name}"?`)) return

  try {
    await api.deleteCompositeStream(stream.id)
    await load()
  } catch (e) {
    alert(`Failed to delete: ${e.message}`)
  }
}

async function toggleActive(stream) {
  try {
    await api.updateCompositeStream(stream.id, {
      ...stream,
      active: stream.active ? 0 : 1
    })
    await load()
  } catch (e) {
    alert(`Failed to update: ${e.message}`)
  }
}

async function stopSession(compositeId) {
  try {
    await api.stopCompositeStream(compositeId)
    await load()
  } catch (e) {
    alert(`Failed to stop: ${e.message}`)
  }
}

function getSessionStatus(compositeId) {
  return activeSessions.value.find(s => s.compositeId === compositeId)
}

function onEditorClose() {
  showEditor.value = false
  editingStream.value = null
  load()
}

onMounted(() => {
  load()
  // Refresh sessions every 5 seconds
  setInterval(() => {
    api.getActiveSessions().then(data => activeSessions.value = data).catch(() => {})
  }, 5000)
})
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-slate-100">Composite Streams</h1>
        <p class="text-sm text-slate-500 mt-1">Multi-view streaming with picture-in-picture</p>
      </div>
      <button
        @click="openCreate"
        class="px-4 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg font-semibold transition-colors flex items-center gap-2"
      >
        <span class="text-lg">+</span>
        Create Composite Stream
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12">
      <div class="inline-block w-8 h-8 border-4 border-slate-600 border-t-indigo-500 rounded-full animate-spin"></div>
      <p class="text-slate-500 mt-4">Loading streams...</p>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400">
      {{ error }}
    </div>

    <!-- Empty State -->
    <div v-else-if="streams.length === 0" class="text-center py-16">
      <div class="text-6xl mb-4">📺</div>
      <h3 class="text-lg font-semibold text-slate-300 mb-2">No composite streams yet</h3>
      <p class="text-slate-500 mb-6">Create your first multi-view stream with picture-in-picture</p>
      <button
        @click="openCreate"
        class="px-6 py-3 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg font-semibold transition-colors"
      >
        Create Composite Stream
      </button>
    </div>

    <!-- Streams List -->
    <div v-else class="grid gap-4">
      <div
        v-for="stream in streams"
        :key="stream.id"
        class="bg-[#1a1d27] border border-[#2e3250] rounded-xl p-5 hover:border-indigo-500/30 transition-colors"
      >
        <div class="flex items-start justify-between">
          <!-- Stream Info -->
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h3 class="text-lg font-semibold text-slate-100">{{ stream.name }}</h3>

              <!-- Active Badge -->
              <span
                v-if="stream.active"
                class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
              >
                Active
              </span>
              <span
                v-else
                class="text-xs px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-500 border border-slate-500/20"
              >
                Inactive
              </span>

              <!-- Session Status -->
              <span
                v-if="getSessionStatus(stream.id)"
                class="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 flex items-center gap-1"
              >
                <span class="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse"></span>
                Streaming ({{ getSessionStatus(stream.id).clients }} viewers)
              </span>
            </div>

            <p v-if="stream.description" class="text-sm text-slate-400 mb-3">{{ stream.description }}</p>

            <div class="flex items-center gap-4 text-xs text-slate-500">
              <span>{{ stream.source_count }} sources</span>
              <span>•</span>
              <span>Created {{ new Date(stream.created_at).toLocaleDateString() }}</span>
              <span v-if="stream.updated_at !== stream.created_at">
                • Updated {{ new Date(stream.updated_at).toLocaleDateString() }}
              </span>
            </div>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-2">
            <!-- Play Button -->
            <a
              :href="`/composite-stream/${stream.id}/playlist.m3u8`"
              target="_blank"
              class="p-2 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
              title="Play Stream"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </a>

            <!-- Stop Session -->
            <button
              v-if="getSessionStatus(stream.id)"
              @click="stopSession(stream.id)"
              class="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title="Stop Session"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
            </button>

            <!-- Edit -->
            <button
              @click="openEdit(stream)"
              class="p-2 text-slate-400 hover:bg-slate-500/10 rounded-lg transition-colors"
              title="Edit"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>

            <!-- Toggle Active -->
            <button
              @click="toggleActive(stream)"
              class="p-2 text-slate-400 hover:bg-slate-500/10 rounded-lg transition-colors"
              :title="stream.active ? 'Deactivate' : 'Activate'"
            >
              <svg v-if="stream.active" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            </button>

            <!-- Delete -->
            <button
              @click="deleteStream(stream)"
              class="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title="Delete"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Editor Modal -->
    <CompositeStreamEditor
      v-if="showEditor"
      :stream="editingStream"
      @close="onEditorClose"
      @saved="onEditorClose"
    />
  </div>
</template>
