#!/usr/bin/env node
/**
 * Incremental patch: fill in packages added since the last published snapshot
 * plus rows npm had not indexed yet, WITHOUT re-pulling the whole catalog.
 * Uses the exact same npm data window as the base data.json so the numbers
 * remain comparable. Resumable via patch-state.json.
 *
 * Run: node patch.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const DATA_PATH = join(ROOT, 'public', 'data.json')
const STATUS_PATH = join(ROOT, 'public', 'status.json')
const STATE_PATH = join(ROOT, 'patch-state.json')
const BADGE_DIR = join(ROOT, 'public', 'badges')
const SEARCH = 'https://registry.npmjs.org/-/v1/search?text=maintainer%3Amrfentmen'
const DL = 'https://api.npmjs.org/downloads'
const CHUNK = 128
const ALL_START = '2015-01-01'

const base = JSON.parse(readFileSync(DATA_PATH, 'utf8'))
const end = base.window.end             // same window as the published snapshot
const historyStart = base.window.start
const weekStart = base.window.weekStart
const byName = new Map(base.packages.map((p) => [p.name, { ...p }]))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function get(url, tries = 9) {
  for (let i = 0; i < tries; i++) {
    let res
    try { res = await fetch(url, { headers: { 'User-Agent': 'npm-tracker-patch/1.0' } }) }
    catch { await sleep(2000); continue }
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * Math.pow(2, Math.min(i, 4))); continue }
    return res
  }
  throw new Error('HTTP retries exhausted: ' + url)
}
const shift = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10)
function windows(start, stop) {
  const out = []
  let cur = start
  while (cur <= stop) {
    const next = shift(cur, -364) < stop ? shift(cur, -364) : stop
    out.push([cur, next])
    cur = shift(next, -1)
  }
  return out
}
const chunks = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}
const badgeFile = (name) => name.replace(/^@/, '').replace('/', '-').replace(/[^A-Za-z0-9._-]/g, '_') + '.svg'
function weeklyHistory(days) {
  const a = (days || []).map((d) => ({ day: d.day, n: d.downloads || 0 }))
  const out = []
  for (let i = a.length - 1; i >= 0; i -= 7) {
    let s = 0
    for (let j = Math.max(0, i - 6); j <= i; j++) s += a[j].n
    out.push({ start: a[Math.max(0, i - 6)].day, end: a[i].day, downloads: s })
  }
  return out.reverse()
}

/* ---------- state ---------- */
let state = { end, bulkDone: false, bulkYears: [], done: {} }
if (existsSync(STATE_PATH)) {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (s.end === end) state = s
  } catch {}
}
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state))

function apply(name, allTime, days, indexed) {
  const p = byName.get(name)
  if (!p) return
  if (allTime !== null) p.allTime = allTime
  if (days) {
    p.daily = days.slice(-31).map((d) => d.downloads || 0)
    p.history = weeklyHistory(days)
    p.monthly = p.daily.reduce((a, b) => a + b, 0)
    p.weekly = p.history.length ? p.history[p.history.length - 1].downloads : 0
    if (indexed && (p.allTime > 0 || p.monthly > 0)) p.unindexed = false
  }
}

/* ---------- inventory ---------- */
const info = new Map()
let from = 0
for (;;) {
  const page = await (await get(`${SEARCH}&size=250&from=${from}`)).json()
  for (const o of page.objects || []) {
    const p = o.package
    if (!p || !p.name) continue
    info.set(p.name, {
      name: p.name, description: (p.description || '').replace(/\s+/g, ' ').slice(0, 180),
      published: (p.date || '').slice(0, 10), version: p.version || '',
    })
  }
  if (!(page.objects || []).length || from + page.objects.length >= page.total) break
  from += page.objects.length
  await sleep(200)
}
// Merge in newly discovered packages; keep snapshot rows that vanished from search.
for (const [name, meta] of info) {
  if (!byName.has(name)) byName.set(name, {
    ...meta, allTime: 0, monthly: 0, weekly: 0, daily: [], history: [],
    badge: badgeFile(name), mcp: name.includes('mcp'), unindexed: true, errors: 0,
  })
}
const targets = [...info.keys()].filter((n) => !byName.get(n)?.allTime || byName.get(n)?.unindexed)
  .filter((n) => !state.done[n])
const scoped = targets.filter((n) => n.startsWith('@'))
const bulk = targets.filter((n) => !n.startsWith('@'))
console.log(`[1/3] ${byName.size} packages total · ${targets.length} to fill (${bulk.length} bulk, ${scoped.length} scoped)`)

/* ---------- bulk (unscoped) ---------- */
const bchunks = chunks(bulk, CHUNK)
if (!state.bulkDone) {
  for (const [a, b] of windows(ALL_START, end)) {
    const key = `${a}:${b}`
    if (state.bulkYears.includes(key)) continue
    for (const chunk of bchunks) {
      const json = await (await get(`${DL}/point/${a}:${b}/${chunk.join(',')}`)).json()
      for (const name of chunk) if (json[name] && Number.isFinite(json[name].downloads)) apply(name, (byName.get(name).allTime || 0) + json[name].downloads, null, false)
    }
    state.bulkYears.push(key); saveState()
    console.log('  year', a, 'done')
  }
  for (const chunk of bchunks) {
    const json = await (await get(`${DL}/range/${historyStart}:${end}/${chunk.join(',')}`)).json()
    for (const name of chunk) apply(name, null, json[name]?.downloads, true)
    for (const name of chunk) state.done[name] = true
    saveState()
  }
  state.bulkDone = true; saveState()
  console.log(`[2/3] bulk done — ${bulk.length} packages`)
} else console.log('[2/3] bulk already done')

/* ---------- scoped singles ---------- */
let idx = 0, checked = 0
let next = Date.now()
async function pace() {
  const now = Date.now()
  if (now < next) { const w = next - now; next += 500; return sleep(w) }
  next = now + 500
}
await Promise.all(Array.from({ length: 2 }, async () => {
  while (idx < scoped.length) {
    const name = scoped[idx++]
    try {
      await pace()
      const r1 = await get(`${DL}/point/${ALL_START}:${end}/${encodeURIComponent(name)}`)
      const j1 = await r1.json()
      await pace()
      const r2 = await get(`${DL}/range/${historyStart}:${end}/${encodeURIComponent(name)}`)
      const days = r2.status === 404 ? null : (await r2.json()).downloads
      apply(name, r1.status === 404 ? null : (Number.isFinite(j1.downloads) ? j1.downloads : null), days, true)
    } catch { /* leave as unindexed; next weekly run retries */ }
    state.done[name] = true
    if (++checked % 100 === 0) { saveState(); process.stdout.write(`  …${checked}/${scoped.length} filled\n`) }
  }
}))
saveState()

/* ---------- publish merged snapshot ---------- */
const packages = [...byName.values()]
const sum = (f, arr) => arr.reduce((a, p) => a + p[f], 0)
const mcpPkgs = packages.filter((p) => p.mcp)
const totals = {
  packages: packages.length, weekly: sum('weekly', packages), monthly: sum('monthly', packages), allTime: sum('allTime', packages),
  mcp: { packages: mcpPkgs.length, weekly: sum('weekly', mcpPkgs), monthly: sum('monthly', mcpPkgs), allTime: sum('allTime', mcpPkgs) },
}
const hm = new Map()
for (const p of packages) for (const b of p.history) hm.set(b.start, (hm.get(b.start) || 0) + b.downloads)
const aggregateHistory = [...hm.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([start, downloads]) => ({ start, downloads }))
mkdirSync(BADGE_DIR, { recursive: true })
for (const p of packages) {
  const v = p.weekly.toLocaleString('en-US')
  const color = p.weekly >= 500 ? '#2ea043' : p.weekly >= 100 ? '#1f6feb' : p.weekly >= 10 ? '#8957e5' : '#57606a'
  const vw = Math.max(44, v.length * 9 + 12), w = 92 + vw
  writeFileSync(join(BADGE_DIR, p.badge), `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="weekly downloads: ${v}"><rect width="92" height="20" fill="#555"/><rect x="92" width="${vw}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,Geneva,sans-serif" font-size="11" text-anchor="middle"><text x="46" y="14">weekly dl</text><text x="${92 + vw / 2}" y="14">${v}</text></g></svg>\n`)
}
writeFileSync(DATA_PATH, JSON.stringify({ generated: new Date().toISOString(), window: base.window, totals, aggregateHistory, packages }))
writeFileSync(STATUS_PATH, JSON.stringify({ phase: 'done', checked: targets.length, total: targets.length, elapsedSec: 0, generated: new Date().toISOString(), window: base.window }))
const fmt = (n) => n.toLocaleString('en-US')
console.log(`[3/3] merged: ${fmt(totals.packages)} pkgs | 7d ${fmt(totals.weekly)} | 31d ${fmt(totals.monthly)} | all-time ${fmt(totals.allTime)}`)
console.log(`  still unindexed: ${packages.filter((p) => p.unindexed).length}`)
