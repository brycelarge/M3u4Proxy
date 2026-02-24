<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  groups:          { type: Array,   required: true },
  sectionedGroups: { type: Array,   required: true },
  groupState:      { type: Object,  required: true },
  selectionCounts: { type: Object,  default: () => ({}) },
  activeGroup:     { type: String,  default: null },
  groupSearch:     { type: String,  required: true },
  selectedCount:      { type: Number,  required: true },
  totalCount:         { type: Number,  required: true },
  open:               { type: Boolean, default: false },
  loadingSelection:   { type: Boolean, default: false },
  // Source and playlist props
  allSources:         { type: Array,   default: () => [] },
  allPlaylists:       { type: Array,   default: () => [] },
  activeSourceId:     { type: Number,  default: null },
  activeSourceName:   { type: String,  default: '' },
  activePlaylistId:   { type: Number,  default: null },
  activePlaylistName: { type: String,  default: '' },
})
const emit = defineEmits([
  'update:groupSearch', 'select-group', 'toggle-group', 'set-active', 'close',
  'switch-source', 'switch-playlist', 'create-playlist', 'edit-playlist', 'delete-playlist',
  'toggle-section'
])

const showSelectedOnly = ref(false)
const typeFilter = ref('all') // 'all' | 'live' | 'series' | 'vod'

const TYPE_SECTIONS = {
  live:   'Live TV',
  series: 'Series',
  vod:    'Movies VOD',
}

const filteredSections = computed(() => {
  return props.sectionedGroups
    .filter(sec => {
      if (typeFilter.value === 'all') return true
      return sec.section === TYPE_SECTIONS[typeFilter.value]
    })
    .map(sec => ({
      ...sec,
      groups: sec.groups.filter(g => {
        if (showSelectedOnly.value) {
          const hasSelection = (props.selectionCounts[g.name] || 0) > 0
          const isActive = g.name === props.activeGroup
          if (!hasSelection && !isActive) return false
        }
        return true
      }),
    }))
    .filter(sec => sec.groups.length > 0)
})

function getSectionState(section) {
  const groups = section.groups
  if (!groups.length) return 'none'
  const allSelected = groups.every(g => props.groupState[g.name] === 'all')
  const noneSelected = groups.every(g => !props.groupState[g.name] || props.groupState[g.name] === 'none')
  if (allSelected) return 'all'
  if (noneSelected) return 'none'
  return 'partial'
}

function toggleSection(section) {
  emit('toggle-section', section.groups.map(g => g.name))
}
</script>

<template>
  <!-- Mobile overlay -->
  <Teleport to="body">
    <div
      v-if="open"
      class="md:hidden fixed inset-0 z-30 bg-black/60 backdrop-blur-sm"
      @click="emit('close')"
    />
  </Teleport>

  <aside :class="[
    'flex flex-col bg-[#1a1d27] border-r border-[#2e3250] overflow-hidden shrink-0 transition-transform duration-200',
    'fixed md:relative inset-y-0 left-0 z-40 md:z-auto',
    'w-72 max-w-[85vw]',
    open ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
  ]">

    <!-- Source and Playlist Selector -->
    <div class="p-2.5 border-b border-[#2e3250] space-y-2">
      <!-- Source selector -->
      <div class="relative w-full">
        <select
          :value="props.activeSourceId === null && props.activeSourceName === '__all__' ? '__all__' : (props.activeSourceId ?? '')"
          @change="e => {
            if (e.target.value === '__all__') { emit('switch-source', null); return }
            const s = props.allSources.find(x => x.id === Number(e.target.value))
            if (s) emit('switch-source', s)
          }"
          class="w-full bg-[#13151f] border border-[#2e3250] rounded-lg pl-3 pr-8 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 appearance-none cursor-pointer hover:border-indigo-400 transition-colors"
        >
          <option value="" disabled>Pick source…</option>
          <option value="__all__">⊕ All Sources</option>
          <option v-for="s in props.allSources" :key="s.id" :value="s.id">
            {{ s.name }} ({{ (s.channel_count || 0).toLocaleString() }})
          </option>
        </select>
        <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">▾</span>
      </div>

      <!-- Playlist selector with management buttons -->
      <div class="flex items-center gap-2">
        <div class="relative flex-1">
          <select
            :value="props.activePlaylistId ?? ''"
            @change="e => { const p = props.allPlaylists.find(x => x.id === Number(e.target.value)); if (p) emit('switch-playlist', p) }"
            class="w-full bg-[#13151f] border border-[#2e3250] rounded-lg pl-3 pr-8 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500 appearance-none cursor-pointer hover:border-indigo-400 transition-colors"
            :class="props.activePlaylistId ? 'border-indigo-500/50 text-indigo-200' : ''"
          >
            <option value="" disabled>{{ props.activePlaylistName || 'Pick playlist…' }}</option>
            <option v-for="p in props.allPlaylists" :key="p.id" :value="p.id">
              {{ p.name }} ({{ (p.channel_count || 0).toLocaleString() }} saved)
            </option>
          </select>
          <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">▾</span>
        </div>
        <!-- Delete button -->
        <button
          v-if="props.activePlaylistId"
          @click="emit('delete-playlist')"
          class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-[#13151f] border border-[#2e3250] text-red-400 hover:border-red-400 transition-colors"
          title="Delete playlist"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
        <!-- Edit button -->
        <button
          v-if="props.activePlaylistId"
          @click="emit('edit-playlist')"
          class="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-[#13151f] border border-[#2e3250] text-slate-400 hover:text-slate-200 hover:border-slate-400 transition-colors"
          title="Edit playlist"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
      </div>

      <!-- New playlist button -->
      <button
        @click="emit('create-playlist')"
        class="w-full flex items-center justify-center gap-1.5 py-2 bg-[#13151f] border border-[#2e3250] rounded-lg text-slate-300 hover:border-indigo-400 hover:text-indigo-300 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
        </svg>
        <span class="text-sm">New playlist</span>
      </button>
    </div>


    <!-- Group search + selected filter -->
    <div class="px-2.5 pt-2.5 pb-1.5 shrink-0 flex flex-col gap-1.5">
      <!-- Type filter pills -->
      <div class="flex gap-1">
        <button v-for="[key, label] in [['all','All'],['live','Live'],['series','Series'],['vod','Movies']]" :key="key"
          @click="typeFilter = key"
          :class="['flex-1 py-1 text-[10px] font-medium rounded-lg border transition-colors',
            typeFilter === key
              ? key === 'vod' ? 'bg-purple-500 border-purple-500 text-white'
                : key === 'series' ? 'bg-amber-500 border-amber-500 text-white'
                : key === 'live' ? 'bg-emerald-500 border-emerald-500 text-white'
                : 'bg-slate-400 border-slate-400 text-slate-900'
              : 'bg-transparent border-[#2e3250] text-slate-500 hover:border-slate-500 hover:text-slate-300']"
        >{{ label }}</button>
      </div>
      <input
        :value="groupSearch"
        @input="emit('update:groupSearch', $event.target.value)"
        placeholder="Filter categories..."
        class="w-full bg-[#22263a] border border-[#2e3250] rounded-lg px-2.5 py-1.5 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500"
      />
      <button
        @click="showSelectedOnly = !showSelectedOnly"
        :class="['w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors border',
          showSelectedOnly
            ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300'
            : 'bg-transparent border-[#2e3250] text-slate-500 hover:text-slate-300 hover:border-slate-500']"
      >
        <span :class="['w-3 h-3 rounded border flex items-center justify-center shrink-0 transition-colors',
          showSelectedOnly ? 'bg-indigo-500 border-indigo-500' : 'border-slate-600']"
        >
          <svg v-if="showSelectedOnly" class="w-2 h-2 text-white" fill="currentColor" viewBox="0 0 12 12">
            <path d="M2 6l3 3 5-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
          </svg>
        </span>
        Show selected only
        <span v-if="selectedCount > 0" class="ml-auto text-[10px] font-medium"
          :class="showSelectedOnly ? 'text-indigo-400' : 'text-slate-600'"
        >{{ selectedCount }}</span>
      </button>
    </div>

    <!-- Groups list -->
    <div class="flex-1 overflow-y-auto pb-3">
      <!-- All Channels row -->
      <div
        @click="emit('set-active', '__all__')"
        :class="['flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors',
          activeGroup === '__all__' ? 'bg-[#22263a] text-white font-medium' : 'hover:bg-[#22263a] text-slate-300']"
      >
        <span class="flex-1 truncate">All Channels</span>
        <span class="text-xs text-slate-500 shrink-0">{{ totalCount.toLocaleString() }}</span>
      </div>

      <!-- My Selection -->
      <div
        @click="emit('set-active', '__selected__')"
        :class="['flex items-center gap-2 px-3 py-2 cursor-pointer text-sm transition-colors',
          activeGroup === '__selected__' ? 'bg-[#22263a] text-white font-medium' : 'hover:bg-[#22263a] text-slate-300']"
      >
        <span class="flex-1 truncate">My Selection</span>
        <span class="text-xs font-medium bg-blue-600 text-white px-1.5 py-0.5 rounded min-w-[1.5rem] text-center flex items-center gap-1 justify-center">
          <span v-if="loadingSelection" class="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block"></span>
          <span v-else>{{ selectedCount }}</span>
        </span>
      </div>

      <!-- Sectioned groups -->
      <template v-for="sec in filteredSections" :key="sec.section || '__flat__'">
        <!-- Section header -->
        <div v-if="sec.section" class="flex items-center gap-2 px-3 pt-3 pb-1">
          <input
            type="checkbox"
            :checked="getSectionState(sec) === 'all'"
            :indeterminate="getSectionState(sec) === 'partial'"
            @change="toggleSection(sec)"
            class="accent-blue-500 cursor-pointer shrink-0 w-3.5 h-3.5"
          />
          <span class="text-xs font-medium uppercase text-slate-500">{{ sec.section }}</span>
        </div>
        <!-- Group rows -->
        <div
          v-for="g in sec.groups"
          :key="g.name"
          :class="['flex items-center gap-2 px-3 py-1.5 transition-colors',
            activeGroup === g.name
              ? 'bg-[#22263a] text-white font-medium'
              : groupState[g.name] === 'all' || groupState[g.name] === 'partial'
                ? 'hover:bg-[#22263a] text-slate-300'
                : 'hover:bg-[#22263a] text-slate-500']"
        >
          <input
            type="checkbox"
            :checked="groupState[g.name] === 'all'"
            :indeterminate="groupState[g.name] === 'partial'"
            @click.stop="emit('toggle-group', g.name)"
            class="accent-blue-500 cursor-pointer shrink-0 w-3.5 h-3.5"
          />
          <span @click="emit('select-group', g.name)" class="flex-1 min-w-0 cursor-pointer">
            <span class="block truncate text-xs">{{ g.display || g.name }}</span>
          </span>
          <!-- Selected / total count -->
          <span v-if="selectionCounts[g.name] > 0" class="text-xs shrink-0 font-medium text-blue-500">
            {{ selectionCounts[g.name] }}
          </span>
          <span v-else class="text-xs text-slate-500 shrink-0">{{ g.count.toLocaleString() }}</span>
        </div>
      </template>
    </div>
  </aside>
</template>
