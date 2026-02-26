<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

const loading     = ref(false)
const error       = ref('')
const channels    = ref([])
const from        = ref(null)
const to          = ref(null)
const currentTime = ref(new Date())
const selected    = ref(null)
const isMobile    = ref(false)

// Layout constants
const CHAN_W   = 60   // sticky channel column px for mobile
const CHAN_W_DESKTOP = 200   // sticky channel column px for desktop
const PX_PER_MIN = 4  // 1 min = 4px → 1hr = 240px

let clockTimer = null

async function load() {
  loading.value = true
  error.value   = ''
  try {
    // Get active playlist from localStorage
    const activePlaylistId = localStorage.getItem('m3u_playlist_id')

    // Load 24h of EPG data starting from current time
    const now = new Date()

    // Use current time directly, don't round to hour
    const utcDate = now
    const p = new URLSearchParams({
      hours: 24,
      from: utcDate.toISOString(),
      ...(activePlaylistId && { playlist_id: activePlaylistId })
    })
    const r = await fetch(`/api/epg/guide-grid?${p}`)
    const d = await r.json()
    if (!r.ok) throw new Error(d.error)

    channels.value = d.channels
    from.value     = new Date(d.from)
    to.value       = new Date(d.to)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

// Total programme area width in px (24h = 1440 min × 4px = 5760px)
const progW = computed(() => {
  if (!from.value || !to.value) return 5760
  const mins = (to.value.getTime() - from.value.getTime()) / 60000
  return mins * PX_PER_MIN
})
// Total grid width = channel col + programme area
const gridW = computed(() => (isMobile.value ? CHAN_W : CHAN_W_DESKTOP) + progW.value)

// Time slot markers every 30 min
const timeSlots = computed(() => {
  if (!from.value || !to.value) return []
  const slots = []
  const totalMins = (to.value.getTime() - from.value.getTime()) / 60000
  for (let m = 0; m <= totalMins; m += 30) {
    const t = new Date(from.value.getTime() + m * 60000)
    slots.push({
      label: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      left:  m * PX_PER_MIN,
    })
  }
  return slots
})

const nowLeft = computed(() => {
  if (!from.value || !to.value) return null
  const now = currentTime.value.getTime()
  if (now < from.value.getTime() || now > to.value.getTime()) return null
  return ((now - from.value.getTime()) / 60000) * PX_PER_MIN
})

function progStyle(prog) {
  if (!from.value || !to.value) return { display: 'none' }

  // Convert string dates to timestamps
  const startTime = new Date(prog.start).getTime()
  const stopTime = new Date(prog.stop).getTime()
  const fromTime = from.value.getTime()
  const toTime = to.value.getTime()

  // Check if programme is outside the visible window
  if (startTime >= toTime || stopTime <= fromTime) {
    return { display: 'none' }
  }

  // Calculate position and width
  const pStart = Math.max(startTime, fromTime)
  const pStop = Math.min(stopTime, toTime)
  const left = ((pStart - fromTime) / 60000) * PX_PER_MIN
  const width = Math.max(((pStop - pStart) / 60000) * PX_PER_MIN - 2, 2)

  return { left: `${left}px`, width: `${width}px` }
}

function isNow(prog) {
  const now = currentTime.value.getTime()
  return new Date(prog.start) <= now && new Date(prog.stop) > now
}
function fmtTime(iso) {
  // Format time in system timezone (not UTC)
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtDuration(prog) {
  const mins = Math.round((new Date(prog.stop) - new Date(prog.start)) / 60000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60), m = mins % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
function progProgress(prog) {
  const now = currentTime.value.getTime()
  const s = new Date(prog.start).getTime()
  const e = new Date(prog.stop).getTime()
  if (now < s || now > e) return 0
  return Math.round(((now - s) / (e - s)) * 100)
}

function playStream() {
  if (!selected.value?.channelId) return
  const channelName = encodeURIComponent(selected.value.channelName)
  const url = `/web-player/${selected.value.channelId}?name=${channelName}`
  window.open(url, '_blank', 'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no')
}

onMounted(() => {
  load()
  clockTimer = setInterval(() => { currentTime.value = new Date() }, 30000)

  // Check if mobile on mount
  isMobile.value = window.innerWidth < 640

  // Add resize listener
  window.addEventListener('resize', () => {
    isMobile.value = window.innerWidth < 640
  })
})
onUnmounted(() => {
  clearInterval(clockTimer)
  // Remove resize listener
  window.removeEventListener('resize', () => {
    isMobile.value = window.innerWidth < 640
  })
})
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden bg-[#0f1117]">

    <!-- Toolbar -->
    <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[#2e3250] shrink-0 bg-[#1a1d27]">
      <h1 class="text-sm font-bold text-slate-100 shrink-0">📺 EPG Guide</h1>
      <span class="text-xs text-slate-600 shrink-0">24 hours · mapped channels only</span>
      <div class="flex-1"></div>
      <button @click="load" :disabled="loading"
        class="px-2.5 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-slate-500 text-slate-400 rounded-lg transition-colors disabled:opacity-40">
        ↺ Refresh
      </button>
    </div>

    <div v-if="error" class="mx-4 mt-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300 shrink-0">⚠ {{ error }}</div>

    <div v-if="loading && !channels.length" class="flex-1 flex items-center justify-center gap-3 text-slate-500">
      <span class="w-6 h-6 border-2 border-indigo-500/30 border-t-indigo-400 rounded-full animate-spin"></span>
      <span class="text-sm">Loading guide…</span>
    </div>

    <div v-else-if="!loading && !channels.length" class="flex-1 flex flex-col items-center justify-center text-slate-500 gap-3">
      <span class="text-5xl">📭</span>
      <p class="text-sm">No guide data for mapped channels</p>
      <p class="text-xs text-slate-600">Fetch an EPG source and map channels in EPG Mappings first</p>
    </div>

    <!-- Debug info removed -->

    <!--
      Single overflow:auto container.
      Inner div has a fixed total width (wider than viewport) → enables horizontal scroll.
      Channel column: position sticky left:0 → stays pinned while scrolling right.
      Time header row: position sticky top:0 → stays pinned while scrolling down.
      Programme blocks: absolutely positioned within a fixed-width prog area.
    -->
    <div v-else class="flex-1 overflow-auto guide-scroll">
      <!-- Inner wrapper: exact total width so scroll bar appears correctly -->
      <div :style="{ width: gridW + 'px' }">

        <!-- ── Sticky time header ── -->
        <div class="sticky top-0 z-30 flex bg-[#13151f] border-b border-[#2e3250]" style="height:36px">
          <!-- Corner -->
          <div class="shrink-0 border-r border-[#2e3250] bg-[#13151f]"
            :style="{ width: (isMobile ? CHAN_W : CHAN_W_DESKTOP) + 'px', position: 'sticky', left: 0, zIndex: 40 }">
          </div>
          <!-- Time labels -->
          <div class="relative shrink-0" :style="{ width: progW + 'px' }">
            <div v-for="slot in timeSlots" :key="slot.left"
              class="absolute top-0 bottom-0 flex items-center border-l border-[#2e3250]/60"
              :style="{ left: slot.left + 'px' }">
              <span class="text-[10px] text-slate-400 font-medium pl-2 whitespace-nowrap select-none">{{ slot.label }}</span>
            </div>
            <!-- Now line in header -->
            <div v-if="nowLeft !== null" class="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
              :style="{ left: nowLeft + 'px' }">
              <span class="absolute top-1 left-1.5 text-[9px] text-red-400 font-bold whitespace-nowrap">NOW</span>
            </div>
          </div>
        </div>

        <!-- ── Channel rows ── (only show channels with programmes) -->
        <div v-for="ch in channels.filter(c => c.programmes && c.programmes.length > 0)" :key="ch.id"
          class="flex border-b border-[#2e3250]/40 group/row"
          style="height: 56px;">

          <!-- Sticky channel cell -->
          <div class="shrink-0 flex items-center gap-2.5 px-3 border-r border-[#2e3250] bg-[#13151f] group-hover/row:bg-[#1c2030] transition-colors z-20"
            :style="{ width: isMobile ? CHAN_W + 'px' : CHAN_W_DESKTOP + 'px', position: 'sticky', left: 0 }">
            <div class="w-9 h-9 shrink-0 rounded overflow-hidden bg-[#22263a] flex items-center justify-center">
              <img v-if="ch.icon" :src="ch.icon" class="w-9 h-9 object-contain"
                @error="e => e.target.style.display='none'" />
              <span v-else class="text-slate-600 text-sm">📺</span>
            </div>
            <span class="hidden sm:block text-[11px] text-slate-300 font-medium leading-tight truncate">{{ ch.name }}</span>
          </div>

          <!-- Programme area: fixed width, relative for absolute children -->
          <div class="relative shrink-0 bg-[#0f1117]" :style="{ width: progW + 'px' }">
            <!-- 30-min grid lines -->
            <div v-for="slot in timeSlots" :key="slot.left"
              class="absolute top-0 bottom-0 w-px"
              :class="slot.left % (60 * PX_PER_MIN) === 0 ? 'bg-[#2e3250]/50' : 'bg-[#2e3250]/20'"
              :style="{ left: slot.left + 'px' }">
            </div>
            <!-- Now line -->
            <div v-if="nowLeft !== null" class="absolute top-0 bottom-0 w-0.5 bg-red-500/70 z-10"
              :style="{ left: nowLeft + 'px' }">
            </div>
            <!-- Programme blocks -->
            <button v-for="prog in ch.programmes" :key="prog.start"
              @click="selected = { ...prog, channelName: ch.name, channelIcon: ch.icon, channelUrl: ch.url, channelId: ch.channelId }"
              class="absolute top-1 bottom-1 rounded overflow-hidden flex items-center text-left transition-all group/prog cursor-pointer"
              :class="isNow(prog)
                ? 'bg-indigo-600/30 border border-indigo-500/60 hover:bg-indigo-600/40'
                : 'bg-[#1e2235] border border-[#2e3250]/80 hover:bg-[#252a40] hover:border-indigo-500/40'"
              :style="progStyle(prog)">
              <!-- Progress bar -->
              <div v-if="isNow(prog)" class="absolute bottom-0 left-0 h-0.5 bg-indigo-400 z-10"
                :style="{ width: progProgress(prog) + '%' }">
              </div>
              <div class="flex items-center gap-1.5 px-1.5 min-w-0 w-full h-full">
                <!-- Thumbnail — only show if block is wide enough -->
                <img v-if="prog.icon" :src="prog.icon"
                  class="h-full w-8 object-cover rounded shrink-0 opacity-80 group-hover/prog:opacity-100"
                  style="max-width: 32px;"
                  @error="e => e.target.style.display='none'" />
                <div class="min-w-0 flex-1">
                  <p class="text-[11px] font-semibold truncate leading-tight"
                    :class="isNow(prog) ? 'text-indigo-100' : 'text-slate-200'">
                    {{ prog.title }}
                  </p>
                  <p class="text-[9px] truncate mt-0.5"
                    :class="isNow(prog) ? 'text-indigo-400' : 'text-slate-600'">
                    {{ fmtTime(prog.start) }} · {{ fmtDuration(prog) }}
                  </p>
                </div>
              </div>
            </button>
          </div>

        </div>
      </div>
    </div>

    <!-- Detail popup -->
    <Teleport to="body">
      <Transition name="fade">
        <div v-if="selected"
          class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          @click.self="selected = null">
          <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
            <div class="flex gap-4 p-5">
              <img v-if="selected.icon" :src="selected.icon"
                class="w-24 h-32 object-cover rounded-lg shrink-0 shadow-lg"
                @error="e => e.target.style.display='none'" />
              <div class="flex-1 min-w-0">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <p class="text-base font-bold text-slate-100 leading-tight">{{ selected.title }}</p>
                    <p class="text-xs text-slate-500 mt-0.5">{{ selected.channelName }}</p>
                  </div>
                  <button @click="selected = null"
                    class="text-slate-500 hover:text-slate-300 text-xl leading-none shrink-0 mt-0.5">✕</button>
                </div>
                <div class="flex flex-wrap gap-2 mt-3">
                  <span class="text-[11px] px-2 py-0.5 rounded-full bg-[#22263a] border border-[#2e3250] text-slate-400">
                    {{ fmtTime(selected.start) }} – {{ fmtTime(selected.stop) }}
                  </span>
                  <span class="text-[11px] px-2 py-0.5 rounded-full bg-[#22263a] border border-[#2e3250] text-slate-400">
                    {{ fmtDuration(selected) }}
                  </span>
                  <span v-if="selected.category"
                    class="text-[11px] px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-300">
                    {{ selected.category }}
                  </span>
                  <span v-if="isNow(selected)"
                    class="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 font-semibold">
                    ● NOW · {{ progProgress(selected) }}%
                  </span>
                </div>
                <p v-if="selected.episode" class="text-[10px] font-mono text-slate-600 mt-2">{{ selected.episode }}</p>
              </div>
            </div>
            <div v-if="selected.desc" class="px-5 pb-4">
              <p class="text-sm text-slate-400 leading-relaxed">{{ selected.desc }}</p>
            </div>
            <div v-if="selected.channelId" class="px-5 pb-5 pt-2 border-t border-[#2e3250]">
              <button
                @click="playStream"
                class="w-full px-4 py-2.5 text-sm font-semibold rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white transition-colors flex items-center justify-center gap-2">
                <span class="text-base">▶</span>
                <span>Play {{ selected.channelName }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.guide-scroll { scrollbar-width: thin; scrollbar-color: #2e3250 transparent; }
.guide-scroll::-webkit-scrollbar { height: 6px; width: 6px; }
.guide-scroll::-webkit-scrollbar-track { background: transparent; }
.guide-scroll::-webkit-scrollbar-thumb { background: #2e3250; border-radius: 3px; }
</style>
