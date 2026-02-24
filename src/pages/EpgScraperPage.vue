<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../composables/useApi.js'

const activeTab = ref('browser') // 'browser' | 'xml'

// ── channels.xml ──────────────────────────────────────────────────────────────
const channelsXml = ref('')
const xmlPath     = ref('')
const saving      = ref(false)
const saveSuccess = ref('')
const saveError   = ref('')

// ── Sync status ───────────────────────────────────────────────────────────────
const syncStatus  = ref(null)  // { inProgress, lastSynced, totalSites, totalChannels, log }
const syncing     = ref(false)
let   syncPoller  = null

async function loadSyncStatus() {
  try { syncStatus.value = await api.getEpgSyncStatus() } catch {}
}

async function triggerSync() {
  syncing.value = true
  try {
    await api.triggerEpgSync()
    // Poll until done
    syncPoller = setInterval(async () => {
      await loadSyncStatus()
      if (!syncStatus.value?.inProgress) {
        clearInterval(syncPoller)
        syncing.value = false
        await loadSites()
      }
    }, 2000)
  } catch (e) {
    siteError.value = e.message
    syncing.value = false
  }
}

// ── Site browser ──────────────────────────────────────────────────────────────
const sites        = ref([])
const siteSearch   = ref('')
const activeSite   = ref(null)
const siteFiles    = ref([])   // [{ file, count }] — country variants for active site
const activeFile   = ref(null) // e.g. 'dstv.com_za.channels.xml'
const loadingFiles = ref(false)
const siteChannels = ref([])
const chanSearch   = ref('')
const loadingSites = ref(false)
const loadingChans = ref(false)
const siteError    = ref('')

// ── Global search ─────────────────────────────────────────────────────────────
const globalSearch    = ref('')
const globalResults   = ref([])
const searchingGlobal = ref(false)

// ── Selection ─────────────────────────────────────────────────────────────────
// selectedChannels: full channel objects [{name,site,site_id,lang,xmltv_id}]
const selectedChannels = ref([])
const selectedKeys     = computed(() => new Set(selectedChannels.value.map(selKey)))

function selKey(ch) { return `${ch.site}::${ch.site_id}` }
function isSelected(ch) { return selectedKeys.value.has(selKey(ch)) }

function addToSelected(ch) {
  if (!isSelected(ch)) selectedChannels.value = [...selectedChannels.value, ch]
}
function removeFromSelected(ch) {
  const k = selKey(ch)
  selectedChannels.value = selectedChannels.value.filter(c => selKey(c) !== k)
}
function toggleChannelFull(ch) {
  isSelected(ch) ? removeFromSelected(ch) : addToSelected(ch)
}

// ── Filtered lists ────────────────────────────────────────────────────────────
const filteredSites = computed(() => {
  if (!siteSearch.value.trim()) return sites.value
  const q = siteSearch.value.toLowerCase()
  return sites.value.filter(s => s.toLowerCase().includes(q))
})

const filteredSiteChannels = computed(() => {
  if (!chanSearch.value.trim()) return siteChannels.value
  const q = chanSearch.value.toLowerCase()
  return siteChannels.value.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.site_id.toLowerCase().includes(q) ||
    c.xmltv_id.toLowerCase().includes(q)
  )
})

function selectAll() {
  const existing = new Map(selectedChannels.value.map(c => [selKey(c), c]))
  for (const ch of filteredSiteChannels.value) existing.set(selKey(ch), ch)
  selectedChannels.value = [...existing.values()]
}
function selectNone() {
  const toRemove = new Set(filteredSiteChannels.value.map(selKey))
  selectedChannels.value = selectedChannels.value.filter(c => !toRemove.has(selKey(c)))
}

// ── Loaders ───────────────────────────────────────────────────────────────────
async function loadSites() {
  loadingSites.value = true
  siteError.value = ''
  try {
    const result = await api.getEpgSites()
    // Backend returns { empty: true } when DB not yet synced
    if (Array.isArray(result)) {
      sites.value = result
    } else {
      sites.value = []
    }
  }
  catch (e) { siteError.value = e.message }
  finally { loadingSites.value = false }
}

async function selectSite(site) {
  if (activeSite.value === site) return
  activeSite.value   = site
  activeFile.value   = null
  siteFiles.value    = []
  siteChannels.value = []
  chanSearch.value   = ''
  siteError.value    = ''
  loadingFiles.value = true
  try {
    const files = await api.getSiteFiles(site)
    siteFiles.value = files
    // If only one file, auto-select it
    if (files.length === 1) await selectFile(files[0].file)
  } catch (e) { siteError.value = e.message }
  finally { loadingFiles.value = false }
}

async function selectFile(file) {
  if (activeFile.value === file) return
  activeFile.value   = file
  siteChannels.value = []
  chanSearch.value   = ''
  siteError.value    = ''
  loadingChans.value = true
  try { siteChannels.value = await api.getSiteChannels(activeSite.value, file) }
  catch (e) { siteError.value = e.message }
  finally { loadingChans.value = false }
}

let globalTimer = null
async function onGlobalSearch() {
  clearTimeout(globalTimer)
  if (!globalSearch.value.trim()) { globalResults.value = []; return }
  globalTimer = setTimeout(async () => {
    searchingGlobal.value = true
    try { globalResults.value = await api.searchSiteChannels(globalSearch.value, activeSite.value || undefined) }
    catch { globalResults.value = [] }
    finally { searchingGlobal.value = false }
  }, 300)
}

// ── EPG Grab ──────────────────────────────────────────────────────────────────
const grabStatus  = ref(null)
const grabbing    = ref(false)
let   grabPoller  = null

async function loadGrabStatus() {
  try { grabStatus.value = await api.getEpgGrabStatus() } catch {}
}

async function triggerGrab() {
  grabbing.value = true
  siteError.value = ''
  try {
    await api.triggerEpgGrab()
    grabPoller = setInterval(async () => {
      await loadGrabStatus()
      if (!grabStatus.value?.inProgress) {
        clearInterval(grabPoller)
        grabbing.value = false
      }
    }, 2000)
  } catch (e) {
    siteError.value = e.message
    grabbing.value = false
  }
}

// ── Save as EPG Source ────────────────────────────────────────────────────────
const epgSourceStatus = ref('')  // '', 'saving', 'ok', 'exists', 'error'
const epgSourceError  = ref('')

async function saveAsEpgSource() {
  epgSourceStatus.value = 'saving'
  epgSourceError.value  = ''
  // First save channels.xml
  const content = activeTab.value === 'xml' ? channelsXml.value : buildXml()
  try {
    await api.saveChannelsXml(content)
    channelsXml.value = content
  } catch (e) {
    epgSourceStatus.value = 'error'
    epgSourceError.value  = `Failed to save channels.xml: ${e.message}`
    return
  }
  // Then register the guide.xml URL as an EPG source
  try {
    const result = await api.createEpgSourceFromScraper({ name: 'EPG Scraper (guide.xml)' })
    epgSourceStatus.value = result.created ? 'ok' : 'exists'
    setTimeout(() => { epgSourceStatus.value = '' }, 4000)
  } catch (e) {
    epgSourceStatus.value = 'error'
    epgSourceError.value  = e.message
  }
}

// ── channels.xml ──────────────────────────────────────────────────────────────
async function loadChannelsXml() {
  try {
    const data = await api.getChannelsXml()
    channelsXml.value = data.content
    xmlPath.value = data.path
    parseExistingXml(data.content)
  } catch {}
}

function parseExistingXml(xml) {
  const re = /<channel\s([^>]*)>([^<]*)<\/channel>/g
  let m
  const parsed = []
  const seen = new Set()
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1]
    const name  = m[2].trim()
    const get   = (a) => { const r = new RegExp(`${a}="([^"]*)"`) ; return (attrs.match(r) || [])[1] || '' }
    const ch = { name, site: get('site'), site_id: get('site_id'), lang: get('lang') || 'en', xmltv_id: get('xmltv_id') }
    const k = selKey(ch)
    if (!seen.has(k)) { seen.add(k); parsed.push(ch) }
  }
  selectedChannels.value = parsed
}

function autoXmltvId(ch) {
  if (ch.xmltv_id) return ch.xmltv_id
  // Derive a stable xmltv_id from site + name: "NationalGeographic.dstv.com"
  const slug = ch.name.replace(/[^a-zA-Z0-9]/g, '')
  return `${slug}.${ch.site}`
}

function buildXml() {
  if (!selectedChannels.value.length) return '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n</channels>'

  // Group channels by site
  const bySite = {}
  for (const ch of selectedChannels.value) {
    if (!bySite[ch.site]) bySite[ch.site] = []
    bySite[ch.site].push(ch)
  }

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>']

  // Generate separate <channels site="..."> block for each site
  for (const [site, channels] of Object.entries(bySite)) {
    lines.push(`<channels site="${site}">`)
    for (const ch of channels) {
      const xmltv_id = autoXmltvId(ch)
      const attrs = [`site_id="${ch.site_id}"`, `xmltv_id="${xmltv_id}"`]
      if (ch.lang) attrs.push(`lang="${ch.lang}"`)
      lines.push(`  <channel ${attrs.join(' ')}>${ch.name}</channel>`)
    }
    lines.push('</channels>')
  }

  return lines.join('\n')
}

async function saveChannelsXml() {
  saving.value = true
  saveError.value = ''
  saveSuccess.value = ''
  const content = activeTab.value === 'xml' ? channelsXml.value : buildXml()
  try {
    await api.saveChannelsXml(content)
    channelsXml.value = content
    saveSuccess.value = `Saved to ${xmlPath.value}`
    setTimeout(() => (saveSuccess.value = ''), 3000)
  } catch (e) {
    saveError.value = e.message
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadChannelsXml(), loadSites(), loadSyncStatus(), loadGrabStatus()])
  // If a sync is already in progress, start polling
  if (syncStatus.value?.inProgress) {
    syncing.value = true
    syncPoller = setInterval(async () => {
      await loadSyncStatus()
      if (!syncStatus.value?.inProgress) {
        clearInterval(syncPoller)
        syncing.value = false
        await loadSites()
      }
    }, 2000)
  }
  // If a grab is already in progress, start polling
  if (grabStatus.value?.inProgress) {
    grabbing.value = true
    grabPoller = setInterval(async () => {
      await loadGrabStatus()
      if (!grabStatus.value?.inProgress) {
        clearInterval(grabPoller)
        grabbing.value = false
      }
    }, 2000)
  }
})

onUnmounted(() => {
  if (syncPoller) clearInterval(syncPoller)
  if (grabPoller) clearInterval(grabPoller)
})
</script>

<template>
  <div class="flex flex-col h-full overflow-hidden">
    <!-- Mobile warning for horizontal scroll -->
    <div class="md:hidden px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-xs">
      Scroll horizontally to see all content →
    </div>

    <!-- Page header -->
    <div class="flex items-center gap-4 px-6 py-3 bg-[#1a1d27] border-b border-[#2e3250] shrink-0">
      <div class="flex-1">
        <h1 class="text-sm font-bold text-slate-100">EPG Scraper</h1>
        <p class="text-xs text-slate-500">
          <span class="text-slate-400">1.</span> Select channels →
          <span class="text-slate-400">2.</span> Save &amp; Activate EPG →
          <span class="text-slate-400">3.</span> Grab EPG → <code class="font-mono text-slate-400">guide.xml</code> served at <code class="font-mono text-slate-400">/guide.xml</code>
        </p>
      </div>
      <div class="flex border border-[#2e3250] rounded-lg overflow-hidden">
        <button @click="activeTab = 'browser'" :class="['px-3 py-1.5 text-xs font-medium transition-colors', activeTab === 'browser' ? 'bg-indigo-500 text-white' : 'bg-[#22263a] text-slate-400 hover:text-slate-200']">🌐 Site Browser</button>
        <button @click="activeTab = 'xml'" :class="['px-3 py-1.5 text-xs font-medium transition-colors border-l border-[#2e3250]', activeTab === 'xml' ? 'bg-indigo-500 text-white' : 'bg-[#22263a] text-slate-400 hover:text-slate-200']">📄 Raw XML</button>
      </div>
      <button @click="saveChannelsXml" :disabled="saving"
        class="flex items-center gap-1.5 px-4 py-2 text-xs bg-[#22263a] border border-[#2e3250] hover:border-slate-400 disabled:opacity-40 text-slate-300 font-semibold rounded-xl transition-colors"
        title="Save channels.xml to disk only (does not register as EPG source)">
        <span v-if="saving" class="w-3 h-3 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin"></span>
        {{ saving ? 'Saving…' : '💾 Save channels.xml' }}
      </button>
      <button @click="saveAsEpgSource" :disabled="epgSourceStatus === 'saving' || !selectedChannels.length"
        class="flex items-center gap-1.5 px-4 py-2 text-xs bg-[#22263a] border border-[#2e3250] hover:border-indigo-500 disabled:opacity-40 text-slate-300 font-semibold rounded-xl transition-colors"
        title="Saves channels.xml and registers /guide.xml as an EPG source">
        <span v-if="epgSourceStatus === 'saving'" class="w-3 h-3 border-2 border-slate-400/30 border-t-slate-300 rounded-full animate-spin"></span>
        <template v-else-if="epgSourceStatus === 'ok'">✓ EPG Source Active</template>
        <template v-else-if="epgSourceStatus === 'exists'">✓ EPG Source Active</template>
        <template v-else>📡 Save &amp; Activate EPG</template>
      </button>
      <button @click="triggerGrab" :disabled="grabbing || !selectedChannels.length"
        class="flex items-center gap-1.5 px-4 py-2 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors"
        title="Run epg-grabber now to fetch programme data and write guide.xml">
        <span v-if="grabbing" class="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
        {{ grabbing ? 'Grabbing…' : '⚡ Grab EPG' }}
      </button>
    </div>

    <!-- Sync status banner -->
    <div v-if="syncing || (syncStatus && !syncStatus.lastSynced)" class="flex items-center gap-3 px-6 py-2 shrink-0 bg-indigo-500/10 border-b border-indigo-500/20">
      <span v-if="syncing" class="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin shrink-0"></span>
      <span v-else class="text-indigo-400 shrink-0">📥</span>
      <div class="flex-1 min-w-0">
        <p class="text-xs text-indigo-300 font-medium">
          {{ syncing ? 'Syncing iptv-org/epg repository…' : 'EPG site database not yet synced' }}
        </p>
        <p v-if="syncing && syncStatus?.log?.length" class="text-[10px] text-indigo-400/70 truncate mt-0.5">{{ syncStatus.log[syncStatus.log.length - 1] }}</p>
        <p v-else-if="!syncing" class="text-[10px] text-indigo-400/70 mt-0.5">Click Sync to download all EPG site channel data (~50MB, runs once then weekly)</p>
      </div>
      <button v-if="!syncing" @click="triggerSync"
        class="px-3 py-1.5 text-xs bg-indigo-500 hover:bg-indigo-400 text-white font-semibold rounded-lg transition-colors shrink-0">
        ↓ Sync Now
      </button>
    </div>

    <!-- Sync info bar (after sync) -->
    <div v-else-if="syncStatus?.lastSynced" class="flex items-center gap-3 px-6 py-1.5 shrink-0 bg-[#13151f] border-b border-[#2e3250]">
      <span class="text-[10px] text-slate-600">
        {{ syncStatus.totalSites?.toLocaleString() }} sites · {{ syncStatus.totalChannels?.toLocaleString() }} channels · last synced {{ new Date(syncStatus.lastSynced).toLocaleDateString() }}
      </span>
      <button @click="triggerSync" :disabled="syncing"
        class="ml-auto text-[10px] text-slate-500 hover:text-indigo-400 transition-colors disabled:opacity-40">
        ↻ Re-sync
      </button>
    </div>

    <!-- Grab status bar -->
    <div v-if="grabbing || grabStatus?.lastFinished || grabStatus?.lastError" class="flex items-center gap-3 px-6 py-2 shrink-0 border-b"
      :class="grabStatus?.lastError ? 'bg-red-500/10 border-red-500/20' : 'bg-emerald-500/10 border-emerald-500/20'">
      <span v-if="grabbing" class="w-3 h-3 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin shrink-0"></span>
      <span v-else-if="grabStatus?.lastError" class="text-red-400 shrink-0">✗</span>
      <span v-else class="text-emerald-400 shrink-0">✓</span>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium" :class="grabStatus?.lastError ? 'text-red-300' : 'text-emerald-300'">
          <template v-if="grabbing">
            Grabbing EPG{{ grabStatus?.progress?.site ? ` · ${grabStatus.progress.site}` : '' }}
            <span v-if="grabStatus?.progress?.channelTotal" class="text-emerald-400/70">
              · {{ grabStatus.progress.channelDone }}/{{ grabStatus.progress.channelTotal }} requests
            </span>
          </template>
          <template v-else-if="grabStatus?.lastError">Grab failed: {{ grabStatus.lastError }}</template>
          <template v-else>guide.xml ready · {{ grabStatus?.lastFinished ? new Date(grabStatus.lastFinished).toLocaleString() : '' }}</template>
        </p>
        <p v-if="grabbing && grabStatus?.log?.length" class="text-[10px] text-emerald-400/60 truncate mt-0.5">{{ grabStatus.log[grabStatus.log.length - 1] }}</p>
      </div>
      <a v-if="grabStatus?.guideExists && !grabbing" :href="grabStatus.guideUrl" target="_blank"
        class="text-[10px] text-emerald-400 hover:text-emerald-300 shrink-0 transition-colors">↗ guide.xml</a>
    </div>

    <!-- Save status bar -->
    <div v-if="saveSuccess || saveError || epgSourceError" class="px-6 py-1.5 shrink-0 text-xs"
      :class="(saveSuccess) ? 'bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-b border-red-500/20 text-red-400'">
      {{ saveSuccess || saveError || epgSourceError }}
    </div>

    <!-- ── SITE BROWSER TAB ─────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'browser'" class="flex flex-1 overflow-hidden">

      <!-- Col 1: Sites list -->
      <div class="w-72 shrink-0 flex flex-col border-r border-[#2e3250] bg-[#13151f]">
        <div class="p-2 border-b border-[#2e3250]">
          <input v-model="siteSearch" placeholder="Filter sites…"
            class="w-full bg-[#22263a] border border-[#2e3250] rounded-lg px-2.5 py-1.5 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500" />
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="loadingSites" class="flex items-center justify-center py-10">
            <span class="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
          </div>
          <div v-else-if="syncing" class="flex flex-col items-center justify-center py-10 gap-2 text-slate-600 px-3 text-center">
            <span class="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
            <p class="text-[10px]">Syncing…</p>
          </div>
          <div v-else-if="!sites.length && !siteError" class="flex flex-col items-center justify-center py-10 gap-2 text-slate-600 px-3 text-center">
            <p class="text-2xl">📥</p>
            <p class="text-[10px]">No data yet.<br>Click Sync Now above.</p>
          </div>
          <div v-else-if="siteError" class="p-3 text-xs text-red-400">{{ siteError }}</div>
          <button
            v-else v-for="site in filteredSites" :key="site"
            @click="selectSite(site)"
            :class="['w-full text-left px-3 py-1.5 text-xs transition-colors border-b border-[#2e3250]/20',
              activeSite === site ? 'bg-indigo-500/20 text-indigo-300 font-medium' : 'text-slate-400 hover:bg-[#22263a] hover:text-slate-200']"
          >{{ site }}</button>
        </div>
        <div class="px-3 py-1.5 border-t border-[#2e3250] text-[10px] text-slate-600">
          {{ filteredSites.length.toLocaleString() }} sites
        </div>
      </div>

      <!-- Col 2: Country/file variants for selected site -->
      <div class="w-52 shrink-0 flex flex-col border-r border-[#2e3250] bg-[#13151f]">
        <div class="px-3 py-2 border-b border-[#2e3250] text-[10px] text-slate-500 font-medium uppercase tracking-wider shrink-0">
          {{ activeSite ? activeSite : 'Select a site' }}
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="loadingFiles" class="flex items-center justify-center py-10">
            <span class="w-4 h-4 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
          </div>
          <div v-else-if="!activeSite" class="flex flex-col items-center justify-center py-10 gap-2 text-slate-600 px-3 text-center">
            <p class="text-2xl">👈</p>
            <p class="text-[10px]">Select a site</p>
          </div>
          <div v-else-if="!siteFiles.length && !loadingFiles" class="p-3 text-[10px] text-slate-600 text-center">
            No variants found
          </div>
          <button
            v-else v-for="f in siteFiles" :key="f.file"
            @click="selectFile(f.file)"
            :class="['w-full text-left px-3 py-2 text-xs transition-colors border-b border-[#2e3250]/20 flex items-center justify-between gap-2',
              activeFile === f.file ? 'bg-indigo-500/20 text-indigo-300 font-medium' : 'text-slate-400 hover:bg-[#22263a] hover:text-slate-200']"
          >
            <span class="truncate">{{ f.file.replace(/^.*?_/, '').replace('.channels.xml', '') || f.file }}</span>
            <span class="text-[10px] shrink-0" :class="activeFile === f.file ? 'text-indigo-400' : 'text-slate-600'">{{ f.count }}</span>
          </button>
        </div>
      </div>

      <!-- Col 3: Channels for selected file -->
      <div class="flex-1 flex flex-col border-r border-[#2e3250] overflow-hidden min-w-0">

        <!-- Global search toolbar -->
        <div class="flex items-center gap-2 px-3 py-2 border-b border-[#2e3250] shrink-0 bg-[#13151f]">
          <div class="relative flex-1">
            <input v-model="globalSearch" @input="onGlobalSearch" placeholder="Search across all loaded sites…"
              class="w-full bg-[#22263a] border border-[#2e3250] rounded-lg pl-7 pr-3 py-1.5 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500" />
            <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-[10px] pointer-events-none">🌐</span>
            <span v-if="searchingGlobal" class="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
          </div>
        </div>

        <div class="flex items-center gap-2 px-3 py-2 border-b border-[#2e3250] shrink-0">
          <div class="relative flex-1">
            <input v-model="chanSearch" placeholder="Filter channels…"
              class="w-full bg-[#22263a] border border-[#2e3250] rounded-lg pl-7 pr-3 py-1.5 text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500" />
            <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-[10px] pointer-events-none">🔍</span>
          </div>
          <button @click="selectAll" class="px-2.5 py-1.5 text-[10px] bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 transition-colors shrink-0">All</button>
          <button @click="selectNone" class="px-2.5 py-1.5 text-[10px] bg-[#22263a] border border-[#2e3250] rounded-lg hover:border-indigo-400 text-slate-300 transition-colors shrink-0">None</button>
        </div>

        <!-- Channel rows -->
        <div class="flex-1 overflow-y-auto">

          <!-- Global search results -->
          <template v-if="globalSearch.trim()">
            <div class="px-3 py-1.5 text-[10px] text-slate-500 bg-[#13151f] border-b border-[#2e3250] sticky top-0">
              {{ globalResults.length }} results across loaded sites
            </div>
            <div v-if="!globalResults.length && !searchingGlobal" class="flex flex-col items-center justify-center py-12 text-slate-500 gap-2">
              <span class="text-3xl">🔍</span>
              <p class="text-xs">No results — select a site first to load its channels</p>
            </div>
            <div
              v-for="ch in globalResults" :key="ch.site + '::' + ch.site_id"
              @click="toggleChannelFull(ch)"
              :class="['flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors border-b border-[#2e3250]/30 text-xs',
                isSelected(ch) ? 'bg-indigo-500/10 text-indigo-300' : 'hover:bg-[#22263a] text-slate-300']"
            >
              <input type="checkbox" :checked="isSelected(ch)" @click.stop="toggleChannelFull(ch)" class="accent-indigo-500 cursor-pointer shrink-0" />
              <span class="flex-1 truncate font-medium">{{ ch.name }}</span>
              <span class="text-slate-600 shrink-0 font-mono">{{ ch.site }}</span>
              <span class="text-slate-600 shrink-0 font-mono">{{ ch.xmltv_id }}</span>
            </div>
          </template>

          <!-- Site channels -->
          <template v-else>
            <div v-if="!activeSite" class="flex flex-col items-center justify-center py-16 text-slate-500 gap-2">
              <span class="text-4xl">👈</span>
              <p class="text-sm">Select a site</p>
              <p class="text-xs text-slate-600">{{ sites.length.toLocaleString() }} sites available</p>
            </div>
            <div v-else-if="activeSite && !activeFile && !loadingFiles" class="flex flex-col items-center justify-center py-16 text-slate-500 gap-2">
              <span class="text-4xl">👈</span>
              <p class="text-sm">Select a country / variant</p>
              <p class="text-xs text-slate-600">{{ siteFiles.length }} variant{{ siteFiles.length !== 1 ? 's' : '' }} for {{ activeSite }}</p>
            </div>
            <div v-else-if="loadingChans" class="flex items-center justify-center py-10 gap-2 text-slate-500">
              <span class="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></span>
              <p class="text-xs">Loading channels…</p>
            </div>
            <template v-else>
              <div class="px-3 py-1.5 text-[10px] text-slate-500 bg-[#13151f] border-b border-[#2e3250] sticky top-0 flex items-center gap-2">
                <span class="flex-1 truncate">
                  {{ filteredSiteChannels.length.toLocaleString() }} channels
                  <span class="text-slate-600">· {{ activeSite }}{{ activeFile ? ' / ' + activeFile.replace('.channels.xml', '') : '' }}</span>
                </span>
                <a :href="`https://github.com/iptv-org/epg/tree/master/sites/${activeSite}`" target="_blank"
                  class="text-indigo-400 hover:text-indigo-300 transition-colors shrink-0">↗ GitHub</a>
              </div>
              <div
                v-for="ch in filteredSiteChannels" :key="ch.site_id"
                @click="toggleChannelFull(ch)"
                :class="['flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors border-b border-[#2e3250]/30 text-xs',
                  isSelected(ch) ? 'bg-indigo-500/10 text-indigo-300' : 'hover:bg-[#22263a] text-slate-300']"
              >
                <input type="checkbox" :checked="isSelected(ch)" @click.stop="toggleChannelFull(ch)" class="accent-indigo-500 cursor-pointer shrink-0" />
                <span class="flex-1 truncate font-medium">{{ ch.name }}</span>
                <span class="text-slate-600 shrink-0 font-mono text-[10px]">{{ ch.xmltv_id || ch.site_id }}</span>
                <span class="text-slate-700 shrink-0 font-mono text-[10px] uppercase">{{ ch.lang }}</span>
              </div>
            </template>
          </template>
        </div>

        <!-- Footer -->
        <div class="px-3 py-1.5 border-t border-[#2e3250] text-[10px] text-slate-600 shrink-0">
          {{ filteredSiteChannels.length.toLocaleString() }} channels shown
        </div>
      </div>

      <!-- Col 3: Selected channels (channels.xml preview) -->
      <div class="w-72 shrink-0 flex flex-col bg-[#13151f]">
        <div class="flex items-center gap-2 px-3 py-2.5 border-b border-[#2e3250] shrink-0">
          <span class="text-xs font-semibold text-slate-200 flex-1">Selected Channels</span>
          <span class="text-xs font-bold bg-indigo-500 text-white px-2 py-0.5 rounded-full">{{ selectedChannels.length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto">
          <div v-if="!selectedChannels.length" class="flex flex-col items-center justify-center py-16 text-slate-600 gap-2 px-4 text-center">
            <span class="text-3xl">📋</span>
            <p class="text-xs">No channels selected yet</p>
            <p class="text-[10px]">Check channels from any site to add them here</p>
          </div>
          <div
            v-for="ch in selectedChannels" :key="selKey(ch)"
            class="flex items-center gap-2 px-3 py-2 border-b border-[#2e3250]/30 group"
          >
            <div class="flex-1 min-w-0">
              <p class="text-xs font-medium text-slate-200 truncate">{{ ch.name }}</p>
              <p class="text-[10px] text-slate-600 font-mono truncate">{{ ch.site }}</p>
            </div>
            <button @click="removeFromSelected(ch)"
              class="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all text-xs shrink-0">✕</button>
          </div>
        </div>
        <div class="px-3 py-2 border-t border-[#2e3250] shrink-0">
          <button v-if="selectedChannels.length" @click="selectedChannels = []"
            class="w-full py-1.5 text-[10px] text-slate-500 hover:text-red-400 transition-colors">
            Clear all
          </button>
        </div>
      </div>
    </div>

    <!-- ── RAW XML TAB ──────────────────────────────────────────────────────── -->
    <div v-else class="flex-1 flex flex-col overflow-hidden p-4 gap-3">
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-xs text-slate-500 font-mono flex-1 truncate">{{ xmlPath }}</span>
        <span class="text-xs text-slate-600">Edit directly — will be saved as-is</span>
      </div>
      <textarea
        v-model="channelsXml"
        spellcheck="false"
        placeholder='<?xml version="1.0" encoding="UTF-8"?>&#10;<channels>&#10;  <channel site="dstv.com" site_id="194" lang="en" xmltv_id="SuperSport1.dstv">SuperSport 1</channel>&#10;</channels>'
        class="flex-1 bg-[#1a1d27] border border-[#2e3250] rounded-2xl px-4 py-3 text-xs font-mono text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500 resize-none leading-relaxed"
      ></textarea>
    </div>

  </div>
</template>
