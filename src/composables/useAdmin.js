import { ref, computed } from 'vue'

const TOKEN_KEY = 'admin_token'
const token = ref(localStorage.getItem(TOKEN_KEY) || null)

export const isAuthenticated = computed(() => !!token.value)

export async function login(password) {
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!r.ok) {
    const d = await r.json()
    throw new Error(d.error || 'Login failed')
  }
  const { token: t } = await r.json()
  token.value = t
  localStorage.setItem(TOKEN_KEY, t)
}

export async function logout() {
  await fetch('/api/admin/logout', {
    method: 'POST',
    headers: { 'x-admin-token': token.value || '' },
  }).catch(() => {})
  token.value = null
  localStorage.removeItem(TOKEN_KEY)
}

export async function verifySession() {
  if (!token.value) return false
  try {
    const r = await fetch('/api/admin/verify', {
      headers: { 'x-admin-token': token.value },
    })
    if (!r.ok) { token.value = null; localStorage.removeItem(TOKEN_KEY); return false }
    return true
  } catch {
    return false
  }
}

export function getToken() { return token.value }
