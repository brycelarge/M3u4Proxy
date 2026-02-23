<script setup>
defineProps({
  m3uUrl:       { type: String,  required: true },
  urlCopied:    { type: Boolean, required: true },
  totalCount:   { type: Number,  required: true },
  selectedCount:{ type: Number,  required: true },
  exporting:    { type: Boolean, required: true },
})
const emit = defineEmits(['copy-url', 'open-webplayer', 'export'])
</script>

<template>
  <div class="flex items-center gap-3 px-4 py-2.5 bg-[#13151f] border-b border-[#2e3250] shrink-0 flex-wrap">
    <!-- URL display + copy -->
    <div class="flex items-center gap-2 flex-1 min-w-0 bg-[#1a1d27] border border-[#2e3250] rounded-xl px-3 py-2">
      <svg class="w-3.5 h-3.5 text-slate-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
      <span class="text-xs text-slate-400 truncate flex-1 font-mono">{{ m3uUrl }}</span>
      <button
        @click="emit('copy-url')"
        class="shrink-0 text-xs px-2 py-0.5 rounded-md transition-colors"
        :class="urlCopied ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'"
      >{{ urlCopied ? '✓ Copied' : 'Copy' }}</button>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2 shrink-0">
      <button
        @click="emit('open-webplayer')"
        class="flex items-center gap-1.5 px-3 py-2 text-xs bg-[#1a1d27] border border-[#2e3250] rounded-xl hover:border-indigo-400 text-slate-300 transition-colors font-medium"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Web Player
      </button>
      <button
        @click="emit('export')"
        :disabled="!selectedCount || exporting"
        class="flex items-center gap-1.5 px-3 py-2 text-xs bg-[#1a1d27] border border-[#2e3250] rounded-xl hover:border-indigo-400 text-slate-300 disabled:opacity-40 transition-colors font-medium"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        Download M3U
      </button>
    </div>

    <!-- Total channels -->
    <div class="flex items-center gap-2 bg-[#1a1d27] border border-[#2e3250] rounded-xl px-3 py-2 shrink-0">
      <svg class="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8M12 17v4"/>
      </svg>
      <div>
        <p class="text-[10px] text-slate-500 leading-none mb-0.5">Total Channels</p>
        <p class="text-sm font-bold text-slate-100 leading-none">{{ totalCount.toLocaleString() }}</p>
      </div>
    </div>
  </div>
</template>
