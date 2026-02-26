<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const channelId = route.params.channelId
const channelName = route.query.name || 'Live Stream'
const error = ref('')
const loading = ref(true)
const videoRef = ref(null)
const streamUrl = `/stream/${channelId}?remux=1`

onMounted(() => {
  if (videoRef.value) {
    // Add event listeners for better error handling
    videoRef.value.addEventListener('loadstart', () => {
      loading.value = true
      error.value = ''
    })

    videoRef.value.addEventListener('loadeddata', () => {
      loading.value = false
    })

    videoRef.value.addEventListener('canplay', () => {
      loading.value = false
      // Attempt autoplay
      videoRef.value.play().catch(e => {
        console.error('Autoplay failed:', e)
        error.value = 'Click play to start stream'
        loading.value = false
      })
    })

    videoRef.value.addEventListener('error', (e) => {
      loading.value = false
      const mediaError = videoRef.value.error
      if (mediaError) {
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            error.value = 'Stream aborted'
            break
          case mediaError.MEDIA_ERR_NETWORK:
            error.value = 'Network error - check connection'
            break
          case mediaError.MEDIA_ERR_DECODE:
            error.value = 'Stream decode error'
            break
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            error.value = 'Stream format not supported'
            break
          default:
            error.value = 'Stream playback error'
        }
      } else {
        error.value = 'Stream unavailable'
      }
    })

    videoRef.value.addEventListener('waiting', () => {
      loading.value = true
    })

    videoRef.value.addEventListener('playing', () => {
      loading.value = false
      error.value = ''
    })

    // Load the stream
    videoRef.value.load()
  }
})

onUnmounted(() => {
  if (videoRef.value) {
    videoRef.value.pause()
    videoRef.value.src = ''
    videoRef.value.load()
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

    <div class="flex-1 flex items-center justify-center relative">
      <video
        ref="videoRef"
        :src="streamUrl"
        controls
        autoplay
        playsinline
        class="w-full h-full"
        style="max-height: 100vh; object-fit: contain;">
        <p class="text-slate-400 text-sm">Your browser does not support video playback.</p>
      </video>

      <div v-if="loading && !error" class="absolute inset-0 flex items-center justify-center bg-black/50">
        <div class="flex flex-col items-center gap-3">
          <div class="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
          <p class="text-sm text-slate-400">Loading stream...</p>
        </div>
      </div>
    </div>

    <div v-if="error" class="absolute top-20 left-1/2 transform -translate-x-1/2 px-4 py-3 bg-red-500/20 border border-red-500/40 rounded-lg text-sm text-red-300">
      {{ error }}
    </div>
  </div>
</template>
