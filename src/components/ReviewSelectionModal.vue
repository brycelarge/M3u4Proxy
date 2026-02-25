<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'

const props = defineProps({
  show:               { type: Boolean, required: true },
  channels:           { type: Array,   required: true },
  groupOverrides:     { type: Object,  required: true },
  channelNumbers:     { type: Object,  required: true },
  nameOverrides:      { type: Object,  default: () => ({}) },
  epgOverrides:       { type: Object,  default: () => ({}) },
  epgSourceOverrides: { type: Object,  default: () => ({}) },
  epgChannels:        { type: Array,   default: () => [] },
  loading:            { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'set-group', 'set-numbers', 'set-epg-id', 'set-epg-source', 'set-name'])

// EPG sources list
const epgSources = ref([])
onMounted(async () => {
  try {
    const r = await fetch('/api/epg/sources')
    if (r.ok) epgSources.value = await r.json()
  } catch {}
})

const search          = ref('')
const checked         = ref(new Set())
const filterGroup     = ref('')
const startNum        = ref(1)
const bulkGroup       = ref('')
const bulkEpgSource   = ref('')
const bulkAction      = ref('group')
// Rename
const renameMode      = ref('replace')  // 'replace' | 'strip-prefix' | 'strip-suffix'
const renameFind      = ref('')
const renameWith      = ref('')
const editingNameId   = ref(null)
const editingNameVal  = ref('')
const inlineNameInput = ref(null)
const activeTab       = ref('channels') // 'channels' | 'group-numbers'
const editingGroupId  = ref(null)
const editingGroupVal = ref('')
const editingEpgId    = ref(null)
const editingEpgVal   = ref('')
const epgSearch       = ref('')

// Per-group start numbers for bulk range assignment
const groupRanges = ref({}) // { groupName: { start: number, step: number } }

function initGroupRanges() {
  const ranges = {}
  for (const g of allGroups.value) {
    if (!ranges[g]) ranges[g] = { start: '', step: 1 }
  }
  groupRanges.value = ranges
}

function initializeGroupRanges() {
  let groupNum = 1
  for (const g of allGroups.value) {
    if (!groupRanges.value[g]) groupRanges.value[g] = {}
    // Only set if not already set
    if (!groupRanges.value[g].start) {
      groupRanges.value[g].start = groupNum * 100
      groupRanges.value[g].step = 1
    }
    groupNum++
  }
}

function autoNumberGroups() {
  // Auto-assign group ranges: 100, 200, 300, etc.
  let groupNum = 1
  for (const g of allGroups.value) {
    if (!groupRanges.value[g]) groupRanges.value[g] = {}
    groupRanges.value[g].start = groupNum * 100
    groupRanges.value[g].step = 1
    groupNum++
  }
  // Apply the ranges
  applyGroupRanges()
}

function applyGroupRanges() {
  const nums = {}
  for (const g of allGroups.value) {
    const range = groupRanges.value[g]
    if (!range?.start) continue
    const step = Math.max(1, parseInt(range.step) || 1)
    let n = parseInt(range.start)
    sorted.value.filter(ch => effectiveGroup(ch) === g).forEach(ch => {
      // Apply to all variant IDs
      const ids = ch.variantIds || [ch.id]
      for (const id of ids) {
        nums[id] = n
      }
      n += step
    })
  }
  emit('set-numbers', nums)
}

function bulkAssignNumbers() {
  const nums = {}
  for (const g of allGroups.value) {
    const range = groupRanges.value[g]
    if (!range?.start) continue
    const step  = Math.max(1, parseInt(range.step) || 1)
    let   n     = parseInt(range.start)
    if (isNaN(n)) continue
    const groupChannels = sorted.value.filter(ch => effectiveGroup(ch) === g)
    for (const ch of groupChannels) {
      // Apply to all variant IDs
      const ids = ch.variantIds || [ch.id]
      for (const id of ids) {
        nums[id] = n
      }
      n += step
    }
  }
  emit('set-numbers', nums)
}

// Auto-sort groups in preferred order, preserving manual channel numbers
function autoSortGroups() {
  const preferredOrder = ['entertainment', 'kids', 'movies', 'sports', 'news']
  const nums = {}
  let currentNum = 1

  // Get all groups and sort by preferred order
  const groups = [...allGroups.value].sort((a, b) => {
    const aIdx = preferredOrder.indexOf(a.toLowerCase())
    const bIdx = preferredOrder.indexOf(b.toLowerCase())

    // Both in preferred order - sort by that order
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
    // Only a in preferred order - a comes first
    if (aIdx !== -1) return -1
    // Only b in preferred order - b comes first
    if (bIdx !== -1) return 1
    // Neither in preferred order - alphabetical
    return a.localeCompare(b)
  })

  // Assign numbers, preserving existing manual changes
  for (const g of groups) {
    const groupChannels = sorted.value.filter(ch => effectiveGroup(ch) === g)
    for (const ch of groupChannels) {
      // Skip if channel already has a manual number
      if (props.channelNumbers[ch.id] !== undefined && props.channelNumbers[ch.id] !== null) {
        nums[ch.id] = props.channelNumbers[ch.id]
      } else {
        nums[ch.id] = currentNum++
      }
    }
  }

  emit('set-numbers', nums)
}

const epgSuggestions = computed(() => {
  const q = editingEpgVal.value.toLowerCase()
  if (!q || q.length < 2) return []
  return props.epgChannels
    .filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    .slice(0, 8)
})

const epgById = computed(() => {
  const m = new Map()
  for (const c of props.epgChannels) m.set(c.id, c)
  return m
})

function epgMatch(ch) {
  const id = effectiveEpgId(ch)
  return id ? epgById.value.get(id) : null
}

const allGroups = computed(() => {
  const s = new Set()
  for (const ch of props.channels)
    s.add(effectiveGroup(ch))
  return [...s].filter(Boolean).sort()
})

watch(() => props.show, (v) => {
  if (v) {
    checked.value = new Set()
    bulkGroup.value = ''
    search.value = ''
    filterGroup.value = ''
    editingGroupId.value = null
    activeTab.value = 'channels'
    initGroupRanges()
    initializeGroupRanges()
  }
})

watch(allGroups, () => { initGroupRanges() }, { immediate: true })

function effectiveGroup(ch) {
  return props.groupOverrides[ch.id] || ch.originalGroup || ch.group || ''
}

const sorted = computed(() =>
  [...props.channels].sort((a, b) => {
    const na = props.channelNumbers[a.id], nb = props.channelNumbers[b.id]
    if (na != null && nb != null) return na - nb
    if (na != null) return -1
    if (nb != null) return 1
    return 0
  })
)

const filtered = computed(() => {
  let list = sorted.value
  if (search.value.trim()) { const q = search.value.toLowerCase(); list = list.filter(c => c.name.toLowerCase().includes(q)) }
  if (filterGroup.value) list = list.filter(c => effectiveGroup(c) === filterGroup.value)
  return list
})

const allChecked  = computed(() => filtered.value.length > 0 && filtered.value.every(c => checked.value.has(c.id)))
const someChecked = computed(() => !allChecked.value && filtered.value.some(c => checked.value.has(c.id)))

function toggleOne(id) { const s = new Set(checked.value); s.has(id) ? s.delete(id) : s.add(id); checked.value = s }
function toggleAll() {
  const s = new Set(checked.value)
  if (allChecked.value) { for (const c of filtered.value) s.delete(c.id) }
  else                  { for (const c of filtered.value) s.add(c.id) }
  checked.value = s
}

// Inline per-row group edit
const inlineGroupInput = ref(null)
function startEditGroup(ch) {
  editingGroupId.value = ch.id
  editingGroupVal.value = effectiveGroup(ch)
  nextTick(() => inlineGroupInput.value?.focus())
}
function commitEditGroup(ch) {
  if (editingGroupId.value !== ch.id) return
  // Apply to all variant IDs if available
  const ids = ch.variantIds || [ch.id]
  emit('set-group', { ids, group: editingGroupVal.value.trim() })
  editingGroupId.value = null
}
function cancelEditGroup() { editingGroupId.value = null }

// Inline EPG ID edit
const inlineEpgInput = ref(null)
function startEditEpg(ch) {
  editingEpgId.value  = ch.id
  editingEpgVal.value = props.epgOverrides[ch.id] || ch.tvg_id || ''
  nextTick(() => inlineEpgInput.value?.focus())
}
function commitEditEpg(ch) {
  if (editingEpgId.value !== ch.id) return
  // Apply to all variant IDs if available
  const ids = ch.variantIds || [ch.id]
  for (const id of ids) {
    emit('set-epg-id', { id, tvg_id: editingEpgVal.value.trim() })
  }
  editingEpgId.value = null
}
function cancelEditEpg() { editingEpgId.value = null }
function pickEpgSuggestion(ch, suggestion) {
  editingEpgVal.value = suggestion.id
  commitEditEpg(ch)
}
function effectiveEpgId(ch) {
  return props.epgOverrides[ch.id] ?? ch.tvg_id ?? ''
}

function effectiveName(ch) {
  return props.nameOverrides[ch.id] ?? ch.name ?? ''
}

// Inline single-channel rename
function startEditName(ch) {
  editingNameId.value  = ch.id
  editingNameVal.value = effectiveName(ch)
  nextTick(() => inlineNameInput.value?.focus())
}
function commitEditName(ch) {
  if (editingNameId.value !== ch.id) return
  const val = editingNameVal.value.trim()
  // Apply to all variant IDs if available
  const ids = ch.variantIds || [ch.id]
  for (const id of ids) {
    emit('set-name', { id, name: val || null })
  }
  editingNameId.value = null
}
function cancelEditName() { editingNameId.value = null }

function effectiveEpgSourceId(ch) {
  const v = props.epgSourceOverrides[ch.id] ?? ch.epg_source_id ?? null
  return v ? String(v) : ''
}

function onEpgSourceChange(ch, evt) {
  const val = evt.target.value
  // Apply to all variant IDs if available
  const ids = ch.variantIds || [ch.id]
  for (const id of ids) {
    emit('set-epg-source', { id, source_id: val ? Number(val) : null })
  }
}

// Bulk group
function applyBulkGroup() { emit('set-group', { ids: [...checked.value], group: bulkGroup.value.trim() }); checked.value = new Set(); bulkGroup.value = '' }
function clearBulkGroup()  { emit('set-group', { ids: [...checked.value], group: '' }); checked.value = new Set() }

// Bulk rename
function applyBulkRename() {
  const find = renameFind.value
  if (!find) return
  for (const id of checked.value) {
    const ch = props.channels.find(c => c.id === id)
    if (!ch) continue
    let name = effectiveName(ch)
    if (renameMode.value === 'strip-prefix' && name.startsWith(find)) {
      name = name.slice(find.length).trimStart()
    } else if (renameMode.value === 'strip-suffix' && name.endsWith(find)) {
      name = name.slice(0, -find.length).trimEnd()
    } else if (renameMode.value === 'replace') {
      name = name.replaceAll(find, renameWith.value)
    }
    emit('set-name', { id, name: name.trim() || null })
  }
  checked.value = new Set()
}
function clearBulkRename() {
  for (const id of checked.value) emit('set-name', { id, name: null })
  checked.value = new Set()
}

function applyBulkEpgSource() {
  for (const id of checked.value) emit('set-epg-source', { id, source_id: bulkEpgSource.value ? Number(bulkEpgSource.value) : null })
  checked.value = new Set()
}
function clearBulkEpgSource() {
  for (const id of checked.value) emit('set-epg-source', { id, source_id: null })
  checked.value = new Set()
}

// Channel numbers
function onNumberInput(ch, evt) {
  const val = parseInt(evt.target.value, 10)
  emit('set-numbers', { [ch.id]: (!isNaN(val) && val > 0) ? val : null })
}
function applyStartNumber() {
  const nums = {}
  // Use the exact number entered by the user
  const startValue = parseInt(startNum.value, 10) || 1

  // Only apply to selected channels if any are selected, otherwise apply to all
  if (checked.value.size > 0) {
    // Get only the checked channels in their current order
    const checkedChannels = sorted.value.filter(ch => checked.value.has(ch.id))

    // Assign sequential numbers starting from the exact value entered
    let counter = 0
    checkedChannels.forEach(ch => {
      nums[ch.id] = startValue + counter
      counter++
    })

    checked.value = new Set() // Clear selection after applying
  } else {
    // Apply to all channels in their current order
    let counter = 0
    sorted.value.forEach(ch => {
      nums[ch.id] = startValue + counter
      counter++
    })
  }

  // Force update channel numbers immediately
  Object.keys(nums).forEach(id => {
    props.channelNumbers[id] = nums[id]
  })

  emit('set-numbers', nums)
}
function setStartNum(num) {
  startNum.value = num
}
function applyStartNumberToChecked() {
  // Get only the checked channels in their current order
  const checkedChannels = sorted.value.filter(ch => checked.value.has(ch.id))
  if (checkedChannels.length === 0) return

  // Use the exact number entered by the user as the starting value
  const startValue = parseInt(startNum.value, 10) || 1

  // First, clear all existing channel numbers for selected channels
  const resetNums = {}
  checkedChannels.forEach(ch => {
    resetNums[ch.id] = null
  })
  emit('set-numbers', resetNums)

  // Then apply the new numbers starting exactly from the entered value
  const nums = {}
  checkedChannels.forEach((ch, index) => {
    nums[ch.id] = startValue + index
  })

  // Apply the new numbers
  emit('set-numbers', nums)
  checked.value = new Set() // Clear selection after applying
}
function clearAllNumbers() {
  const nums = {}
  for (const ch of props.channels) nums[ch.id] = null
  emit('set-numbers', nums)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-5xl flex flex-col shadow-2xl" style="max-height: 90vh">

        <!-- Header -->
        <div class="flex items-center gap-3 px-5 py-3.5 border-b border-[#2e3250] shrink-0">
          <h2 class="text-sm font-bold text-slate-100">Map Playlist Channels</h2>
          <div class="flex items-center gap-1 ml-4 bg-[#13151f] rounded-lg p-0.5">
            <button @click="activeTab = 'channels'"
              :class="['px-3 py-1 text-xs rounded-md font-medium transition-colors',
                activeTab === 'channels' ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-slate-200']">Channels</button>
            <button @click="activeTab = 'group-numbers'"
              :class="['px-3 py-1 text-xs rounded-md font-medium transition-colors',
                activeTab === 'group-numbers' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-slate-200']">Group Numbers</button>
          </div>
          <span class="text-xs text-slate-500 ml-auto">{{ channels.length.toLocaleString() }} channels</span>
          <button @click="emit('close')" class="text-slate-500 hover:text-slate-300 text-lg leading-none ml-3">✕</button>
        </div>

        <!-- ── GROUP NUMBERS TAB ─────────────────────────────────────────── -->
        <div v-if="activeTab === 'group-numbers'" class="flex-1 overflow-y-auto">
          <div class="p-4 border-b border-[#2e3250] bg-[#13151f] flex items-center gap-3">
            <p class="text-xs text-slate-500 flex-1">Groups are auto-assigned start numbers (100, 200, 300...). Adjust if needed, then apply.</p>
            <button @click="applyGroupRanges"
              class="px-4 py-1.5 text-xs bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-lg transition-colors shrink-0">
              Apply All Ranges
            </button>
            <button @click="autoSortGroups"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-green-400 text-slate-400 hover:text-green-400 rounded-lg transition-colors shrink-0">
              Auto-Sort Groups
            </button>
            <button @click="autoNumberGroups"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-amber-400 text-slate-400 hover:text-amber-400 rounded-lg transition-colors shrink-0">
              Reset to 100, 200, 300...
            </button>
            <button @click="clearAllNumbers"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-red-400 text-slate-400 hover:text-red-400 rounded-lg transition-colors shrink-0">
              Clear All #s
            </button>
          </div>
          <div class="p-4 space-y-2">
            <div v-for="g in allGroups" :key="g"
              class="flex items-center gap-3 bg-[#13151f] border border-[#2e3250] rounded-xl px-4 py-3">
              <!-- Group name + channel count -->
              <div class="flex-1 min-w-0">
                <span class="text-sm text-slate-200 font-medium truncate block">{{ g }}</span>
                <span class="text-[10px] text-slate-600">
                  {{ sorted.filter(ch => effectiveGroup(ch) === g).length }} channels
                  <span v-if="groupRanges[g]?.start">
                    → #{{ groupRanges[g].start }} – #{{ parseInt(groupRanges[g].start) + (sorted.filter(ch => effectiveGroup(ch) === g).length - 1) * Math.max(1, parseInt(groupRanges[g].step) || 1) }}
                  </span>
                </span>
              </div>
              <!-- Start # -->
              <div class="flex items-center gap-1.5 shrink-0">
                <label class="text-[10px] text-slate-500">Start</label>
                <input
                  v-model.number="groupRanges[g].start"
                  type="number" min="1" placeholder="—"
                  class="w-20 bg-[#22263a] border border-[#2e3250] focus:border-amber-500 rounded-lg px-2 py-1.5 text-xs text-amber-300 font-mono outline-none text-center placeholder-slate-700"
                />
              </div>
              <!-- Step -->
              <div class="flex items-center gap-1.5 shrink-0">
                <label class="text-[10px] text-slate-500">Step</label>
                <input
                  v-model.number="groupRanges[g].step"
                  type="number" min="1" max="100" placeholder="1"
                  class="w-14 bg-[#22263a] border border-[#2e3250] focus:border-amber-500 rounded-lg px-2 py-1.5 text-xs text-slate-300 font-mono outline-none text-center placeholder-slate-600"
                />
              </div>
              <!-- Apply just this group -->
              <button
                @click="() => { const r = groupRanges[g]; if (!r?.start) return; const step = Math.max(1, parseInt(r.step)||1); let n = parseInt(r.start); const nums = {}; sorted.filter(ch => effectiveGroup(ch) === g).forEach(ch => { nums[ch.id] = n; n += step }); emit('set-numbers', nums) }"
                :disabled="!groupRanges[g]?.start"
                class="px-3 py-1.5 text-[10px] bg-[#22263a] border border-[#2e3250] hover:border-amber-500 hover:text-amber-300 text-slate-400 rounded-lg transition-colors shrink-0 disabled:opacity-30"
              >Apply</button>
            </div>
            <div v-if="!allGroups.length" class="text-center py-10 text-slate-600 text-sm">
              No groups found in current selection.
            </div>
          </div>
        </div>

        <!-- ── CHANNELS TAB ───────────────────────────────────────────────── -->
        <template v-if="activeTab === 'channels'">

        <!-- Top toolbar: auto-number + search + filter -->
        <div class="flex items-center gap-2 px-4 py-2 border-b border-[#2e3250] shrink-0 bg-[#13151f]">
          <span class="text-[10px] text-slate-500 shrink-0">Number selected from:</span>
          <input v-model.number="startNum" type="number" min="1"
            class="w-14 bg-[#22263a] border border-[#2e3250] rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-amber-400 text-center" />
          <button @click="applyStartNumber"
            class="px-2.5 py-1 text-[10px] bg-[#22263a] border border-[#2e3250] rounded hover:border-amber-400 text-slate-300 hover:text-amber-300 transition-colors">
            Number selected
          </button>
          <button @click="autoSortGroups"
            class="px-2.5 py-1 text-[10px] bg-[#22263a] border border-[#2e3250] rounded hover:border-green-400 text-slate-300 hover:text-green-400 transition-colors">
            Auto-Sort
          </button>
          <button @click="clearAllNumbers"
            class="px-2.5 py-1 text-[10px] bg-[#22263a] border border-[#2e3250] rounded hover:border-red-400 text-slate-500 hover:text-red-400 transition-colors">
            Clear #s
          </button>
          <div class="flex-1"></div>
          <select v-model="filterGroup"
            class="bg-[#22263a] border border-[#2e3250] rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-indigo-500 min-w-32">
            <option value="">All groups</option>
            <option v-for="g in allGroups" :key="g" :value="g">{{ g }}</option>
          </select>
          <div class="relative">
            <input v-model="search" placeholder="Search…"
              class="bg-[#22263a] border border-[#2e3250] rounded pl-6 pr-3 py-1 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500 w-36" />
            <span class="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-[10px] pointer-events-none">🔍</span>
          </div>
        </div>

        <!-- Bulk action bar — only when rows checked -->
        <div v-if="checked.size > 0" class="shrink-0 border-b border-[#2e3250]">
          <div class="flex border-b border-[#2e3250]">
            <button @click="bulkAction = 'group'"
              :class="['px-4 py-1.5 text-xs font-medium transition-colors border-r border-[#2e3250]',
                bulkAction === 'group' ? 'bg-indigo-500/15 text-indigo-300' : 'text-slate-400 hover:text-slate-200 hover:bg-[#22263a]']">
              🏷️ Bulk Group
            </button>
            <button @click="bulkAction = 'number'"
              :class="['px-4 py-1.5 text-xs font-medium transition-colors border-r border-[#2e3250]',
                bulkAction === 'number' ? 'bg-amber-500/15 text-amber-300' : 'text-slate-400 hover:text-slate-200 hover:bg-[#22263a]']">
              🔢 Number
            </button>
            <button @click="bulkAction = 'epg-source'" v-if="epgSources.length"
              :class="['px-4 py-1.5 text-xs font-medium transition-colors border-r border-[#2e3250]',
                bulkAction === 'epg-source' ? 'bg-violet-500/15 text-violet-300' : 'text-slate-400 hover:text-slate-200 hover:bg-[#22263a]']">
              📡 EPG Source
            </button>
            <button @click="bulkAction = 'rename'"
              :class="['px-4 py-1.5 text-xs font-medium transition-colors',
                bulkAction === 'rename' ? 'bg-rose-500/15 text-rose-300' : 'text-slate-400 hover:text-slate-200 hover:bg-[#22263a]']">
              ✏️ Rename
            </button>
            <span class="ml-auto px-4 py-1.5 text-xs text-slate-500 self-center">{{ checked.size }} selected</span>
          </div>
          <!-- Bulk group -->
          <div v-if="bulkAction === 'group'" class="flex items-center gap-2 px-4 py-2 bg-indigo-500/5">
            <input v-model="bulkGroup" placeholder="Group name…" @keyup.enter="applyBulkGroup"
              list="bulk-group-list"
              class="flex-1 bg-[#22263a] border border-indigo-500/40 rounded px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            <datalist id="bulk-group-list">
              <option v-for="g in allGroups" :key="g" :value="g" />
            </datalist>
            <button @click="applyBulkGroup"
              class="px-3 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded transition-colors shrink-0">Apply</button>
            <button @click="clearBulkGroup"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-red-400 text-slate-400 hover:text-red-400 rounded transition-colors shrink-0">
              Clear
            </button>
          </div>
          <!-- Bulk EPG source -->
          <div v-else-if="bulkAction === 'epg-source'" class="flex items-center gap-2 px-4 py-2 bg-violet-500/5">
            <span class="text-xs text-violet-300 shrink-0">Set EPG source for {{ checked.size }} channels:</span>
            <div class="relative flex-1 max-w-xs">
              <select v-model="bulkEpgSource"
                class="w-full bg-[#22263a] border border-violet-500/40 rounded px-3 py-1.5 text-xs text-slate-200 outline-none focus:border-violet-500 appearance-none cursor-pointer">
                <option value="">— any source —</option>
                <option v-for="s in epgSources" :key="s.id" :value="String(s.id)">{{ s.name }}</option>
              </select>
              <span class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 pointer-events-none">▾</span>
            </div>
            <button @click="applyBulkEpgSource"
              class="px-3 py-1.5 text-xs bg-violet-500 hover:bg-violet-400 text-white font-semibold rounded transition-colors shrink-0">Apply</button>
            <button @click="clearBulkEpgSource"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-red-400 text-slate-400 hover:text-red-400 rounded transition-colors shrink-0">
              Clear
            </button>
          </div>
          <!-- Bulk rename -->
          <div v-else-if="bulkAction === 'rename'" class="flex flex-wrap items-center gap-2 px-4 py-2 bg-rose-500/5">
            <div class="flex items-center gap-1 shrink-0">
              <button v-for="m in [['replace','Find & Replace'],['strip-prefix','Strip Prefix'],['strip-suffix','Strip Suffix']]" :key="m[0]"
                @click="renameMode = m[0]"
                :class="['px-2.5 py-1 text-[10px] rounded border transition-colors',
                  renameMode === m[0] ? 'bg-rose-500/20 border-rose-500/50 text-rose-300' : 'bg-[#22263a] border-[#2e3250] text-slate-400 hover:text-slate-200']">
                {{ m[1] }}
              </button>
            </div>
            <input v-model="renameFind"
              :placeholder="renameMode === 'replace' ? 'Find…' : renameMode === 'strip-prefix' ? 'Prefix to strip…' : 'Suffix to strip…'"
              @keyup.enter="applyBulkRename"
              class="flex-1 min-w-32 bg-[#22263a] border border-rose-500/40 rounded px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-rose-400" />
            <template v-if="renameMode === 'replace'">
              <span class="text-slate-600 text-xs shrink-0">→</span>
              <input v-model="renameWith" placeholder="Replace with…" @keyup.enter="applyBulkRename"
                class="flex-1 min-w-32 bg-[#22263a] border border-rose-500/40 rounded px-3 py-1.5 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-rose-400" />
            </template>
            <button @click="applyBulkRename" :disabled="!renameFind"
              class="px-3 py-1.5 text-xs bg-rose-500 hover:bg-rose-400 text-white font-semibold rounded transition-colors shrink-0 disabled:opacity-40">Apply</button>
            <button @click="clearBulkRename"
              class="px-3 py-1.5 text-xs bg-[#22263a] border border-[#2e3250] hover:border-red-400 text-slate-400 hover:text-red-400 rounded transition-colors shrink-0">
              Reset names
            </button>
          </div>
          <!-- Bulk number -->
          <div v-else class="flex items-center gap-2 px-4 py-2 bg-amber-500/5">
            <span class="text-xs text-amber-300 shrink-0">Number {{ checked.size }} checked from:</span>
            <input v-model.number="startNum" type="number" min="1"
              class="w-16 bg-[#22263a] border border-amber-500/40 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-amber-400 text-center" />
            <button @click="applyStartNumberToChecked"
              class="px-3 py-1.5 text-xs bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded transition-colors shrink-0">
              Apply to checked
            </button>
            <div class="flex items-center gap-1 ml-2">
              <span class="text-xs text-amber-300/70">Presets:</span>
              <button @click="setStartNum(101); applyStartNumberToChecked()"
                class="px-2 py-1 text-[10px] bg-[#22263a] border border-amber-500/30 rounded hover:border-amber-400 text-amber-300/70 hover:text-amber-300 transition-colors">
                101
              </button>
              <button @click="setStartNum(201); applyStartNumberToChecked()"
                class="px-2 py-1 text-[10px] bg-[#22263a] border border-amber-500/30 rounded hover:border-amber-400 text-amber-300/70 hover:text-amber-300 transition-colors">
                201
              </button>
              <button @click="setStartNum(301); applyStartNumberToChecked()"
                class="px-2 py-1 text-[10px] bg-[#22263a] border border-amber-500/30 rounded hover:border-amber-400 text-amber-300/70 hover:text-amber-300 transition-colors">
                301
              </button>
            </div>
          </div>
        </div>

        <!-- Table -->
        <div class="flex-1 overflow-y-auto">
          <div v-if="loading" class="flex items-center justify-center py-10 gap-2 text-slate-500">
            <span class="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
            <span class="text-xs">Loading all selected channels…</span>
          </div>
          <table v-else class="w-full text-xs border-collapse">
            <thead class="sticky top-0 bg-[#13151f] border-b border-[#2e3250]">
              <tr>
                <th class="w-8 px-3 py-2.5 text-left">
                  <input type="checkbox" :checked="allChecked" :indeterminate="someChecked"
                    @change="toggleAll" class="accent-indigo-500 cursor-pointer" />
                </th>
                <th class="w-20 px-3 py-2.5 text-left text-indigo-400 font-semibold">Ch. No.</th>
                <th class="w-12 px-3 py-2.5 text-left text-slate-400 font-medium">Logo</th>
                <th class="px-3 py-2.5 text-left text-slate-400 font-medium">Channel Name</th>
                <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-48">Group Title</th>
                <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-44">EPG ID</th>
                <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-36 hidden xl:table-cell">EPG Source</th>
                <th class="px-3 py-2.5 text-left text-slate-400 font-medium w-32">Source Group</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="ch in filtered" :key="ch.id"
                @click="toggleOne(ch.id)"
                :class="['cursor-pointer transition-colors border-b border-[#2e3250]/40',
                  checked.has(ch.id) ? 'bg-indigo-500/10' : 'hover:bg-[#22263a]']"
              >
                <!-- Checkbox -->
                <td class="px-3 py-2" @click.stop>
                  <input type="checkbox" :checked="checked.has(ch.id)" @change="toggleOne(ch.id)"
                    class="accent-indigo-500 cursor-pointer" />
                </td>

                <!-- Ch. No — inline editable, amber like xTeve -->
                <td class="px-3 py-2" @click.stop>
                  <input
                    type="number" min="1"
                    :value="channelNumbers[ch.id] ?? ''"
                    @change="onNumberInput(ch, $event)"
                    placeholder="—"
                    class="w-16 bg-transparent border-l-2 pl-2 pr-1 py-0.5 text-xs outline-none transition-colors font-mono"
                    :class="channelNumbers[ch.id]
                      ? 'border-amber-500 text-amber-300 font-semibold'
                      : 'border-[#2e3250] text-slate-600 placeholder-slate-700 focus:border-amber-500 focus:text-amber-300'"
                  />
                </td>

                <!-- Logo -->
                <td class="px-3 py-2">
                  <div class="w-8 h-8 flex items-center justify-center">
                    <img v-if="ch.logo" :src="`/api/logo?url=${encodeURIComponent(ch.logo)}`" class="max-w-8 max-h-8 object-contain rounded"
                      @error="e => e.target.style.display='none'" />
                    <span v-else class="text-slate-700 text-base">📺</span>
                  </div>
                </td>

                <!-- Channel Name — inline editable -->
                <td class="px-3 py-2" @click.stop>
                  <input
                    v-if="editingNameId === ch.id"
                    ref="inlineNameInput"
                    v-model="editingNameVal"
                    @keyup.enter="commitEditName(ch)"
                    @keyup.escape="cancelEditName"
                    @blur="commitEditName(ch)"
                    class="w-full bg-[#22263a] border border-rose-500 rounded px-2 py-0.5 text-xs text-slate-200 outline-none"
                  />
                  <button v-else @click="startEditName(ch)"
                    :class="['w-full text-left px-1 py-0.5 rounded transition-colors font-medium text-xs',
                      nameOverrides[ch.id] ? 'text-rose-300 hover:bg-rose-500/10' : checked.has(ch.id) ? 'text-indigo-200 hover:bg-indigo-500/10' : 'text-slate-200 hover:bg-[#2e3250]']"
                    title="Click to rename">
                    {{ effectiveName(ch) }}
                    <span v-if="nameOverrides[ch.id]" class="text-[9px] text-rose-500/60 ml-1">renamed</span>
                    <span v-if="ch.variantCount && ch.variantCount > 1" class="text-[9px] text-green-500/70 ml-1" :title="`${ch.variantCount} variants will receive same settings`">
                      ×{{ ch.variantCount }}
                    </span>
                  </button>
                </td>

                <!-- Group Title — inline editable on click -->
                <td class="px-3 py-2 w-48" @click.stop>
                  <input
                    v-if="editingGroupId === ch.id"
                    ref="inlineGroupInput"
                    v-model="editingGroupVal"
                    list="inline-group-list"
                    @keyup.enter="commitEditGroup(ch)"
                    @keyup.escape="cancelEditGroup"
                    @blur="commitEditGroup(ch)"
                    class="w-full bg-[#22263a] border border-indigo-500 rounded px-2 py-0.5 text-xs text-slate-200 outline-none"
                  />
                  <button v-else
                    @click="startEditGroup(ch)"
                    :class="['w-full text-left px-2 py-0.5 rounded transition-colors text-xs',
                      groupOverrides[ch.id]
                        ? 'text-indigo-300 font-medium hover:bg-indigo-500/10'
                        : 'text-slate-400 hover:bg-[#2e3250] hover:text-slate-200']"
                    title="Click to edit group"
                  >
                    {{ effectiveGroup(ch) || '— click to set —' }}
                  </button>
                  <datalist id="inline-group-list">
                    <option v-for="g in allGroups" :key="g" :value="g" />
                  </datalist>
                </td>

                <!-- EPG ID — inline editable with autocomplete -->
                <td class="px-3 py-2 w-44 relative" @click.stop>
                  <div v-if="editingEpgId === ch.id" class="relative">
                    <input
                      ref="inlineEpgInput"
                      v-model="editingEpgVal"
                      @keyup.enter="commitEditEpg(ch)"
                      @keyup.escape="cancelEditEpg"
                      placeholder="Search EPG ID…"
                      class="w-full bg-[#22263a] border border-emerald-500 rounded px-2 py-0.5 text-xs text-slate-200 outline-none"
                    />
                    <!-- Suggestions dropdown -->
                    <div v-if="epgSuggestions.length" class="absolute z-50 left-0 top-full mt-0.5 w-64 bg-[#1a1d27] border border-[#2e3250] rounded-lg shadow-xl overflow-hidden">
                      <button
                        v-for="s in epgSuggestions" :key="s.id"
                        @mousedown.prevent="pickEpgSuggestion(ch, s)"
                        class="w-full text-left px-3 py-1.5 text-xs hover:bg-[#22263a] flex items-center gap-2"
                      >
                        <img v-if="s.icon" :src="s.icon" class="w-4 h-4 object-contain shrink-0" @error="e => e.target.style.display='none'" />
                        <span class="flex-1 min-w-0">
                          <span class="block text-slate-200 truncate">{{ s.name }}</span>
                          <span class="block text-slate-600 font-mono truncate">{{ s.id }}</span>
                        </span>
                        <span class="text-[9px] text-slate-600 shrink-0">{{ s.source_name }}</span>
                      </button>
                    </div>
                  </div>
                  <button v-else
                    @click="startEditEpg(ch)"
                    class="w-full text-left px-2 py-0.5 rounded transition-colors"
                    title="Click to set EPG ID"
                  >
                    <template v-if="effectiveEpgId(ch)">
                      <span class="block text-[10px] font-mono"
                        :class="epgMatch(ch) ? 'text-emerald-400' : 'text-amber-400'">{{ effectiveEpgId(ch) }}</span>
                      <span v-if="epgMatch(ch)" class="flex items-center gap-1 mt-0.5">
                        <img v-if="epgMatch(ch).icon" :src="epgMatch(ch).icon" class="w-3 h-3 object-contain shrink-0 rounded-sm" @error="e => e.target.style.display='none'" />
                        <span class="text-[10px] text-emerald-300/70 truncate">{{ epgMatch(ch).name }}</span>
                      </span>
                      <span v-else class="block text-[10px] text-amber-500/60">no match in EPG</span>
                    </template>
                    <span v-else class="text-xs text-slate-600 hover:text-slate-400">— set EPG ID —</span>
                  </button>
                </td>

                <!-- EPG Source assignment -->
                <td class="px-3 py-2 w-36 hidden xl:table-cell" @click.stop>
                  <div class="relative">
                    <select
                      :value="effectiveEpgSourceId(ch)"
                      @change="onEpgSourceChange(ch, $event)"
                      :class="['w-full bg-transparent border rounded px-2 py-0.5 text-[10px] outline-none appearance-none cursor-pointer transition-colors',
                        effectiveEpgSourceId(ch)
                          ? 'border-violet-500/50 text-violet-300 focus:border-violet-400'
                          : 'border-[#2e3250] text-slate-600 focus:border-violet-500 hover:border-slate-500']">
                      <option value="">— any source —</option>
                      <option v-for="s in epgSources" :key="s.id" :value="String(s.id)">{{ s.name }}</option>
                    </select>
                    <span class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] pointer-events-none"
                      :class="effectiveEpgSourceId(ch) ? 'text-violet-400' : 'text-slate-600'">▾</span>
                  </div>
                </td>

                <!-- Source group -->
                <td class="px-3 py-2 text-slate-500 text-[10px] truncate max-w-32">
                  {{ ch.originalGroup || ch.group || '—' }}
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!loading && !filtered.length" class="flex flex-col items-center justify-center py-16 text-slate-500 gap-2">
            <span class="text-3xl">🔍</span>
            <p class="text-xs">No channels match your filter</p>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between px-5 py-3 border-t border-[#2e3250] shrink-0">
          <p class="text-xs text-slate-500">
            <span class="text-amber-400 font-mono">Ch. No.</span> → <code class="font-mono">tvg-chno</code> &nbsp;·&nbsp;
            <span class="text-indigo-400">Group Title</span> → <code class="font-mono">group-title</code> &nbsp;·&nbsp;
            both applied on M3U export
          </p>
          <button @click="emit('close')"
            class="px-4 py-2 text-xs bg-[#22263a] border border-[#2e3250] rounded-xl hover:border-indigo-400 text-slate-300 transition-colors">
            Done
          </button>
        </div>

        </template><!-- end channels tab -->

      </div>
    </div>
  </Teleport>
</template>
