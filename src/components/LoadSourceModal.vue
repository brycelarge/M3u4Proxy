<script setup>
defineProps({
  show:         { type: Boolean, required: true },
  sourceTab:    { type: String,  required: true },
  m3uUrl:       { type: String,  required: true },
  xtreamUrl:    { type: String,  required: true },
  xtreamUser:   { type: String,  required: true },
  xtreamPass:   { type: String,  required: true },
  loading:      { type: Boolean, required: true },
  loadProgress: { type: Number,  required: true },
  error:        { type: String,  required: true },
  hasGroups:    { type: Boolean, required: true },
})

const emit = defineEmits([
  'update:sourceTab', 'update:m3uUrl', 'update:xtreamUrl',
  'update:xtreamUser', 'update:xtreamPass',
  'close', 'load-url', 'file-change', 'load-xtream',
])
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl w-full max-w-md p-6 shadow-2xl">

        <div class="flex items-center gap-3 mb-5">
          <span class="text-2xl">📺</span>
          <h2 class="text-lg font-bold">Load Playlist</h2>
          <button v-if="hasGroups" @click="emit('close')" class="ml-auto text-slate-500 hover:text-slate-300 text-xl leading-none">✕</button>
        </div>

        <!-- Tabs -->
        <div class="flex gap-2 mb-5">
          <button
            v-for="tab in [{ id: 'm3u', label: 'M3U' }, { id: 'xtream', label: 'Xtream API' }]"
            :key="tab.id"
            @click="emit('update:sourceTab', tab.id)"
            :class="['flex-1 py-2 rounded-xl text-sm font-semibold transition-all border',
              sourceTab === tab.id
                ? 'bg-indigo-500 border-indigo-500 text-white'
                : 'bg-transparent border-[#2e3250] text-slate-400 hover:border-indigo-400 hover:text-slate-200']"
          >{{ tab.label }}</button>
        </div>

        <!-- M3U tab -->
        <template v-if="sourceTab === 'm3u'">
          <label class="block text-xs text-slate-500 mb-1.5">Playlist URL</label>
          <input
            :value="m3uUrl"
            @input="emit('update:m3uUrl', $event.target.value)"
            placeholder="http://server/playlist/user/pass/m3u_plus"
            @keyup.enter="emit('load-url')"
            class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500 mb-3"
          />
          <button
            @click="emit('load-url')"
            :disabled="loading || !m3uUrl"
            class="w-full flex items-center justify-center gap-2 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-xl transition-colors"
          >
            <span v-if="loading" class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            {{ loading ? (loadProgress ? `Downloading… ${loadProgress}%` : 'Loading...') : 'Load from URL' }}
          </button>
          <div v-if="loading && loadProgress" class="w-full bg-[#22263a] rounded-full h-1 mt-2 overflow-hidden">
            <div class="bg-indigo-500 h-1 rounded-full transition-all duration-200" :style="{ width: loadProgress + '%' }"></div>
          </div>
          <div class="flex items-center gap-3 my-4">
            <div class="flex-1 h-px bg-[#2e3250]"></div>
            <span class="text-xs text-slate-600">or open file</span>
            <div class="flex-1 h-px bg-[#2e3250]"></div>
          </div>
          <input
            type="file"
            accept=".m3u,.m3u8,.txt"
            @change="emit('file-change', $event)"
            class="w-full text-xs text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:bg-[#22263a] file:text-slate-300 file:cursor-pointer hover:file:bg-[#2e3250] file:transition-colors"
          />
        </template>

        <!-- Xtream tab -->
        <template v-else>
          <div class="space-y-3">
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Server URL</label>
              <input :value="xtreamUrl" @input="emit('update:xtreamUrl', $event.target.value)" placeholder="http://server:port"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Username</label>
              <input :value="xtreamUser" @input="emit('update:xtreamUser', $event.target.value)" placeholder="username"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label class="block text-xs text-slate-500 mb-1.5">Password</label>
              <input :value="xtreamPass" @input="emit('update:xtreamPass', $event.target.value)" type="password" placeholder="password"
                @keyup.enter="emit('load-xtream')"
                class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500" />
            </div>
          </div>
          <button
            @click="emit('load-xtream')"
            :disabled="loading || !xtreamUrl || !xtreamUser || !xtreamPass"
            class="w-full flex items-center justify-center gap-2 bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-xl transition-colors mt-4"
          >
            <span v-if="loading" class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            {{ loading ? 'Connecting...' : 'Connect' }}
          </button>
        </template>

        <p v-if="error" class="text-xs text-red-400 mt-3">⚠ {{ error }}</p>
      </div>
    </div>
  </Teleport>
</template>
