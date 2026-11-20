#!/usr/bin/env node
/**
 * Collect npm download stats for every package maintained by @mrfentmen and
 * emit a static JSON payload + per-package SVG badges for a GitHub Pages
 * dashboard. Writes partial snapshots every 100 packages so the site can be
 * watched live while the collector runs.
 *
 * Verified empirically 2026-11-20:
 *  - api.npmjs.org bulk accepts comma-separated packages and explicit date
 *    ranges, caps each query at 365 days, and rejects scoped names.
 *  - so: unscoped packages use ~12 yearly bulk windows for all-time + one
 *    365-day daily range (52 weekly buckets + monthly + weekly + sparkline);
 *    scoped packages use paced single-package requests with checkpoints.
 *
 * Run: node collect.mjs          (resumes from state.json if interrupted)
 * Out: public/data.json, public/status.json, public/badges/*.svg
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const USER = 'mrfentmen'
const SEARCH = `https://registry.npmjs.org/-/v1/search?text=maintainer%3A${USER}`
const DL = 'https://api.npmjs.org/downloads'
const CHUNK = 128
const ROOT = process.cwd()
const STATE = join(ROOT, 'state.json')
const PUBLIC = join(ROOT, 'public')
const OUT = join(PUBLIC, 'data.json')
const STATUS = join(PUBLIC, 'status.json')
const BADGE_DIR = join(PUBLIC, 'badges')
mkdirSync(PUBLIC, { recursive: true })

const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const shift = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10)
const historyStart = shift(end, 364) // 365 days inclusive -> 52 weekly buckets
const weekStart = shift(end, 6)
const ALL_START = '2015-01-01'
const startedAt = Date.now()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Retry 429/5xx with exponential backoff; a single 429 is not fatal. */
async function get(url, tries = 9) {
  for (let i = 0; i < tries; i++) {
    let res
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'npm-tracker/1.0 (local analysis)' } })
    } catch {
      await sleep(2000)
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * Math.pow(2, Math.min(i, 4)))
      continue
    }
    return res
  }
  throw new Error('HTTP retries exhausted: ' + url)
}

let nextBulk = Date.now()
let nextSingle = Date.now()
async function bulkPace() {
  const now = Date.now()
  if (now < nextBulk) { const w = nextBulk - now; nextBulk += 300; return sleep(w) }
  nextBulk = now + 300
}
async function singlePace() {
  const now = Date.now()
  if (now < nextSingle) { const w = nextSingle - now; nextSingle += 500; return sleep(w) }
  nextSingle = now + 500
}

/** Split [start,end] into windows of at most 365 days (bulk API hard limit). */
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

/** 365 daily points -> 52 buckets of 7 days, oldest first. */
function weeklyHistory(days) {
  const arr = (days || []).map((d) => ({ day: d.day, n: d.downloads || 0 }))
  const out = []
  for (let i = arr.length - 1; i >= 0; i -= 7) {
    let sum = 0
    for (let j = Math.max(0, i - 6); j <= i; j++) sum += arr[j].n
    out.push({ start: arr[Math.max(0, i - 6)].day, end: arr[i].day, downloads: sum })
  }
  return out.reverse()
}

/* ---------------- state (resumable) ---------------- */
let state = { end, bulkDone: false, bulkYears: [], pkgs: {} }
if (existsSync(STATE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE, 'utf8'))
    if (saved.end === end) state = saved
    else console.log(`[state] old window ${saved.end} -> starting fresh for ${end}`)
  } catch { /* corrupt state: start fresh */ }
}
const rec = (name) => (state.pkgs[name] ||= { allTime: 0, monthly: 0, weekly: 0, daily: [], history: [], errors: 0 })
const saveState = () => writeFileSync(STATE, JSON.stringify(state))

function applyDaily(name, days) {
  const r = rec(name)
  r.daily = (days || []).slice(-31).map((d) => d.downloads || 0)
  r.history = weeklyHistory(days)
  r.monthly = r.daily.reduce((a, b) => a + b, 0)
  r.weekly = r.history.length ? r.history[r.history.length - 1].downloads : 0
}

/* ---------------- live snapshot publisher ---------------- */
let allNames = [], info = new Map(), pendingTotal = 0
function writeStatus(phase, checked, total) {
  writeFileSync(STATUS, JSON.stringify({
    phase, checked, total,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    generated: new Date().toISOString(),
    window: { start: historyStart, end, weekStart },
  }))
}

/** Publish whatever has been collected so far. Badges only at the end. */
function emitData(phase, checked, total, withBadges = false) {
  const packages = allNames.map((name) => {
    const r = rec(name)
    const m = info.get(name) || {}
    return {
      name,
      description: m.description || '',
      published: m.published || '',
      version: m.version || '',
      allTime: r.allTime,
      monthly: r.monthly,
      weekly: r.weekly,
      daily: r.daily,
      history: r.history,
      badge: badgeFile(name),
      mcp: name.includes('mcp'),
      unindexed: !!r.notFound,
      errors: r.errors,
    }
  })
  const sum = (field, arr) => arr.reduce((a, p) => a + p[field], 0)
  const mcpPkgs = packages.filter((p) => p.mcp)
  const totals = {
    packages: packages.length,
    weekly: sum('weekly', packages),
    monthly: sum('monthly', packages),
    allTime: sum('allTime', packages),
    mcp: {
      packages: mcpPkgs.length,
      weekly: sum('weekly', mcpPkgs),
      monthly: sum('monthly', mcpPkgs),
      allTime: sum('allTime', mcpPkgs),
    },
  }
  const historyMap = new Map()
  for (const p of packages) {
    for (const b of p.history) historyMap.set(b.start, (historyMap.get(b.start) || 0) + b.downloads)
  }
  const aggregateHistory = [...historyMap.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([start, downloads]) => ({ start, downloads }))
  writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    window: { start: historyStart, end, weekStart },
    totals, aggregateHistory, packages,
  }))
  writeStatus(phase, checked, total)
  if (withBadges) {
    mkdirSync(BADGE_DIR, { recursive: true })
    for (const p of packages) {
      const v = p.weekly.toLocaleString('en-US')
      const color = p.weekly >= 500 ? '#2ea043' : p.weekly >= 100 ? '#1f6feb' : p.weekly >= 10 ? '#8957e5' : '#57606a'
      const vw = Math.max(44, v.length * 9 + 12)
      const w = 92 + vw
      writeFileSync(join(BADGE_DIR, p.badge), `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="weekly downloads: ${v}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath>
<g clip-path="url(#r)"><rect width="92" height="20" fill="#555"/><rect x="92" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="46" y="14">weekly dl</text><text x="${92 + vw / 2}" y="14">${v}</text></g>
</svg>\n`)
    }
  }
  return totals
}

/* ---------------- step 1: package inventory ---------------- */
const names = new Set()
let from = 0
for (;;) {
  const res = await get(`${SEARCH}&size=250&from=${from}`)
  const page = await res.json()
  for (const o of page.objects || []) {
    const p = o.package
    if (!p || !p.name || names.has(p.name)) continue
    names.add(p.name)
    info.set(p.name, {
      name: p.name,
      description: (p.description || '').replace(/\s+/g, ' ').slice(0, 180),
      published: (p.date || '').slice(0, 10),
      version: p.version || '',
    })
  }
  if (!(page.objects || []).length || from + page.objects.length >= page.total) break
  from += page.objects.length
  await sleep(200)
}
allNames = [...names]
const scopedNames = allNames.filter((n) => n.startsWith('@'))
const bulkNames = allNames.filter((n) => !n.startsWith('@'))
console.log(`[1/4] ${allNames.length} packages (${bulkNames.length} bulk-able, ${scopedNames.length} scoped singles)`)
emitData('bulk', 0, bulkNames.length)

/* ---------------- step 2: bulk (unscoped) ---------------- */
const bulkChunks = chunks(bulkNames, CHUNK)
if (!state.bulkDone) {
  for (const n of bulkNames) rec(n).allTime = 0
  const yearWindows = windows(ALL_START, end)
  console.log(`[2/4] all-time: ${yearWindows.length} yearly windows x ${bulkChunks.length} chunks`)
  for (const [a, b] of yearWindows) {
    const wkey = `${a}:${b}`
    if (state.bulkYears.includes(wkey)) continue
    for (const chunk of bulkChunks) {
      await bulkPace()
      const json = await (await get(`${DL}/point/${a}:${b}/${chunk.join(',')}`)).json()
      for (const name of chunk) {
        const e = json[name]
        if (e && Number.isFinite(e.downloads)) rec(name).allTime += e.downloads
      }
    }
    state.bulkYears.push(wkey)
    saveState()
    console.log(`      ${a} -> ${b} done`)
  }
  console.log(`[2/4] ${historyStart} -> ${end} daily series (52 weekly buckets)`)
  for (const [ci, chunk] of bulkChunks.entries()) {
    await bulkPace()
    const json = await (await get(`${DL}/range/${historyStart}:${end}/${chunk.join(',')}`)).json()
    for (const name of chunk) applyDaily(name, json[name] && json[name].downloads)
    if (ci % 3 === 0) { saveState(); emitData('bulk', ci + 1, bulkChunks.length) }
  }
  state.bulkDone = true
  saveState()
  console.log(`[2/4] bulk complete — ${bulkNames.length} packages`)
} else {
  console.log('[2/4] bulk already complete in state.json — skipping')
}

/* ---------------- step 3: scoped singles ---------------- */
const pending = scopedNames.filter((n) => !rec(n).done)
pendingTotal = pending.length
console.log(`[3/4] ${pendingTotal} scoped packages to query (2 workers, 500ms pace)`)
emitData('scoped', 0, pendingTotal)
let idx = 0
let checked = 0
await Promise.all(Array.from({ length: 2 }, async () => {
  while (idx < pending.length) {
    const name = pending[idx++]
    try {
      await singlePace()
      const r1 = await get(`${DL}/point/${ALL_START}:${end}/${encodeURIComponent(name)}`)
      const j1 = await r1.json()
      if (r1.status === 404) rec(name).notFound = true
      else if (Number.isFinite(j1.downloads)) rec(name).allTime = j1.downloads
      await singlePace()
      const r2 = await get(`${DL}/range/${historyStart}:${end}/${encodeURIComponent(name)}`)
      if (r2.status === 404) rec(name).notFound = true
      else applyDaily(name, (await r2.json()).downloads)
    } catch {
      rec(name).errors++
    }
    rec(name).done = true
    if (++checked % 100 === 0) {
      saveState()
      emitData('scoped', checked, pendingTotal)
      process.stdout.write(`      …${checked}/${pendingTotal} checked\n`)
    }
  }
}))
saveState()

/* ---------------- step 4: final publish ---------------- */
const totals = emitData('done', pendingTotal, pendingTotal, true)
const fmt = (n) => n.toLocaleString('en-US')
console.log(`[4/4] wrote ${OUT} and ${allNames.length} badges`)
console.log(`  totals: ${fmt(totals.packages)} pkgs | 7d ${fmt(totals.weekly)} | 31d ${fmt(totals.monthly)} | all-time ${fmt(totals.allTime)}`)
console.log(`  unindexed: ${allNames.filter((n) => rec(n).notFound).length} | query errors: ${allNames.filter((n) => rec(n).errors > 0).length}`)
