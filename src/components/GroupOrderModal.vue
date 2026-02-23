<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../composables/useApi.js'

const props = defineProps({
  playlistId:   { type: [Number, String], required: true },
  playlistName: { type: String, required: true },
})
const emit = defineEmits(['close', 'saved'])

const order    = ref([])
const loading  = ref(true)
const saving   = ref(false)
const dragIdx  = ref(null)
const overIdx  = ref(null)

onMounted(async () => {
  const res = await api.getGroupOrder(props.playlistId)
  order.value = res.order
  loading.value = false
})

function onDragStart(e, idx) {
  dragIdx.value = idx
  e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e, idx) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  overIdx.value = idx
}
function onDragLeave() {
  overIdx.value = null
}
function onDrop(e, idx) {
  e.preventDefault()
  if (dragIdx.value === null || dragIdx.value === idx) { reset(); return }
  const arr = [...order.value]
  const [item] = arr.splice(dragIdx.value, 1)
  arr.splice(idx, 0, item)
  order.value = arr
  reset()
}
function onDragEnd() { reset() }
function reset() { dragIdx.value = null; overIdx.value = null }

function moveUp(idx) {
  if (idx === 0) return
  const arr = [...order.value];
  [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]]
  order.value = arr
}
function moveDown(idx) {
  if (idx === order.value.length - 1) return
  const arr = [...order.value];
  [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]]
  order.value = arr
}

async function save() {
  saving.value = true
  await api.saveGroupOrder(props.playlistId, order.value)
  saving.value = false
  emit('saved')
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[80vh]">

        <!-- Header -->
        <div class="flex items-center gap-3 px-6 py-4 border-b border-[#2e3250] shrink-0">
          <div class="flex-1">
            <h2 class="text-sm font-bold text-slate-100">Group Order</h2>
            <p class="text-xs text-slate-500 mt-0.5">{{ playlistName }}</p>
          </div>
          <button @click="emit('close')" class="text-slate-500 hover:text-slate-300 transition-colors text-lg leading-none">✕</button>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="flex items-center justify-center py-16">
          <span class="w-6 h-6 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
        </div>

        <!-- List -->
        <div v-else class="flex-1 overflow-y-auto px-4 py-3 space-y-1">
          <p class="text-[10px] text-slate-600 px-2 mb-2">Drag rows or use arrows to reorder. Order is applied when building or serving the M3U.</p>
          <div
            v-for="(group, idx) in order" :key="group"
            draggable="true"
            @dragstart="onDragStart($event, idx)"
            @dragover="onDragOver($event, idx)"
            @dragleave="onDragLeave"
            @drop="onDrop($event, idx)"
            @dragend="onDragEnd"
            :class="['flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-colors cursor-grab active:cursor-grabbing select-none',
              overIdx === idx && dragIdx !== idx
                ? 'bg-indigo-500/15 border-indigo-500/40'
                : dragIdx === idx
                  ? 'bg-[#22263a] border-[#3a3f5c] opacity-50'
                  : 'bg-[#13151f] border-[#2e3250] hover:border-[#3a3f5c]']"
          >
            <!-- Drag handle -->
            <span class="text-slate-600 text-sm shrink-0 cursor-grab">⠿</span>

            <!-- Index badge -->
            <span class="text-[10px] text-slate-600 w-5 text-right shrink-0">{{ idx + 1 }}</span>

            <!-- Group name -->
            <span class="flex-1 text-sm text-slate-200 truncate">{{ group }}</span>

            <!-- Arrow buttons -->
            <div class="flex gap-0.5 shrink-0">
              <button @click.stop="moveUp(idx)" :disabled="idx === 0"
                class="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-[#22263a] disabled:opacity-20 transition-colors text-xs">
                ▲
              </button>
              <button @click.stop="moveDown(idx)" :disabled="idx === order.length - 1"
                class="w-6 h-6 flex items-center justify-center rounded text-slate-500 hover:text-slate-200 hover:bg-[#22263a] disabled:opacity-20 transition-colors text-xs">
                ▼
              </button>
            </div>
          </div>

          <div v-if="!order.length" class="text-center py-10 text-slate-600 text-sm">
            No groups found — save channels to this playlist first.
          </div>
        </div>

        <!-- Footer -->
        <div class="flex gap-3 px-6 py-4 border-t border-[#2e3250] shrink-0">
          <button @click="emit('close')" class="flex-1 py-2.5 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl text-slate-300 hover:border-slate-500 transition-colors">
            Cancel
          </button>
          <button @click="save" :disabled="saving || loading || !order.length"
            class="flex-1 py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors">
            {{ saving ? 'Saving…' : 'Save Order' }}
          </button>
        </div>

      </div>
    </div>
  </Teleport>
</template>
