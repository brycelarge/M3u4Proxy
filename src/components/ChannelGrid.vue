<script setup>
defineProps({
  filteredRows:    { type: Array,   required: true },
  gridCols:        { type: Number,  required: true },
  currentSelected: { type: Object,  required: true }, // Set
})
const emit = defineEmits(['toggle-channel'])

function onImgError(e) { e.target.style.display = 'none' }
</script>

<template>
  <RecycleScroller
    class="flex-1"
    :items="filteredRows"
    :item-size="176"
    key-field="rowId"
    v-slot="{ item: row }"
  >
    <div class="flex gap-2 px-4 py-1.5">
      <div
        v-for="ch in row.items"
        :key="ch.id"
        @click="emit('toggle-channel', ch)"
        :class="[
          'relative flex flex-col items-center p-2 border cursor-pointer transition-all select-none flex-1 min-w-0',
          currentSelected.has(ch.id)
            ? 'bg-[#1a1d27] border-yellow-500'
            : 'bg-[#1a1d27] border-[#2e3250] hover:border-[#4a4f7a]'
        ]"
      >
        <!-- Selection indicator (yellow corner mark) -->
        <div v-if="currentSelected.has(ch.id)" class="absolute top-0 right-0">
          <div class="w-0 h-0 border-t-[16px] border-r-[16px] border-t-yellow-500 border-r-yellow-500"></div>
        </div>

        <!-- Channel logo -->
        <div class="w-16 h-16 flex items-center justify-center overflow-hidden shrink-0 mb-1">
          <img v-if="ch.tvgLogo" :src="`/api/logo?url=${encodeURIComponent(ch.tvgLogo)}`" @error="onImgError" loading="lazy" class="w-full h-full object-contain" />
          <span v-else class="text-xl text-slate-600">📺</span>
        </div>

        <!-- Channel name -->
        <p class="text-xs font-medium text-center leading-tight line-clamp-2 w-full text-white">{{ ch.name }}</p>

        <!-- Channel info (click instruction) -->
        <p class="text-[10px] text-slate-500 mt-1">Click to {{ currentSelected.has(ch.id) ? 'remove' : 'select' }}</p>
      </div>
      <!-- Pad last row so grid stays even -->
      <div v-for="n in (gridCols - row.items.length)" :key="'pad-' + n" class="flex-1 min-w-0 invisible"></div>
    </div>
  </RecycleScroller>
</template>
