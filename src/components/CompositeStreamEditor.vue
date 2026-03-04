<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../composables/useApi.js'

const props = defineProps({
  stream: Object // null for create, object for edit
})

const emit = defineEmits(['close', 'saved'])

const form = ref({
  name: '',
  description: '',
  layout_config: {},
  audio_config: {},
  sources: []
})

const presets = ref({})
const selectedPreset = ref('main-pip-right')
const channels = ref([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const showChannelPicker = ref(false)
const pickingForRole = ref(null)

// Load data
onMounted(async () => {
  loading.value = true
  error.value = ''
  try {
    // Get composite playlists and their channels
    const allPlaylists = await api.getPlaylists()
    const compositePlaylists = allPlaylists.filter(p => p.playlist_type === 'composite')

    // Load layout presets first
    presets.value = await api.getLayoutPresets()

    // Load channels from all composite playlists
    if (compositePlaylists.length > 0) {
      const channelPromises = compositePlaylists.map(p => api.getPlaylistChannels(p.id))
      const channelArrays = await Promise.all(channelPromises)

      // Flatten and dedupe channels by ID
      const allChannels = channelArrays.flat()
      const uniqueChannels = Array.from(
        new Map(allChannels.map(ch => [ch.id, ch])).values()
      )
      channels.value = uniqueChannels
    } else {
      channels.value = []
    }

    if (props.stream) {
      // Edit mode - load existing stream
      const streamData = await api.getCompositeStream(props.stream.id)
      form.value = {
        name: streamData.name,
        description: streamData.description || '',
        layout_config: JSON.parse(streamData.layout_config),
        audio_config: JSON.parse(streamData.audio_config),
        sources: streamData.sources.map(s => ({
          channelId: s.source_channel_id,
          role: s.role,
          position: {
            x: s.position_x,
            y: s.position_y,
            w: s.width,
            h: s.height
          },
          channel: {
            tvg_name: s.tvg_name,
            tvg_logo: s.tvg_logo
          }
        }))
      }

      // Detect preset from layout
      const layoutStr = JSON.stringify(form.value.layout_config)
      for (const [key, preset] of Object.entries(presets.value)) {
        if (JSON.stringify(preset) === layoutStr) {
          selectedPreset.value = key
          break
        }
      }
    } else {
      // Create mode - use default preset
      applyPreset(selectedPreset.value)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

// Apply layout preset
function applyPreset(presetKey) {
  const preset = presets.value[presetKey]
  if (!preset) return

  form.value.layout_config = { ...preset }

  // Initialize sources array based on preset
  const roles = Object.keys(preset.sources)
  form.value.sources = roles.map(role => {
    const existing = form.value.sources.find(s => s.role === role)
    return existing || {
      channelId: null,
      role,
      position: preset.sources[role],
      channel: null
    }
  })
}

watch(selectedPreset, (newPreset) => {
  if (newPreset) applyPreset(newPreset)
})

// Open channel picker for a specific role
function openChannelPicker(role) {
  pickingForRole.value = role
  showChannelPicker.value = true
}

// Select channel for role
function selectChannel(channel) {
  const source = form.value.sources.find(s => s.role === pickingForRole.value)
  if (source) {
    source.channelId = channel.id
    source.channel = {
      tvg_name: channel.tvg_name,
      tvg_logo: channel.tvg_logo
    }
  }
  showChannelPicker.value = false
  pickingForRole.value = null
}

// Remove channel from role
function removeChannel(role) {
  const source = form.value.sources.find(s => s.role === role)
  if (source) {
    source.channelId = null
    source.channel = null
  }
}

// Get role display name
function getRoleName(role) {
  if (role === 'main') return 'Main Feed'
  if (role.startsWith('pip')) return `PiP ${role.replace('pip', '')}`
  return role
}

// Validate form
const isValid = computed(() => {
  if (!form.value.name.trim()) return false
  if (form.value.sources.length === 0) return false

  // At least one source must have a channel selected
  const hasChannels = form.value.sources.some(s => s.channelId)
  return hasChannels
})

// Save composite stream
async function save() {
  if (!isValid.value) return

  saving.value = true
  error.value = ''

  try {
    const data = {
      name: form.value.name,
      description: form.value.description,
      layout_config: form.value.layout_config,
      audio_config: form.value.audio_config,
      sources: form.value.sources.filter(s => s.channelId).map(s => ({
        channelId: s.channelId,
        role: s.role,
        position: s.position
      }))
    }

    if (props.stream) {
      await api.updateCompositeStream(props.stream.id, data)
    } else {
      await api.createCompositeStream(data)
    }

    emit('saved')
    emit('close')
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}

// Channel search
const channelSearch = ref('')
const filteredChannels = computed(() => {
  if (!channelSearch.value) return channels.value
  const q = channelSearch.value.toLowerCase()
  return channels.value.filter(ch =>
    ch.tvg_name?.toLowerCase().includes(q) ||
    ch.group_title?.toLowerCase().includes(q)
  )
})
</script>

<template>
  <div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 overflow-y-auto">
    <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl max-w-5xl w-full my-8">
      <!-- Header -->
      <div class="flex items-center justify-between p-6 border-b border-[#2e3250]">
        <div>
          <h2 class="text-xl font-bold text-slate-100">
            {{ stream ? 'Edit' : 'Create' }} Composite Stream
          </h2>
          <p class="text-sm text-slate-500 mt-1">Configure multi-view layout and sources</p>
        </div>
        <button
          @click="emit('close')"
          class="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 rounded-lg transition-colors"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="p-12 text-center">
        <div class="inline-block w-8 h-8 border-4 border-slate-600 border-t-indigo-500 rounded-full animate-spin"></div>
        <p class="text-slate-500 mt-4">Loading...</p>
      </div>

      <!-- Form -->
      <div v-else class="p-6 space-y-6">
        <!-- Error -->
        <div v-if="error" class="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-red-400 text-sm">
          {{ error }}
        </div>

        <!-- Basic Info -->
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-slate-300 mb-2">Stream Name *</label>
            <input
              v-model="form.name"
              type="text"
              placeholder="e.g., F1 Multi-View"
              class="w-full bg-[#13151f] border border-[#2e3250] rounded-lg px-4 py-2 text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-300 mb-2">Description</label>
            <textarea
              v-model="form.description"
              placeholder="Optional description"
              rows="2"
              class="w-full bg-[#13151f] border border-[#2e3250] rounded-lg px-4 py-2 text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none resize-none"
            ></textarea>
          </div>
        </div>

        <!-- Layout Preset -->
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-3">Layout Preset</label>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <button
              v-for="(preset, key) in presets"
              :key="key"
              @click="selectedPreset = key"
              :class="[
                'p-4 rounded-lg border-2 transition-all text-left',
                selectedPreset === key
                  ? 'border-indigo-500 bg-indigo-500/10'
                  : 'border-[#2e3250] bg-[#13151f] hover:border-indigo-500/50'
              ]"
            >
              <div class="text-sm font-semibold text-slate-200 mb-1">
                {{ key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') }}
              </div>
              <div class="text-xs text-slate-500">
                {{ Object.keys(preset.sources).length }} sources
              </div>
            </button>
          </div>
        </div>

        <!-- Source Configuration -->
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-3">Source Channels</label>
          <div class="space-y-3">
            <div
              v-for="source in form.sources"
              :key="source.role"
              class="bg-[#13151f] border border-[#2e3250] rounded-lg p-4"
            >
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-3">
                  <div class="text-sm font-semibold text-slate-200">
                    {{ getRoleName(source.role) }}
                  </div>
                  <div class="text-xs text-slate-500">
                    {{ source.position.w }}x{{ source.position.h }} @ ({{ source.position.x }}, {{ source.position.y }})
                  </div>
                </div>
              </div>

              <!-- Selected Channel -->
              <div v-if="source.channel" class="flex items-center gap-3 mb-2">
                <img
                  v-if="source.channel.tvg_logo"
                  :src="source.channel.tvg_logo"
                  class="w-12 h-12 rounded object-cover"
                  @error="e => e.target.style.display = 'none'"
                />
                <div class="flex-1">
                  <div class="text-sm text-slate-200">{{ source.channel.tvg_name }}</div>
                </div>
                <button
                  @click="removeChannel(source.role)"
                  class="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <!-- Select Channel Button -->
              <button
                @click="openChannelPicker(source.role)"
                class="w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm transition-colors"
              >
                {{ source.channel ? 'Change Channel' : 'Select Channel' }}
              </button>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div class="flex items-center justify-end gap-3 pt-4 border-t border-[#2e3250]">
          <button
            @click="emit('close')"
            class="px-4 py-2 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Cancel
          </button>
          <button
            @click="save"
            :disabled="!isValid || saving"
            class="px-6 py-2 bg-indigo-500 hover:bg-indigo-400 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <span v-if="saving" class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            {{ saving ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Channel Picker Modal -->
    <div v-if="showChannelPicker" class="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between p-4 border-b border-[#2e3250]">
          <h3 class="text-lg font-bold text-slate-100">Select Channel</h3>
          <button
            @click="showChannelPicker = false"
            class="p-2 text-slate-400 hover:text-slate-200 rounded-lg transition-colors"
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Search -->
        <div class="p-4 border-b border-[#2e3250]">
          <input
            v-model="channelSearch"
            type="text"
            placeholder="Search channels..."
            class="w-full bg-[#13151f] border border-[#2e3250] rounded-lg px-4 py-2 text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <!-- Channel List -->
        <div class="flex-1 overflow-y-auto p-4">
          <div class="space-y-2">
            <button
              v-for="channel in filteredChannels.slice(0, 100)"
              :key="channel.id"
              @click="selectChannel(channel)"
              class="w-full flex items-center gap-3 p-3 bg-[#13151f] hover:bg-slate-700/50 border border-[#2e3250] rounded-lg transition-colors text-left"
            >
              <img
                v-if="channel.tvg_logo"
                :src="channel.tvg_logo"
                class="w-10 h-10 rounded object-cover"
                @error="e => e.target.style.display = 'none'"
              />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-slate-200 truncate">{{ channel.tvg_name }}</div>
                <div class="text-xs text-slate-500 truncate">{{ channel.group_title }}</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
