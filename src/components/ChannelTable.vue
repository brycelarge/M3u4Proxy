<script setup>
defineProps({
  filtered:        { type: Array,   required: true },
  currentSelected: { type: Object,  required: true }, // Set
})
const emit = defineEmits(['toggle-channel', 'select-all', 'select-none'])

function onImgError(e) { e.target.style.display = 'none' }

function onHeaderCheckbox(filtered, currentSelected) {
  if (filtered.every(c => currentSelected.has(c.id))) emit('select-none')
  else emit('select-all')
}
</script>

<template>
  <div class="flex-1 flex flex-col overflow-hidden">
    <!-- Header -->
    <div class="shrink-0 bg-[#1a1d27] border-b border-[#2e3250]">
      <div class="flex items-center px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
        <div class="w-8 shrink-0">
          <input
            type="checkbox"
            :checked="filtered.length > 0 && filtered.every(c => currentSelected.has(c.id))"
            :indeterminate="filtered.some(c => currentSelected.has(c.id)) && !filtered.every(c => currentSelected.has(c.id))"
            @change="onHeaderCheckbox(filtered, currentSelected)"
            class="accent-indigo-500 cursor-pointer"
          />
        </div>
        <div class="w-9 shrink-0"></div>
        <div class="flex-1">Name</div>
        <div class="w-48 shrink-0 hidden md:block">Group</div>
        <div class="w-48 shrink-0 hidden lg:block">EPG ID</div>
      </div>
    </div>
    <!-- Rows -->
    <RecycleScroller class="flex-1" :items="filtered" :item-size="44" key-field="id" v-slot="{ item: ch }">
      <div
        @click="emit('toggle-channel', ch)"
        :class="['flex items-center px-4 py-2 border-b border-[#2e3250]/40 cursor-pointer transition-colors h-11',
          currentSelected.has(ch.id) ? 'bg-indigo-500/10' : 'hover:bg-[#22263a]']"
      >
        <div class="w-8 shrink-0" @click.stop>
          <input type="checkbox" :checked="currentSelected.has(ch.id)" @change="emit('toggle-channel', ch)" class="accent-indigo-500 cursor-pointer" />
        </div>
        <div class="w-9 shrink-0">
          <div class="w-7 h-7 rounded-lg bg-[#22263a] flex items-center justify-center overflow-hidden">
            <img v-if="ch.tvgLogo" :src="`/api/logo?url=${encodeURIComponent(ch.tvgLogo)}`" @error="onImgError" loading="lazy" class="w-full h-full object-contain p-0.5" />
            <span v-else class="text-xs text-slate-600">📺</span>
          </div>
        </div>
        <div class="flex-1 min-w-0 font-medium text-sm text-slate-200 truncate">{{ ch.name }}</div>
        <div class="w-48 shrink-0 text-sm text-slate-500 truncate hidden md:block">{{ ch.group }}</div>
        <div class="w-48 shrink-0 text-xs text-slate-600 truncate hidden lg:block">{{ ch.tvgId }}</div>
      </div>
    </RecycleScroller>
  </div>
</template>
