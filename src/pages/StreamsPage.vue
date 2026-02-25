<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../composables/useApi.js'

const streams  = ref([])
const sources  = ref([])
const error    = ref('')
let   interval = null

async function load() {
  try {
    const [s, src] = await Promise.all([api.getStreams(), api.getSources()])
    streams.value = s
    sources.value = src.filter(s => s.category !== 'epg')
    error.value   = ''
  } catch (e) {
    error.value = e.message
  }
}

async function kill(channelId) {
  await api.killStream(channelId)
  await load()
}

function fmt(bytes) {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function fmtBitrate(bps) {
  if (!bps) return '—'
  if (bps < 1024)        return `${bps} B/s`
  if (bps < 1024 ** 2)   return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
}

function elapsed(startedAt) {
  const secs = Math.floor((Date.now() - new Date(startedAt)) / 1000)
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const totals = computed(() => ({
  streams:  streams.value.length,
  clients:  streams.value.reduce((s, x) => s + x.clients, 0),
  bytesIn:  streams.value.reduce((s, x) => s + (x.bytesIn  || 0), 0),
  bytesOut: streams.value.reduce((s, x) => s + (x.bytesOut || 0), 0),
  bitrate:  streams.value.reduce((s, x) => s + (x.bitrate  || 0), 0),
}))

// Group streams by sourceId, with an "Unknown" bucket for unmatched
const grouped = computed(() => {
  const sourceMap = new Map(sources.value.map(s => [s.id, s]))
  const groups = new Map()

  for (const stream of streams.value) {
    const sid = stream.sourceId
    const src = sid ? sourceMap.get(sid) : null
    const key = sid ?? 'unknown'
    if (!groups.has(key)) {
      groups.set(key, {
        source: src || { id: null, name: 'Unknown Source', max_streams: 0 },
        streams: [],
      })
    }
    groups.get(key).streams.push(stream)
  }

  // Also include sources with max_streams set but no active streams (show empty slots)
  for (const src of sources.value) {
    if (src.max_streams > 0 && !groups.has(src.id)) {
      groups.set(src.id, { source: src, streams: [] })
    }
  }

  return [...groups.values()].sort((a, b) => b.streams.length - a.streams.length)
})

onMounted(() => {
  load()
  interval = setInterval(load, 3000)
})

onUnmounted(() => clearInterval(interval))
</script>

<template>
  <div class="p-3 sm:p-6 max-w-6xl mx-auto">
    <div class="flex items-center justify-between gap-3 mb-4 sm:mb-6 flex-wrap">
      <div>
        <h1 class="text-lg font-bold text-slate-100">Active Streams</h1>
        <p class="text-xs text-slate-500 mt-0.5">Live upstream connections · refreshes every 3s</p>
      </div>
      <!-- Totals summary -->
      <div v-if="streams.length" class="flex items-center gap-4 text-xs">
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
          <span class="text-slate-300 font-semibold">{{ totals.streams }}</span>
          <span class="text-slate-500">streams</span>
        </div>
        <div class="text-slate-600">·</div>
        <div>
          <span class="text-slate-300 font-semibold">{{ totals.clients }}</span>
          <span class="text-slate-500"> clients</span>
        </div>
        <div class="text-slate-600">·</div>
        <div title="Total received from upstream">
          <span class="text-blue-400 font-semibold">↓ {{ fmt(totals.bytesIn) }}</span>
        </div>
        <div class="text-slate-600">·</div>
        <div title="Total sent to clients">
          <span class="text-emerald-400 font-semibold">↑ {{ fmt(totals.bytesOut) }}</span>
        </div>
        <div class="text-slate-600">·</div>
        <div title="Combined upstream bitrate">
          <span class="text-amber-400 font-semibold">{{ fmtBitrate(totals.bitrate) }}</span>
        </div>
      </div>
      <span v-else class="flex items-center gap-1.5 text-xs text-slate-500">
        <span class="w-2 h-2 rounded-full bg-slate-600"></span>
        No active streams
      </span>
    </div>

    <p v-if="error" class="text-xs text-red-400 mb-4">⚠ {{ error }}</p>

    <!-- Empty state -->
    <div v-if="!streams.length && !grouped.length" class="text-center py-20 text-slate-500">
      <p class="text-5xl mb-4">📡</p>
      <p class="text-sm font-medium text-slate-400">No active streams</p>
      <p class="text-xs mt-1">Streams appear here when clients connect via the proxy M3U</p>
    </div>

    <!-- Per-source groups -->
    <div class="space-y-6">
      <div v-for="group in grouped" :key="group.source.id ?? 'unknown'">

        <!-- Source header + tuner slot SVG -->
        <div class="flex items-center gap-4 mb-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-bold text-slate-200">{{ group.source.name }}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-semibold">
                {{ group.streams.length }}{{ group.source.max_streams > 0 ? ` / ${group.source.max_streams}` : '' }} streams
              </span>
              <!-- Warning if at limit -->
              <span
                v-if="group.source.max_streams > 0 && group.streams.length >= group.source.max_streams"
                class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-semibold"
              >⚠ At limit</span>
            </div>
          </div>

          <!-- Tuner slots SVG -->
          <div v-if="group.source.max_streams > 0" class="shrink-0 flex items-center gap-1" :title="`${group.streams.length} of ${group.source.max_streams} tuner slots used`">
            <svg
              :width="Math.min(group.source.max_streams, 32) * 14"
              height="20"
              :viewBox="`0 0 ${Math.min(group.source.max_streams, 32) * 14} 20`"
            >
              <g v-for="i in Math.min(group.source.max_streams, 32)" :key="i">
                <rect
                  :x="(i - 1) * 14"
                  y="2"
                  width="11"
                  height="16"
                  rx="3"
                  :fill="i <= group.streams.length ? '#ef4444' : '#1e2235'"
                  :stroke="i <= group.streams.length ? '#f87171' : '#2e3250'"
                  stroke-width="1"
                />
                <!-- Animated pulse line for active slots -->
                <rect
                  v-if="i <= group.streams.length"
                  :x="(i - 1) * 14 + 3"
                  y="8"
                  width="5"
                  height="2"
                  rx="1"
                  fill="#fca5a5"
                  opacity="0.8"
                />
              </g>
              <!-- +N overflow label if > 32 slots -->
              <text
                v-if="group.source.max_streams > 32"
                :x="32 * 14 + 2"
                y="14"
                font-size="9"
                fill="#64748b"
              >+{{ group.source.max_streams - 32 }}</text>
            </svg>
          </div>
        </div>

        <!-- Stream rows -->
        <div class="space-y-2">
          <div
            v-for="s in group.streams" :key="s.channelId"
            class="flex items-center gap-4 bg-[#1a1d27] border border-[#2e3250] rounded-xl px-4 py-3"
          >
            <!-- Live dot -->
            <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0"></span>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-sm text-slate-100 truncate">{{ s.channelName }}</p>
              <div class="flex flex-wrap gap-2 mt-0.5 text-xs text-slate-500">
                <span><span class="text-slate-300 font-medium">{{ s.clients }}</span> {{ s.clients === 1 ? 'client' : 'clients' }}</span>
                <template v-if="s.clients > 1">
                  <span class="text-slate-700">·</span>
                  <span class="text-green-400 font-medium" title="Multiple clients sharing one upstream connection">🔗 Shared</span>
                </template>
                <span class="text-slate-700">·</span>
                <span title="Upstream bitrate" class="text-amber-400 font-medium">{{ fmtBitrate(s.bitrate) }}</span>
                <span class="text-slate-700">·</span>
                <span title="Bytes received from upstream">↓ <span class="text-blue-400">{{ fmt(s.bytesIn) }}</span></span>
                <span class="text-slate-700">·</span>
                <span title="Bytes sent to clients">↑ <span class="text-emerald-400">{{ fmt(s.bytesOut || 0) }}</span></span>
                <span class="text-slate-700">·</span>
                <span title="Session duration">{{ elapsed(s.startedAt) }}</span>
                <template v-if="s.ffmpegRemux">
                  <span class="text-slate-700">·</span>
                  <span
                    class="text-purple-400 font-medium"
                    :title="s.transcodeReason || 'Stream is being remuxed with FFmpeg'"
                  >
                    🎬 FFmpeg{{ s.transcodeReason ? `: ${s.transcodeReason}` : '' }}
                  </span>
                </template>
                <template v-else>
                  <span class="text-slate-700">·</span>
                  <span class="text-cyan-400" title="Stream is buffered only (no remuxing)">⏱️ Buffered</span>
                </template>
                <template v-if="s.reconnects > 0">
                  <span class="text-slate-700">·</span>
                  <span class="text-amber-500" title="Reconnect count">⚡ {{ s.reconnects }} reconnect{{ s.reconnects > 1 ? 's' : '' }}</span>
                </template>
              </div>
            </div>

            <!-- Client pips -->
            <div class="flex gap-1 shrink-0">
              <span
                v-for="i in Math.min(s.clients, 10)" :key="i"
                class="w-2 h-2 rounded-full bg-indigo-500"
              ></span>
              <span v-if="s.clients > 10" class="text-[10px] text-slate-500 ml-0.5">+{{ s.clients - 10 }}</span>
            </div>

            <!-- Kill -->
            <button
              @click="kill(s.channelId)"
              class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-red-900/50 rounded-lg hover:border-red-500 text-red-400 transition-colors shrink-0"
            >✕</button>
          </div>

          <!-- Empty slots placeholder when source has limit but no streams -->
          <div
            v-if="group.streams.length === 0 && group.source.max_streams > 0"
            class="text-xs text-slate-700 px-4 py-3 bg-[#1a1d27] border border-[#2e3250] rounded-xl"
          >All {{ group.source.max_streams }} tuner slots available</div>
        </div>

      </div>
    </div>
  </div>
</template>
