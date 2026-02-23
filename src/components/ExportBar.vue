<script setup>
defineProps({
  selectedCount: { type: Number,  required: true },
  exporting:     { type: Boolean, required: true },
  copied:        { type: Boolean, required: true },
})
const emit = defineEmits(['copy', 'export'])
</script>

<template>
  <div class="flex items-center gap-3 px-5 py-3 border-t border-[#2e3250] bg-[#1a1d27] shrink-0">
    <span class="flex-1 text-sm text-slate-500">
      <span class="font-semibold text-slate-200">{{ selectedCount.toLocaleString() }}</span> channels selected
    </span>
    <button
      @click="emit('copy')"
      :disabled="!selectedCount || exporting"
      class="flex items-center gap-1.5 px-4 py-2 text-sm bg-[#22263a] border border-[#2e3250] rounded-xl hover:border-indigo-400 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <span v-if="exporting" class="w-3 h-3 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin"></span>
      {{ copied ? '✓ Copied!' : exporting ? 'Building…' : '📋 Copy M3U' }}
    </button>
    <button
      @click="emit('export')"
      :disabled="!selectedCount || exporting"
      class="flex items-center gap-1.5 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      <span v-if="exporting" class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
      {{ exporting ? 'Building…' : '⬇ Save M3U' }}
    </button>
  </div>
</template>
