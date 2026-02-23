<script setup>
import { ref } from 'vue'
import { login } from '../composables/useAdmin.js'

const password = ref('')
const error    = ref('')
const loading  = ref(false)

async function submit() {
  if (!password.value) return
  loading.value = true
  error.value   = ''
  try {
    await login(password.value)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen bg-[#0f1117] flex items-center justify-center p-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <img src="/logo.svg" alt="M3u4Prox" class="w-16 h-16 mx-auto mb-4" />
        <h1 class="text-xl font-bold text-slate-100">M3u4Prox</h1>
        <p class="text-sm text-slate-500 mt-1">Enter admin password to continue</p>
      </div>

      <form @submit.prevent="submit" class="bg-[#1a1d27] border border-[#2e3250] rounded-2xl p-6 space-y-4">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">Admin Password</label>
          <input
            v-model="password"
            type="password"
            placeholder="Password"
            autofocus
            class="w-full bg-[#22263a] border border-[#2e3250] rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <p v-if="error" class="text-xs text-red-400">⚠ {{ error }}</p>
        <button
          type="submit"
          :disabled="loading || !password"
          class="w-full py-2.5 text-sm bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 text-white font-semibold rounded-xl transition-colors"
        >
          {{ loading ? 'Signing in…' : 'Sign In' }}
        </button>
        <p class="text-[10px] text-slate-600 text-center">
          Set <code class="text-slate-500">ADMIN_PASSWORD</code> in your <code class="text-slate-500">.env</code> file
        </p>
      </form>
    </div>
  </div>
</template>
