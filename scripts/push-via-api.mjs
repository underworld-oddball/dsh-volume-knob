#!/usr/bin/env node
/**
 * Push this repository to GitHub through api.github.com.
 *
 * Why: on networks where github.com:443 is blocked (git push just times out)
 * api.github.com often still answers. This script recreates the local commit
 * history with the Git Data API — blobs, trees, commits, then the branch ref —
 * so nothing is lost and no git transport is needed.
 *
 * Usage:
 *   node scripts/push-via-api.mjs                    # owner/repo from `origin`; prompts for the token
 *   node scripts/push-via-api.mjs you/yourrepo
 *   GITHUB_TOKEN=ghp_xxx node scripts/push-via-api.mjs
 *   node scripts/push-via-api.mjs --token-file ~/.dsh/github-token
 *   node scripts/push-via-api.mjs --dry-run          # local side only, no network, no token
 *
 * The token is looked up in this order: --token-file, $GITHUB_TOKEN / $GH_TOKEN,
 * ~/.dsh/github-token, ~/.github-token, then an interactive hidden prompt.
 *
 * Token scopes: classic token needs `repo`; fine-grained needs
 *   Administration: Read and write (create the repo) + Contents: Read and write.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API = 'https://api.github.com'
const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const FORCE = argv.includes('--force')
const tokenFileArg = argv.includes('--token-file') ? argv[argv.indexOf('--token-file') + 1] : null
const slugArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--token-file')

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 })
const gitTrim = (...a) => git(...a).trim()

function die (message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

const TOKEN_SHAPE = /^(ghp_|github_pat_|gho_|ghs_|ghu_)[A-Za-z0-9_]{20,}$/
const looksLikeToken = (value) => TOKEN_SHAPE.test(value)

function tokenFromFile (file) {
  try {
    const first = readFileSync(file, 'utf8').split('\n')[0].trim()
    return first || null
  } catch { return null }
}

/** Hidden prompt on the controlling terminal — the token never reaches the shell history. */
function tokenFromPrompt () {
  if (!process.stdout.isTTY) return null
  try {
    const out = execFileSync('bash', ['-c', 'read -rs -p "GitHub token (输入不回显，回车确认): " t </dev/tty && printf %s "$t"'], {
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    process.stdout.write('\n')
    const value = out.toString().trim()
    return value || null
  } catch { return null }
}

async function resolveToken () {
  const reject = (where, value) => {
    console.warn(`! ${where} 里的内容不像 GitHub token（开头 "${value.slice(0, 12)}…"，${value.length} 字符），已跳过`)
  }
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (fromEnv) {
    if (looksLikeToken(fromEnv)) return { token: fromEnv, source: 'env' }
    reject('$GITHUB_TOKEN', fromEnv)
  }
  const files = [tokenFileArg, path.join(os.homedir(), '.dsh', 'github-token'), path.join(os.homedir(), '.github-token')].filter(Boolean)
  for (const file of files) {
    const found = tokenFromFile(file)
    if (!found) continue
    if (looksLikeToken(found)) return { token: found, source: file }
    reject(file, found)
  }
  const prompted = tokenFromPrompt()
  if (prompted) {
    if (looksLikeToken(prompted)) return { token: prompted, source: 'prompt' }
    reject('输入的内容', prompted)
  }
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
      'user-agent': 'dsh-volume-knob-push-via-api',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`.slice(0, 600))
  return data
}

// ---------------------------------------------------------------- local side
if (!DRY) {
  const resolved = await resolveToken()
  if (!resolved) {
    die('no GitHub token found.\n'
      + '  • run again and paste it at the hidden prompt, or\n'
      + '  • save it to ~/.dsh/github-token (copy the token itself — not this command!), or\n'
      + '  • export GITHUB_TOKEN=ghp_…\n'
      + '  classic token needs the `repo` scope; fine-grained needs Administration + Contents write.')
  }
  TOKEN = resolved.token
  console.log(`▶ token   : ${resolved.source === 'env' ? '$GITHUB_TOKEN' : resolved.source}`)
}

const branch = gitTrim('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') console.warn(`! current branch is "${branch}" (expected "main") — pushing it as refs/heads/${branch}`)

let owner
let repo
if (slugArg) {
  ;[owner, repo] = slugArg.split('/')
} else {
  const url = gitTrim('config', '--get', 'remote.origin.url')
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (!m) die(`cannot parse owner/repo from origin url: ${url}`)
  owner = m[1]
  repo = m[2]
}
if (!owner || !repo) die('owner/repo is required (pass it as an argument)')

const shas = gitTrim('rev-list', '--reverse', 'HEAD').split('\n').filter(Boolean)
console.log(`▶ local   : ${shas.length} commits on ${branch}`)
console.log(`▶ target  : ${owner}/${repo}`)

/** Read one commit's files out of the local object store. */
function readCommit (sha) {
  const meta = gitTrim('show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', sha).split('\x00')
  const [an, ae, ad, cn, ce, cd] = meta
  const message = meta.slice(6).join('\x00').replace(/\n+$/, '')
  const files = git('ls-tree', '-r', sha)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+)\s+blob\s+([0-9a-f]+)\t(.+)$/.exec(line)
      if (!m) return null
      const [, mode, blob, path] = m
      const content = execFileSync('git', ['cat-file', 'blob', blob], { maxBuffer: 1 << 28 })
      return { path, mode, content: content.toString('base64') }
    })
    .filter(Boolean)
  return { message, author: { name: an, email: ae, date: ad }, committer: { name: cn, email: ce, date: cd }, files }
}

const local = shas.map((sha) => ({ sha, ...readCommit(sha) }))
const totalBytes = local.reduce((n, c) => n + c.files.reduce((m, f) => m + f.content.length, 0), 0)
console.log(`▶ payload : ${local.reduce((n, c) => n + c.files.length, 0)} file blobs, ~${Math.round(totalBytes / 1024)} KiB base64`)
for (const c of local) {
  console.log(`   ${c.sha.slice(0, 7)}  ${c.files.length} files  ${c.message.split('\n')[0].slice(0, 60)}`)
}
if (DRY) {
  console.log('\n✓ dry run: local side is readable, nothing was sent\n')
  process.exit(0)
}

// --------------------------------------------------------------- remote side
const me = await api('GET', '/user')
let created = false
try {
  await api('GET', `/repos/${owner}/${repo}`)
} catch (error) {
  if (!/→ 404/.test(error.message)) throw error
  if (owner !== me.login) die(`repo ${owner}/${repo} does not exist and the token belongs to ${me.login}, so it cannot create it`)
  await api('POST', '/user/repos', {
    name: repo,
    private: false,
    description: 'Read the page aloud and control volume from the DeepSeek Harness composer.',
    has_issues: true,
  })
  created = true
  console.log(`▶ repo    : created ${owner}/${repo} (public)`)
}
if (!created) console.log(`▶ repo    : ${owner}/${repo} already exists`)

/**
 * Git ref routes. GitHub accepts both the singular and plural spelling when
 * *reading* a ref, but the write routes only exist under the plural
 * `/git/refs/`: PATCHing `/git/ref/heads/main` answers 404 while
 * `/git/refs/heads/main` answers 401 without a token, i.e. the route is real.
 * Use the plural form everywhere.
 */
const refPath = `/repos/${owner}/${repo}/git/refs/heads/${branch}`
let existingTip = null
try {
  existingTip = (await api('GET', refPath)).object.sha
} catch (error) {
  if (!/→ 404/.test(error.message)) throw error
}
if (existingTip && !FORCE) {
  const remoteCommits = await api('GET', `/repos/${owner}/${repo}/commits?per_page=100`)
  die(`refs/heads/${branch} already exists (${existingTip.slice(0, 7)}, ${remoteCommits.length} commits). `
    + 'Re-run with --force to overwrite it, or delete the branch first.')
}

// Push every local commit as a real GitHub commit so the history is preserved.
const mapping = new Map()
let parent = []
for (const commit of local) {
  const tree = []
  for (const file of commit.files) {
    const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, { content: file.content, encoding: 'base64' })
    tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha })
  }
  const treeRes = await api('POST', `/repos/${owner}/${repo}/git/trees`, { tree })
  const created2 = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: commit.message,
    tree: treeRes.sha,
    parents: parent,
    author: commit.author,
    committer: commit.committer,
  })
  mapping.set(commit.sha, created2.sha)
  parent = [created2.sha]
  console.log(`   ↑ ${commit.sha.slice(0, 7)} → ${created2.sha.slice(0, 7)}  ${commit.message.split('\n')[0].slice(0, 50)}`)
}

const tip = parent[0]
if (existingTip) {
  try {
    await api('PATCH', refPath, { sha: tip, force: true })
  } catch (error) {
    // Some deployments answer 404 on a fast-forward-less PATCH; deleting and
    // recreating the ref is the documented way to rewind a branch.
    if (!/→ (404|422)/.test(error.message)) throw error
    console.warn(`! PATCH ${refPath} → ${error.message.slice(0, 60)}; recreating the ref`)
    await api('DELETE', refPath)
    await api('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip })
  }
} else {
  await api('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip })
}
console.log(`\n✓ pushed ${local.length} commits → https://github.com/${owner}/${repo}`)
console.log(`  tip: ${tip}`)
console.log('  next: add the `dsh-plugin` topic, then configure the npm Trusted Publisher (PUBLISH.md §6)')
