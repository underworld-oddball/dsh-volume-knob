#!/usr/bin/env node
/**
 * Open the pull request that lists this plugin in the community catalog
 * (awesome-dsh-plugin) — the data source behind the in-app plugin market —
 * entirely through api.github.com, so it works on networks where github.com
 * is blocked.
 *
 * What it does:
 *   1. reads the entry we prepared:  catalog/<owner>__<repo>.yml
 *   2. forks awesome-dsh-plugin/awesome-dsh-plugin (or reuses your fork)
 *   3. commits that one YAML file to data/plugins/<owner>__<repo>.yml
 *   4. opens the PR against the upstream main branch
 *
 * Usage:
 *   node scripts/open-catalog-pr.mjs                 # prompts for the token
 *   node scripts/open-catalog-pr.mjs --dry-run       # local checks only
 *   node scripts/open-catalog-pr.mjs --token-file ~/.dsh/github-token
 *
 * Token: classic with `repo` + `workflow`, or fine-grained with
 *   Contents: Read and write + Pull requests: Read and write (+ Metadata: Read).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API = 'https://api.github.com'
const UPSTREAM = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const tokenFileArg = argv.includes('--token-file') ? argv[argv.indexOf('--token-file') + 1] : null

function die (message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const TOKEN_SHAPE = /^(ghp_|github_pat_|gho_|ghs_|ghu_)[A-Za-z0-9_]{20,}$/
const looksLikeToken = (v) => TOKEN_SHAPE.test(v)

function tokenFromFile (file) {
  try {
    const first = readFileSync(file, 'utf8').split('\n')[0].trim()
    return first || null
  } catch { return null }
}

function tokenFromPrompt () {
  if (!process.stdout.isTTY) return null
  try {
    const out = execFileSync('bash', ['-c', 'read -rs -p "GitHub token (输入不回显，回车确认): " t </dev/tty && printf %s "$t"'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    process.stdout.write('\n')
    return out.toString().trim() || null
  } catch { return null }
}

function resolveToken () {
  const env = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (looksLikeToken(env)) return { token: env, source: 'env' }
  for (const file of [tokenFileArg, path.join(os.homedir(), '.dsh', 'github-token'), path.join(os.homedir(), '.github-token')].filter(Boolean)) {
    const found = tokenFromFile(file)
    if (!found) continue
    if (looksLikeToken(found)) return { token: found, source: file }
    console.warn(`! ${file} 里的内容不像 GitHub token（开头 "${found.slice(0, 12)}…"），已跳过`)
  }
  const prompted = tokenFromPrompt()
  if (looksLikeToken(prompted || '')) return { token: prompted, source: 'prompt' }
  return null
}

let TOKEN = null

async function api (method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-volume-knob-catalog-pr',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ local side
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const remote = execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim()
const parsed = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote)
if (!parsed) die(`cannot parse owner/repo from origin url: ${remote}`)
const [, owner, repo] = parsed

const entryPath = path.join(repoRoot, 'catalog', `${owner}__${repo}.yml`)
if (!existsSync(entryPath)) die(`missing catalog entry: ${entryPath}`)
const entry = readFileSync(entryPath, 'utf8').trim()
const entryUrl = (/^url:\s*(\S+)/m.exec(entry) || [])[1]
console.log(`▶ source  : ${owner}/${repo}`)
console.log(`▶ entry   : catalog/${owner}__${repo}.yml`)
console.log(`▶ url     : ${entryUrl || '(missing url field!)'}`)
if (!entryUrl || !entryUrl.includes(`/${owner}/${repo}`)) die('the entry url must point at this repository')
for (const field of ['name:', 'category:', 'en:']) {
  if (!entry.includes(field)) die(`the entry is missing "${field}"`)
}
if (DRY) {
  console.log('\n✓ dry run: entry looks complete, nothing was sent\n')
  console.log(entry)
  process.exit(0)
}

const resolved = resolveToken()
if (!resolved) {
  die('no GitHub token found.\n'
    + '  • write it with:  cat > ~/.dsh/github-token   (paste, Enter, Ctrl-D)\n'
    + '  • or pass --token-file PATH / export GITHUB_TOKEN=…\n'
    + '  classic token needs `repo` + `workflow`; fine-grained needs Contents + Pull requests write.')
}
TOKEN = resolved.token
console.log(`▶ token   : ${resolved.source === 'env' ? '$GITHUB_TOKEN' : resolved.source}`)

// ----------------------------------------------------------------- remote side
const me = (await api('GET', '/user')).data
if (!me || !me.login) die('token rejected by api.github.com (401) — regenerate it and try again')
if (me.login !== owner) {
  console.warn(`! token belongs to "${me.login}" but the entry is for "${owner}" — the fork would be created elsewhere`)
}

const target = await api('GET', `/repos/${owner}/${repo}`)
if (!target.ok) die(`cannot read ${owner}/${repo} (${target.status}) — push the repository to GitHub first`)
const createdAt = new Date(target.data.created_at)
const ageHours = (Date.now() - createdAt.getTime()) / 36e5
console.log(`▶ repo    : exists, created ${createdAt.toISOString().slice(0, 16)}Z (${ageHours.toFixed(1)} h old)`)
if (ageHours < 24) {
  console.warn('! the catalog CI requires a repository at least 1 day old — submit tomorrow, or expect CI to flag it')
}
const topics = target.data.topics || []
if (!topics.includes('dsh-plugin')) console.warn('! the repository has no `dsh-plugin` topic yet (required for listing)')

console.log(`▶ forking : ${UPSTREAM.owner}/${UPSTREAM.repo}`)
const fork = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`, {})
if (!fork.ok && fork.status !== 422) die(`fork failed (${fork.status}): ${JSON.stringify(fork.data).slice(0, 300)}`)

let forkReady = false
for (let i = 0; i < 30; i += 1) {
  const probe = await api('GET', `/repos/${me.login}/${UPSTREAM.repo}`)
  if (probe.ok && probe.data.default_branch) { forkReady = true; break }
  await sleep(2000)
}
if (!forkReady) die(`fork of ${UPSTREAM.repo} is not ready after 60s — try again in a minute`)
console.log(`▶ fork    : ${me.login}/${UPSTREAM.repo} ready`)

const filePath = `data/plugins/${owner}__${repo}.yml`
const existing = await api('GET', `/repos/${me.login}/${UPSTREAM.repo}/contents/${filePath}?ref=main`)
const body = {
  message: `Add ${owner}/${repo} to the plugin list`,
  content: Buffer.from(`${entry}\n`, 'utf8').toString('base64'),
  branch: 'main',
}
if (existing.ok && existing.data && existing.data.sha) {
  body.sha = existing.data.sha
  console.log(`▶ file    : exists in the fork, updating it`)
}
const put = await api('PUT', `/repos/${me.login}/${UPSTREAM.repo}/contents/${filePath}`, body)
if (!put.ok) die(`committing the entry failed (${put.status}): ${JSON.stringify(put.data).slice(0, 300)}`)
console.log(`▶ file    : committed ${filePath}`)

const pr = await api('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
  title: `Add ${repo}`,
  head: `${me.login}:main`,
  base: 'main',
  body: [
    `Adds \`${owner}/${repo}\` to the list.`,
    '',
    `- repository: ${entryUrl}`,
    '- installs with `dsh plugin --profile web add ' + repo + '` (published on npm)',
    '- declares `dsh.bundle.patch` + `dsh.client.platform` in package.json',
    '- one file only, as the contributing guide asks',
  ].join('\n'),
  maintainer_can_modify: true,
})
if (!pr.ok) {
  if (pr.status === 422) die(`PR not created (422) — it may already exist: ${JSON.stringify(pr.data).slice(0, 300)}`)
  die(`PR failed (${pr.status}): ${JSON.stringify(pr.data).slice(0, 300)}`)
}
console.log(`\n✓ PR opened: ${pr.data.html_url}`)
console.log('  a maintainer reviews it against the source; the READMEs are regenerated after merge.')
