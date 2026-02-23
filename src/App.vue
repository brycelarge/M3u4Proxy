<script setup>
import { ref, onMounted } from 'vue'
import AdminLogin         from './components/AdminLogin.vue'
import { isAuthenticated, verifySession, logout } from './composables/useAdmin.js'
import ChannelBrowserPage from './pages/ChannelBrowserPage.vue'
import SourcesPage        from './pages/SourcesPage.vue'
import PlaylistsPage      from './pages/PlaylistsPage.vue'
import EpgMappingsPage    from './pages/EpgMappingsPage.vue'
import EpgGuidePage      from './pages/EpgGuidePage.vue'
import EpgScraperPage     from './pages/EpgScraperPage.vue'
import StreamsPage        from './pages/StreamsPage.vue'
import SettingsPage       from './pages/SettingsPage.vue'
import UsersPage          from './pages/UsersPage.vue'

const page      = ref('browser')
const theme     = ref('dark')
const navOpen   = ref(false)
const authReady = ref(false)

function applyTheme(t) {
  theme.value = t
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('m3u_theme', t)
}
function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark') }

const NAV = [
  { id: 'browser',      label: 'Channel Browser', icon: '📺' },
  { id: 'playlists',    label: 'Playlists',        icon: '📝' },
  { id: 'sources',      label: 'Sources',          icon: '📡' },
  { id: 'streams',      label: 'Streams',          icon: '🔴' },
  { id: 'epg-scraper',  label: 'EPG Scraper',      icon: '🗓️' },
  { id: 'epg-mappings', label: 'EPG Mappings',     icon: '🗺️' },
  { id: 'epg-guide',    label: 'EPG Guide',        icon: '📺' },
  { id: 'users',        label: 'Users',            icon: '👤' },
  { id: 'settings',     label: 'Settings',         icon: '⚙️' },
]

const VALID_PAGES = new Set(NAV.map(n => n.id))

function navigate(id) {
  page.value = id
  navOpen.value = false
  location.hash = id
}

onMounted(async () => {
  await verifySession()
  authReady.value = true
  const saved = localStorage.getItem('m3u_theme') || 'dark'
  applyTheme(saved)
  const hash = location.hash.slice(1)
  if (hash && VALID_PAGES.has(hash)) page.value = hash
})
</script>

<template>
  <!-- Auth loading -->
  <div v-if="!authReady" class="min-h-screen bg-[#0f1117] flex items-center justify-center">
    <span class="w-6 h-6 border-2 border-slate-700 border-t-indigo-400 rounded-full animate-spin"></span>
  </div>

  <!-- Login wall -->
  <AdminLogin v-else-if="!isAuthenticated" />

  <!-- App -->
  <div v-else class="flex flex-col h-screen bg-[#0f1117] text-slate-200 font-sans">

    <!-- Top Nav -->
    <nav class="flex items-center gap-1 px-3 py-2 bg-[#1a1d27] border-b border-[#2e3250] shrink-0 relative z-40">
      <img src="/logo.svg" alt="M3u4Prox" class="w-7 h-7 mr-1 shrink-0" />
      <span class="text-sm font-bold tracking-tight mr-2 shrink-0">M3u4Prox</span>

      <!-- Desktop nav buttons -->
      <div class="hidden md:flex items-center gap-0.5 flex-1 overflow-x-auto">
        <button
          v-for="n in NAV" :key="n.id"
          @click="navigate(n.id)"
          :class="['flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg transition-colors font-medium whitespace-nowrap shrink-0',
            page === n.id ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40' : 'text-slate-400 hover:text-slate-200 hover:bg-[#22263a]']"
        >{{ n.icon }} {{ n.label }}</button>
      </div>

      <!-- Mobile: current page label -->
      <span class="md:hidden flex-1 text-xs text-slate-400 truncate">
        {{ NAV.find(n => n.id === page)?.icon }} {{ NAV.find(n => n.id === page)?.label }}
      </span>

      <!-- Theme toggle -->
      <button
        @click="toggleTheme"
        :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
        class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#22263a] transition-colors text-base shrink-0"
      >{{ theme === 'dark' ? '☀️' : '🌙' }}</button>

      <!-- Logout -->
      <button
        @click="logout"
        title="Sign out"
        class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors text-sm shrink-0"
      >⏻</button>

      <!-- Hamburger (mobile only) -->
      <button
        @click="navOpen = !navOpen"
        class="md:hidden flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#22263a] transition-colors shrink-0"
        aria-label="Menu"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path v-if="!navOpen" stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
          <path v-else stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </nav>

    <!-- Mobile dropdown menu -->
    <div v-if="navOpen" class="md:hidden bg-[#1a1d27] border-b border-[#2e3250] z-30 shrink-0">
      <button
        v-for="n in NAV" :key="n.id"
        @click="navigate(n.id)"
        :class="['w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors border-b border-[#2e3250]/50 last:border-0',
          page === n.id ? 'bg-indigo-500/15 text-indigo-300' : 'text-slate-300 hover:bg-[#22263a]']"
      >
        <span class="text-base w-6 text-center shrink-0">{{ n.icon }}</span>
        {{ n.label }}
        <span v-if="page === n.id" class="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
      </button>
    </div>

    <!-- Pages -->
    <ChannelBrowserPage v-if="page === 'browser'"       class="flex-1 overflow-hidden flex flex-col" />
    <SourcesPage        v-else-if="page === 'sources'"       class="flex-1 overflow-y-auto" />
    <PlaylistsPage      v-else-if="page === 'playlists'"     class="flex-1 overflow-y-auto" />
    <StreamsPage        v-else-if="page === 'streams'"       class="flex-1 overflow-y-auto" />
    <UsersPage          v-else-if="page === 'users'"          class="flex-1 overflow-y-auto" />
    <SettingsPage       v-else-if="page === 'settings'"      class="flex-1 overflow-y-auto" />
    <EpgScraperPage     v-else-if="page === 'epg-scraper'"   class="flex-1 overflow-y-auto" />
    <EpgMappingsPage    v-else-if="page === 'epg-mappings'"  class="flex-1 overflow-y-auto" />
    <EpgGuidePage       v-else-if="page === 'epg-guide'"      class="flex-1 overflow-hidden" />

  </div>
</template>
