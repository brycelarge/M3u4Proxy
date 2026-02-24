<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const channelId = route.params.channelId
const channelName = route.query.name || 'Live Stream'
const streamUrl = `/stream/${channelId}`
const error = ref('')
const videoRef = ref(null)

onMounted(() => {
  if (videoRef.value) {
    videoRef.value.load()
  }
})

onUnmounted(() => {
  if (videoRef.value) {
    videoRef.value.pause()
    videoRef.value.src = ''
  }
})
</script>

<template>
  <div class="flex flex-col h-screen bg-black">
    <div class="flex items-center justify-between px-4 py-3 bg-[#1a1d27] border-b border-[#2e3250]">
      <div class="flex items-center gap-3">
        <button @click="$router.back()" 
          class="text-slate-400 hover:text-slate-200 text-xl">←</button>
        <h1 class="text-sm font-semibold text-slate-100">{{ channelName }}</h1>
      </div>
    </div>

    <div class="flex-1 flex items-center justify-center">
      <video 
        ref="videoRef"
        :src="streamUrl"
        controls
        autoplay
        class="w-full h-full"
        style="max-height: 100vh; object-fit: contain;">
        <p class="text-slate-400 text-sm">Your browser does not support video playback.</p>
      </video>
    </div>

    <div v-if="error" class="absolute top-20 left-1/2 transform -translate-x-1/2 px-4 py-3 bg-red-500/20 border border-red-500/40 rounded-lg text-sm text-red-300">
      {{ error }}
    </div>
  </div>
</template>
