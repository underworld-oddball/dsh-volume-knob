/**
 * sh-volume-shuff — browser half.
 *
 * Composer speaker button (right of the microphone seat):
 *
 *   click                    → read aloud from the marked start position and
 *                              scroll the page to it, with a blinking caret;
 *                              the next click stops
 *   press and hold           → wait for one click on the page: that click picks
 *                              the reading start position and reads from there
 *   press, drag up           → the volume panel
 *
 * Built for `@deepseek-ai/dsh@next` (0.1.7-rc.1): the slot registry
 * (`ctx.slots.inject` / `ctx.slots.register`), the composer tool slot
 * `conversation.input.right`, and the chat DOM markers
 * `[data-chat-flow]` / `[data-chat-flow-kind]` / `[data-chat-flow-key]` are
 * the same contract the previous 0.1.5 target used, so this half only had to
 * extend them.
 *
 * Synthesis walks two paths: `dsh-tts` (`POST /dsh-tts/speak`) when that
 * plugin answers, browser `speechSynthesis` otherwise. Both are chunked, so
 * reading can start in the middle of a reply.
 */
window.__ModuleLoader__.load({
  id: 'sh-volume-shuff',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const LS_KEY = 'sh-volume-shuff/state'
    const MEDIA_PATCH = '__shVolumeShuffMedia'
    const ROUTE = '/sh-volume-shuff/system'
    const TTS_SPEAK = '/dsh-tts/speak'
    const TTS_STATUS = '/dsh-tts/status'
    const SLOT = 'conversation.input.right' // composer tool row; the mic sits here at order 30
    const ORDER = 40 // right of the microphone button
    const LONG_PRESS_MS = 400
    const DRAG_UP_PX = 18
    /**
     * How long a pick may sit with the bubble retired and no further action
     * before it gives up on its own (松手后长时间不动 → 取消本次操作). Resets on
     * every mouse move, so exploring the page never times out.
     */
    const PICK_IDLE_CANCEL_MS = 5000
    const VERSION = '0.1.0'
    const FLOW = '[data-chat-flow]'
    const FLOW_KIND = '[data-chat-flow-kind]'
    const CURSOR_SETTLE_MS = 700
    // Every hint is bilingual: the Chinese line on top, the English line under
    // it in grey, both left-aligned as one block.
    const IDLE_TEXT = '点击朗读；上滑调音量；按住选起点'
    const IDLE_HINT = 'Tap: Speak / Swipe ↑: Volume / Hold: Pick'
    const STOP_TEXT = '点击停止'
    const STOP_HINT = 'Tap: Stop'
    /** Pick state: the double-click armed the picker and no start position is chosen yet. */
    const PICK_TEXT = '选择开始位置后点击'
    const PICK_HINT = 'After Pick → Tap'

    // ---------------------------------------------------------------------
    // State shared by the button, its popover, the caret and the reader.
    // ---------------------------------------------------------------------
    const state = {
      page: 1, // 0..1 master volume for every in-page <audio>/<video>
      pageMuted: false,
      reading: false,
      busy: false, // synthesizing the first chunk
      note: '',
      cursor: null, // { key, offset } — newest answer + offset into its text
      picking: false, // the double-click position picker is armed
      pickHint: '', // live picker hint; empty while reading / idle
      pickStage: 'idle', // idle | armed (dragged right, waiting for the click) | placed
      rect: null, // viewport rect of the caret, refreshed on scroll
      system: null, // { volume: 0..100, muted: boolean }
      systemSupported: null,
      systemReason: '',
    }
    const listeners = new Set()
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const notify = () => { for (const fn of [...listeners]) { try { fn() } catch { /* listener isolation */ } } }

    /** Tell the host what happened; the host keeps the last 60 entries. */
    function report (event, detail) {
      try {
        fetch('/sh-volume-shuff/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail: detail === undefined ? '' : String(detail) }),
          keepalive: true,
        }).catch(() => {})
      } catch { /* diagnostics never break the widget */ }
    }

    const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))
    const percent = (value) => Math.round(clamp01(value) * 100)
    const clampInt = (value, low, high) => Math.max(low, Math.min(high, Math.round(Number(value) || 0)))

    function loadState () {
      try {
        const raw = window.localStorage.getItem(LS_KEY)
        if (!raw) return
        const saved = JSON.parse(raw) || {}
        if (typeof saved.page === 'number') state.page = clamp01(saved.page)
        state.pageMuted = !!saved.pageMuted
        if (saved.cursor && typeof saved.cursor.key === 'string' && Number.isFinite(Number(saved.cursor.offset))) {
          state.cursor = { key: saved.cursor.key, offset: clampInt(saved.cursor.offset, 0, 1e6) }
        }
      } catch { /* private mode / malformed */ }
    }

    function saveState () {
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify({
          page: state.page,
          pageMuted: state.pageMuted,
          cursor: state.cursor || null,
        }))
      } catch { /* quota or private mode */ }
    }

    // ---------------------------------------------------------------------
    // In-page master volume: dsh-tts plays replies through `new Audio(blob)`
    // and notification plugins use their own elements; patching play() once
    // per document is what lets a single slider cover all of them.
    // ---------------------------------------------------------------------
    function ensureMediaPatch () {
      if (window[MEDIA_PATCH]) return
      const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype
      if (!proto || typeof proto.play !== 'function') return
      const originalPlay = proto.play
      // dsh-tts synthesizes into detached `new Audio(blob)` elements that never
      // enter the DOM, so `querySelectorAll('audio,video')` cannot see them.
      // Remember the elements we saw play: a slider drag then reaches the clip
      // that is sounding right now instead of only the next one.
      const known = new Set()
      const patch = {
        apply (el) {
          try {
            el.volume = state.pageMuted ? 0 : state.page
            if (!known.has(el)) {
              known.add(el)
              if (known.size > 12) known.delete(known.values().next().value)
            }
          } catch { /* element gone */ }
        },
        applyAll () {
          for (const el of [...known]) patch.apply(el)
          try {
            for (const el of document.querySelectorAll('audio,video')) patch.apply(el)
          } catch { /* no document */ }
        },
        /** Silence whatever is playing now (dsh-tts auto-read included). */
        pauseAll (except) {
          const targets = [...known]
          try {
            for (const el of document.querySelectorAll('audio,video')) targets.push(el)
          } catch { /* no document */ }
          for (const el of targets) {
            if (el === except) continue
            try { if (!el.paused) el.pause() } catch { /* element gone */ }
          }
        },
      }
      proto.play = function patchedPlay (...args) {
        patch.apply(this)
        return originalPlay.apply(this, args)
      }
      window[MEDIA_PATCH] = patch
      patch.applyAll()
    }

    function applyPageVolume () {
      ensureMediaPatch()
      const patch = window[MEDIA_PATCH]
      if (patch) patch.applyAll()
      if (state.pageMuted && window.speechSynthesis) {
        try { window.speechSynthesis.cancel() } catch { /* not supported */ }
      }
      notify()
    }

    // ---------------------------------------------------------------------
    // Page text: which parts of the conversation may be read, and exactly
    // where each character sits in the DOM.
    //
    // Every chat node renders as [data-chat-flow] with a
    // [data-chat-flow-kind] of 'user' | 'assistant' (and other furniture such
    // as 'command-input'). Reading runs from the marked start position to the
    // end of the newest flow node, and a caret is placed with a collapsed DOM
    // Range, so "start position" is a real character offset, not a CSS guess.
    // ---------------------------------------------------------------------

    /** Inline elements that must not start a new line while text is flattened. */
    const INLINE_TAGS = new Set([
      'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'I',
      'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
      'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
    ])
    /**
     * Interactive furniture inside a reply (copy / retry / feedback buttons,
     * token badges). Its text is not part of the spoken answer.
     */
    const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'SELECT', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE'])

    const styleOf = (node) => {
      try { return window.getComputedStyle(node) } catch { return null }
    }

    /**
     * Is this element (or an ancestor) not rendered?
     *
     * Only `display: none` (and friends) count. An off-screen or zero-size box
     * is *not* hidden: the collapsed process group is display:none while the
     * answer beside it is merely scrolled out of view, so a geometric test like
     * `offsetParent === null` would discard the very node we must read.
     */
    function isHidden (node) {
      if (!node || !node.tagName) return false
      const style = styleOf(node)
      if (!style) return false
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true
      if (style.contentVisibility === 'hidden') return true
      return false
    }

    /**
     * Walk `root` in document order, applying innerText-like block newlines.
     * Calls `visit(text, node)` per visible text node; the visitor may return
     * `false` to stop the walk.
     */
    function walkText (root, visit) {
      let stopped = false
      const step = (node) => {
        if (stopped || !node) return
        if (node.nodeType === 3) {
          if (node.nodeValue) stopped = visit(node.nodeValue, node) === false
          return
        }
        if (node.nodeType !== 1) return
        const tag = node.tagName.toUpperCase()
        if (SKIP_TAGS.has(tag) || isHidden(node) || node.getAttribute('aria-hidden') === 'true') return
        const block = !INLINE_TAGS.has(tag)
        if (block) stopped = visit('\n', null) === false
        if (stopped) return
        if (tag === 'BR') { stopped = visit('\n', null) === false; return }
        for (const child of [...node.childNodes]) {
          step(child)
          if (stopped) return
        }
        if (block) stopped = visit('\n', null) === false
      }
      step(root)
    }

    /** Collapse runs of blank lines the way innerText does. */
    function tidy (raw) {
      return String(raw || '')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
    }

    /**
     * What the real DSH chat DOM publishes on every message node. Verified
     * against dsh 0.1.7-rc.1 (values seen live: user, turn-process,
     * assistant-step, tool-call, turn-tail):
     *
     *   data-chat-flow-kind    the node kind
     *   data-chat-group-part   'reasoning' | 'response' | null
     *   data-chat-turn         the turn number
     *   data-chat-flow-key     stable per-node key
     *
     * Only 'user' and 'assistant-step' carry reader-facing text. Everything
     * else is furniture: the turn-process disclosure header ("已完成工作 用时
     * 4 秒"), the turn tail ("用量 301K tok 02:00"), and tool-call cards.
     * Reasoning steps are the model's scratchpad, not the reply, so they are
     * skipped too.
     */
    const READABLE_KINDS = new Set(['user', 'assistant-step'])
    const SEPARATOR = '\n\n'

    const kindOf = (node) => (node && node.getAttribute ? node.getAttribute('data-chat-flow-kind') : null)
    const groupPartOf = (node) => (node && node.getAttribute ? node.getAttribute('data-chat-group-part') : null)
    const turnOf = (node) => (node && node.getAttribute ? node.getAttribute('data-chat-turn') : null)

    /** Is this node part of the text a listener should hear? */
    function isReadableFlowNode (node) {
      if (!node || isHidden(node)) return false
      const kind = kindOf(node)
      if (!READABLE_KINDS.has(kind)) return false
      if (kind === 'assistant-step' && groupPartOf(node) === 'reasoning') return false
      return true
    }

    /** Sort key for assistant steps: data-chat-turn, then data-chat-step. */
    function stepOrder (node) {
      const turn = Number(node.getAttribute('data-chat-turn'))
      const step = Number(node.getAttribute('data-chat-step'))
      return [Number.isFinite(turn) ? turn : -1, Number.isFinite(step) ? step : -1]
    }

    /**
     * Every message node the shell publishes, newest last.
     *
     * `[data-chat-flow-kind]` is the precise marker: on a live page there were
     * 223 of them against only 32 `[data-chat-flow]` elements, and the two sets
     * do not overlap — `data-chat-flow` turned out to be a container marker
     * whose members carry `kind = null`. Query the kind attribute directly and
     * keep `[data-chat-flow]` only as a fallback for older shells.
     */
    function flowNodes () {
      try {
        const marked = [...document.querySelectorAll(FLOW_KIND)]
        if (marked.length) return marked
      } catch { /* no DOM */ }
      try { return [...document.querySelectorAll(FLOW)] } catch { return [] }
    }

    /**
     * Index one message node: its flattened text plus the character → DOM map.
     * Both come from one walk, so a `map` offset is an offset into `text`
     * exactly. `text` is the whole flattened node (chrome included) to keep
     * offsets stable; `readable` is what may actually be spoken.
     *
     * Entry format: [textNode, start, end] — that node's share of `text`.
     */
    function buildIndex (node) {
      const map = []
      let text = ''
      walkText(node, (chunk, textNode) => {
        if (textNode) {
          if (chunk) map.push([textNode, text.length, text.length + chunk.length])
        }
        text += chunk
        return true
      })
      if (!map.length) return { node, text: '', map: [], length: 0 }

      // `walkText` opens every block with a newline, so the raw flattening both
      // starts and ends with whitespace. Trim those *inside the text* rather
      // than trimming the string afterwards: `tidy()` used to shorten the string
      // while leaving the map's offsets untouched, which shifted every character
      // by the leading newline and pushed the caret to the end of the line.
      let from = 0
      while (from < text.length && '\n\t '.includes(text[from])) from += 1
      let to = text.length
      while (to > 0 && '\n\t '.includes(text[to - 1])) to -= 1

      for (const entry of map) {
        entry[1] -= from
        entry[2] -= from
      }
      // Clamp AFTER shifting: the first entry's start lands exactly on the first
      // visible character, and nothing may run past the end.
      const lastEnd = to - from
      for (const entry of map) {
        if (entry[1] < 0) entry[1] = 0
        if (entry[2] > lastEnd) entry[2] = lastEnd
      }
      // Whitespace-only nodes (the shell's own indentation between blocks) and
      // the block newlines that the trim removed collapse to an empty span;
      // a text node with nothing left to point at has no place in the map.
      const kept = map.filter((entry) => entry[2] > entry[1])
      const flat = text.slice(from, to)
      return { node, text: flat, map: kept, length: flat.length }
    }

    /** DOM signature: cheap to read, changes whenever the rendered text does. */
    function indexSignature (node) {
      let length = 0
      let count = 0
      const step = (child) => {
        if (child.nodeType === 3) { length += child.nodeValue ? child.nodeValue.length : 0; return }
        if (child.nodeType !== 1) return
        count += 1
        for (const grand of child.childNodes) step(grand)
      }
      for (const child of node.childNodes) step(child)
      return `${node.getAttribute('data-chat-flow-key') || ''}:${groupPartOf(node) || ''}:${count}:${length}`
    }

    const indexCache = new Map() // node → { signature, index }

    function segmentIndexOf (segment) {
      const signature = indexSignature(segment.node)
      const cached = indexCache.get(segment.node)
      if (cached && cached.signature === signature) return cached.index
      const index = Object.assign(buildIndex(segment.node), { signature })
      indexCache.set(segment.node, { signature, index })
      if (indexCache.size > 40) indexCache.delete(indexCache.keys().next().value)
      return index
    }

    /**
     * The readable segments of the conversation, in document order.
     *
     * Selection is a whitelist on purpose. The first implementation used a
     * blacklist ("skip buttons and svg") and matched `kind === 'assistant'`,
     * neither of which exists in this DOM: the reply is an `assistant-step`,
     * and the token/time footer is a `turn-tail` that sits *inside* the flow,
     * so a blacklist happily read "用量 301K tok 02:00" aloud and put the caret
     * on the timestamp.
     */
    let flowCache = null
    function readableFlow () {
      const doc = typeof window !== 'undefined' && window.document ? window.document : document
      const nodes = flowNodes()
      if (flowCache && flowCache.doc === doc
        && flowCache.nodes.length === nodes.length
        && flowCache.nodes.every((node, i) => node === nodes[i])) {
        return flowCache.flow
      }
      const out = []
      for (const node of nodes) {
        if (!isReadableFlowNode(node)) continue
        const index = buildIndex(node)
        if (!index.text) continue
        out.push({
          node,
          kind: kindOf(node),
          part: groupPartOf(node),
          turn: turnOf(node),
          key: node.getAttribute('data-chat-flow-key') || '',
          text: index.text,
        })
      }
      flowCache = { doc, nodes, flow: out }
      return out
    }

    const entryKey = (segment) => segment.key || segment.kind

    /** Newest readable user message — the default start position. */
    function newestUserSegment () {
      const flow = readableFlow()
      for (let i = flow.length - 1; i >= 0; i -= 1) {
        if (flow[i].kind === 'user') return flow[i]
      }
      return null
    }

    /**
     * The newest assistant text segment: the highest (turn, step) among
     * response-group assistant steps. Reading ends here.
     */
    function newestAnswerSegment () {
      const flow = readableFlow()
      let best = null
      let bestOrder = null
      for (const segment of flow) {
        if (segment.kind !== 'assistant-step') continue
        if (segment.part && segment.part !== 'response') continue
        const [turn, step] = stepOrder(segment.node)
        if (!best || turn > bestOrder[0] || (turn === bestOrder[0] && step >= bestOrder[1])) {
          best = segment
          bestOrder = [turn, step]
        }
      }
      if (best) return best
      // No response-group step (older shell or a collapsed answer): any answer.
      for (let i = flow.length - 1; i >= 0; i -= 1) {
        if (flow[i].kind === 'assistant-step') return flow[i]
      }
      return null
    }

    /** The segment a start position lives in: the question, else the answer. */
    function startSegment () {
      return newestUserSegment() || newestAnswerSegment()
    }

    /**
     * The reading stream: every readable segment joined by a blank line, with
     * each segment's `[start, end)` span into that stream. A caret offset is an
     * offset into this one string, so the start position, the spoken text and
     * the picker all agree.
     */
    function messageIndex () {
      const segments = readableFlow()
      let text = ''
      const spans = []
      for (const segment of segments) {
        const start = text.length
        text += segment.text
        spans.push({ segment, start, end: text.length })
        text += SEPARATOR
      }
      if (text.endsWith(SEPARATOR)) text = text.slice(0, -SEPARATOR.length)
      return { text, spans }
    }

    /** Map a stream offset to its segment and the offset inside that segment. */
    function locateOffset (stream, offset) {
      if (!stream.spans.length) return null
      const point = clampInt(offset, 0, stream.text.length)
      let candidate = stream.spans[0]
      for (const span of stream.spans) {
        if (point >= span.start) candidate = span
        else break
      }
      const local = clampInt(point - candidate.start, 0, candidate.end - candidate.start)
      return { segment: candidate.segment, span: candidate, local, point }
    }

    function spanOfSegment (stream, segment) {
      for (const span of stream.spans) {
        if (span.segment === segment) return span
      }
      return null
    }

    /**
     * The default start position: the first character of the newest question,
     * which is also where a brand new turn begins.
     */
    function defaultStartOffset (stream) {
      const segment = startSegment()
      if (!segment) return 0
      const span = spanOfSegment(stream, segment)
      return span ? span.start : 0
    }

    /**
     * Find the text-node map entry for a flat-text offset and clamp the offset
     * into it. Offsets can fall in the gap left by flattened inter-node
     * whitespace, in which case they snap to the nearest node's edge.
     */
    function lookup (index, offset) {
      if (!index || !index.map.length) return null
      const point = clampInt(offset, 0, index.length)
      let chosen = null
      let local = point
      for (const entry of index.map) {
        if (point >= entry[1] && point <= entry[2]) {
          if (point < entry[2]) return { entry, local: point - entry[1] }
          chosen = entry
          local = entry[2] - entry[1]
        } else if (point < entry[1]) {
          if (!chosen) {
            chosen = entry
            local = 0
          }
          break
        }
      }
      if (chosen) return { entry: chosen, local }
      return { entry: index.map[index.map.length - 1], local: index.map[index.map.length - 1][2] - index.map[index.map.length - 1][1] }
    }

    function entryRange (entry, offset) {
      if (!entry) return null
      const [node] = entry
      const local = clampInt(offset - entry[1], 0, node.nodeValue ? node.nodeValue.length : 0)
      const range = document.createRange()
      try {
        range.setStart(node, local)
        range.setEnd(node, local)
      } catch { return null }
      return range
    }

    function firstRect (range) {
      if (!range) return null
      try {
        const rects = range.getClientRects()
        for (const rect of rects) {
          if (rect && (rect.width || rect.height)) return rect
        }
        const rect = range.getBoundingClientRect()
        if (rect && (rect.width || rect.height)) return rect
      } catch { /* range collapsed in a detached node */ }
      return null
    }

    /**
     * Viewport rect for a caret at `localOffset` inside one segment. `node` is
     * the segment's element.
     */
    function rectInSegment (segment, localOffset) {
      const index = segmentIndexOf(segment)
      const found = lookup(index, localOffset)
      if (!found) return null
      const { entry, local } = found
      let rect = firstRect(entryRange(entry, entry[1] + local))
      // A caret at the very end of a text node has no rect of its own in some
      // engines; the preceding character's right edge is the same place.
      if (!rect) {
        if (local > 0) rect = firstRect(entryRange(entry, entry[1] + local - 1))
        if (!rect && local < entry[2] - entry[1]) rect = firstRect(entryRange(entry, entry[1] + local + 1))
      }
      if (!rect) return null
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height || rect.width || 18,
      }
    }

    /** Viewport rect for a caret at a stream offset. */
    function rectAtOffset (stream, offset) {
      const hit = locateOffset(stream, offset)
      if (!hit) return null
      return rectInSegment(hit.segment, hit.local)
    }

    /** Scroll the start position into the middle of its scrolling container. */
    function scrollToRect (rect) {
      if (!rect) return
      try {
        const anchor = (startSegment() || {}).node || null
        const scroller = scrollParentOf(anchor)
        if (!scroller) return
        const box = typeof scroller.getBoundingClientRect === 'function'
          ? scroller.getBoundingClientRect()
          : { top: 0, height: window.innerHeight }
        const height = box.height || window.innerHeight
        const top = box.top || 0
        const delta = (rect.top - top) - height * 0.38
        if (Math.abs(delta) < 8) return
        if (typeof scroller.scrollBy === 'function') scroller.scrollBy({ top: delta, behavior: 'smooth' })
        else scroller.scrollTop += delta
      } catch { /* no scrolling needed when the rect is already gone */ }
    }

    /**
     * Turn a pointer position into a stream offset, clamped onto readable text.
     * Used by the double-click picker.
     */
    function offsetFromPoint (x, y) {
      const flow = readableFlow()
      if (!flow.length) return null
      const stream = messageIndex()

      // Which readable segment owns the point? Prefer the browser's caret
      // answer, then the geometrically nearest segment.
      let range = null
      try {
        if (typeof document.caretPositionFromPoint === 'function') {
          const pos = document.caretPositionFromPoint(x, y)
          if (pos && pos.offsetNode) {
            range = document.createRange()
            const len = pos.offsetNode.nodeValue ? pos.offsetNode.nodeValue.length : 0
            range.setStart(pos.offsetNode, Math.min(pos.offset, len))
            range.collapse(true)
          }
        } else if (typeof document.caretRangeFromPoint === 'function') {
          range = document.caretRangeFromPoint(x, y)
        }
      } catch { range = null }

      let segment = null
      if (range && range.startContainer) {
        const probe = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
        for (const candidate of flow) {
          if (candidate.node === probe || (probe && candidate.node.contains(probe))) { segment = candidate; break }
        }
      }
      if (!segment) segment = nearestSegment(x, y, flow)
      if (!segment) return null

      let local = localOffsetFromRange(range, segment)
      if (local === null) local = nearestOffsetInSegment(x, y, segment)
      if (local === null) return null

      // The caret APIs answer with the *nearest* character even when the pointer
      // is far away. Require the pointer to be near the caret it produced, so
      // hovering empty space is "no start position yet" (pick state 1) instead
      // of silently snapping to the topmost line.
      const rect = rectInSegment(segment, local)
      if (rect) {
        const gapX = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0)
        const gapY = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0)
        const tolerance = Math.max(28, (rect.height || 18) * 2.2)
        if (Math.hypot(gapX, gapY) > tolerance) return null
      }

      const span = spanOfSegment(stream, segment)
      if (!span) return null
      return clampInt(span.start + local, 0, stream.text.length)
    }

    function localOffsetFromRange (range, segment) {
      if (!range || !range.startContainer) return null
      const container = range.startContainer
      if (container.nodeType !== 3 || !segment.node.contains(container)) return null
      const index = segmentIndexOf(segment)
      for (const entry of index.map) {
        if (entry[0] === container) {
          const found = lookup(index, entry[1] + range.startOffset)
          return found ? found.entry[1] + found.local : null
        }
      }
      return null
    }

    function nearestSegment (x, y, flow) {
      let best = null
      let bestDistance = Infinity
      for (const segment of flow) {
        let box = null
        try { box = segment.node.getBoundingClientRect() } catch { box = null }
        if (!box || (!box.width && !box.height)) { if (!best) best = segment; continue }
        const dx = x < box.left ? box.left - x : (x > box.right ? x - box.right : 0)
        const dy = y < box.top ? box.top - y : (y > box.bottom ? y - box.bottom : 0)
        const distance = Math.hypot(dx, dy)
        if (distance < bestDistance) { bestDistance = distance; best = segment }
      }
      return best
    }

    /** Nearest character offset inside one segment for a pointer position. */
    function nearestOffsetInSegment (x, y, segment) {
      const index = segmentIndexOf(segment)
      const length = index.text.length
      if (!length) return null
      let best = 0
      let bestDistance = Infinity
      const stride = length > 4000 ? 7 : 1
      for (let i = 0; i < length; i += stride) {
        const rect = rectInSegment(segment, i)
        if (!rect) continue
        const dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0)
        const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0)
        const distance = Math.hypot(dx, dy * 1.2)
        if (distance < bestDistance) { bestDistance = distance; best = i }
        if (distance === 0) break
      }
      return best
    }

    function scrollParentOf (node) {
      let current = node ? node.parentElement : null
      while (current) {
        const style = styleOf(current)
        if (style) {
          const overflow = `${style.overflowY}`
          if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight + 4) return current
        }
        current = current.parentElement
      }
      return document.scrollingElement || document.documentElement
    }

    // ---------------------------------------------------------------------
    // The caret: a fixed 2px bar that blinks at the start position. It is
    // re-measured on scroll/resize, because a fixed bar over scrolling text
    // would otherwise drift away from its character.
    // ---------------------------------------------------------------------
    let cursorNode = null
    let cursorAnchor = null // { node, offset }

    /** What the browser says is animating on the caret right now (diagnostics). */
    function appliedAnimation () {
      try {
        const node = document.querySelector('.sh-vk-caret')
        if (!node) return 'no-node'
        const style = window.getComputedStyle(node)
        return `${style.animationName || 'none'}/${style.opacity || '?'}`
      } catch { return 'unreadable' }
    }

    const CURSOR_CSS = `
/* A soft "breathing" caret: a slim gradient bar with rounded ends, a coloured
   halo and a faint cap, pulsing gently instead of hard-blinking. */
@keyframes sh-vk-breathe { 0%, 100% { opacity: 1 } 50% { opacity: .5 } }

.sh-vk-caret {
  position: fixed; z-index: 2147483001; width: 3px; border-radius: 999px;
  background: linear-gradient(180deg, #8b9dff 0%, #6f7bff 45%, #4cc9f0 100%);
  box-shadow:
    0 0 0 1px rgba(255,255,255,.22) inset,
    0 0 10px rgba(111,123,255,.55),
    0 0 22px rgba(76,201,240,.32);
  animation: sh-vk-breathe 1.25s cubic-bezier(.45,0,.55,1) infinite;
  pointer-events: none;
  transition: left .05s linear, top .05s linear, height .12s ease, background .18s ease, box-shadow .18s ease;
}
.sh-vk-caret::before { /* a soft cap, so the caret reads as a marker */
  content: ''; position: absolute; left: 50%; top: -7px; width: 11px; height: 11px;
  transform: translateX(-50%); border-radius: 50%;
  background: inherit;
  box-shadow: 0 0 9px rgba(111,123,255,.65);
}
.sh-vk-caret[data-mode="pick"] {
  background: linear-gradient(180deg, #ffd166 0%, #f5a524 50%, #ff8a3d 100%);
  box-shadow:
    0 0 0 1px rgba(255,255,255,.24) inset,
    0 0 10px rgba(245,165,36,.6),
    0 0 22px rgba(255,138,61,.35);
}
.sh-vk-caret[data-mode="pick"]::before { box-shadow: 0 0 9px rgba(245,165,36,.7) }
/* The resting marker left behind when a reading ends or a pick is cancelled:
   same bar, same colour, no pulse and no halo shimmer. */
.sh-vk-caret[data-mode="quiet"] { animation: none; opacity: .9 }

.sh-vk-hint, .sh-vk-tip {
  position: fixed; z-index: 2147483002; max-width: min(460px, 78vw);
  padding: 11px 16px; border-radius: 12px; pointer-events: none;
  background: var(--dsw-alias-bg-layer-2, rgba(28,28,32,.98));
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.22));
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
  color: #c2410c;
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  text-align: left;
}
/* Bilingual blocks: the Chinese line on top (the colour of the hint) and the
   English caption under it in grey, both flush left so the two lines share one
   margin. The hint element itself never wraps, so each line breaks where it is
   told to. */
.sh-vk-line { display: block; white-space: nowrap }
.sh-vk-hint-en, .sh-vk-tip-en {
  display: block; margin-top: 2px; color: #9ca3af; white-space: nowrap;
  font-size: 14px; font-weight: 400;
}
.sh-vk-tip { z-index: 2147483003; display: none }
.sh-vk-hint b, .sh-vk-tip b { color: #b45309; font-weight: 700 }
`

    const cursorStyle = {
      mode: 'read', // remembered colour mode: read | pick | quiet
      blink: true, // false while resting (quiet)
      ensure () {
        if (!document.getElementById('sh-vk-style')) {
          const style = document.createElement('style')
          style.id = 'sh-vk-style'
          style.textContent = CURSOR_CSS
          document.head.append(style)
        }
        if (!cursorNode) {
          cursorNode = document.createElement('div')
          cursorNode.className = 'sh-vk-caret'
          cursorNode.setAttribute('aria-hidden', 'true')
          cursorNode.style.display = 'none'
          document.body.append(cursorNode)
        }
        return cursorNode
      },
      /**
       * Draw the caret at a character position. `mode` tints it for picking
       * ('pick') or shows the resting, non-blinking marker ('quiet'); `blink`
       * is false only for that resting state. The mode is remembered so a later
       * scroll (refreshCaret) cannot turn the resting marker back into a pulse.
       */
      show (rect, mode, blink = true) {
        const node = cursorStyle.ensure()
        cursorStyle.mode = mode || 'read'
        cursorStyle.blink = blink !== false
        if (!rect) { node.style.display = 'none'; return }
        node.dataset.mode = cursorStyle.mode
        node.style.display = 'block'
        node.style.left = `${Math.round(rect.left)}px`
        node.style.top = `${Math.round(rect.top)}px`
        node.style.height = `${Math.max(14, Math.round(rect.height || 18))}px`
      },
      hide () {
        if (cursorNode) cursorNode.style.display = 'none'
      },
      destroy () {
        if (cursorNode) { try { cursorNode.remove() } catch { /* already gone */ } }
        cursorNode = null
        const style = document.getElementById('sh-vk-style')
        if (style) { try { style.remove() } catch { /* already gone */ } }
      },
    }

    // ---------------------------------------------------------------------
    // Picker hint: one floating line above the caret while a start position is
    // being chosen. It disappears the moment reading starts.
    // ---------------------------------------------------------------------
    /**
     * The icon's hover bubble and the pick hint share one shape: the Chinese
     * line (in the hint colour) above the grey English caption, left-aligned.
     * The native `title` attribute renders a system tooltip that CSS cannot
     * reach, so it stays as the accessible label while this element does the
     * visible work.
     */
    function bilingualHtml (text, hint) {
      const en = hint ? `<span class="sh-vk-line sh-vk-hint-en">${escapeHtml(hint)}</span>` : ''
      return `<span class="sh-vk-line">${text}</span>${en}`
    }

    let tipNode = null
    function showTip (text, hint, anchor) {
      if (!tipNode) {
        tipNode = document.createElement('div')
        tipNode.className = 'sh-vk-tip'
        document.body.append(tipNode)
      }
      tipNode.innerHTML = bilingualHtml(text, hint)
      tipNode.style.display = 'block'
      const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null
      const width = tipNode.offsetWidth || 240
      const height = tipNode.offsetHeight || 34
      const anchorRect = rect || { left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight - 60, bottom: window.innerHeight - 40 }
      let left = anchorRect.left + (anchorRect.right - anchorRect.left) / 2 - width / 2
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
      let top = anchorRect.top - height - 10 // the composer sits at the bottom
      if (top < 8) top = Math.min(anchorRect.bottom + 10, window.innerHeight - height - 8)
      tipNode.style.left = `${Math.round(left)}px`
      tipNode.style.top = `${Math.round(top)}px`
    }

    function hideTip () {
      if (tipNode) tipNode.style.display = 'none'
    }

    let hintNode = null
    function showHint (text, hint, rect) {
      if (!hintNode) {
        hintNode = document.createElement('div')
        hintNode.className = 'sh-vk-hint'
        hintNode.setAttribute('role', 'status')
        document.body.append(hintNode)
      }
      hintNode.innerHTML = bilingualHtml(text, hint)
      hintNode.style.display = 'block'
      const width = hintNode.offsetWidth || 240
      const height = hintNode.offsetHeight || 32
      const anchor = rect || { left: window.innerWidth / 2, top: window.innerHeight / 2, height: 0, bottom: 0 }
      let left = anchor.left - 8
      let top = anchor.top - height - 10
      if (top < 8) top = anchor.bottom + 22
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
      hintNode.style.left = `${Math.round(left)}px`
      hintNode.style.top = `${Math.round(top)}px`
    }

    function hideHint () {
      if (hintNode) hintNode.style.display = 'none'
    }

    const escapeHtml = (value) => String(value || '')
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')

    function previewOf (text, offset) {
      const slice = String(text || '').slice(offset, offset + 34).replace(/\s+/gu, ' ')
      return escapeHtml(slice)
    }

    /**
     * The caret position the user is currently looking at, as an offset into the
     * reading stream (or null when the conversation has nothing readable).
     *
     * The saved position is validated against the *anchor* segment — the newest
     * question — so a new turn falls back to that question's first character
     * instead of dragging a stale offset into the wrong reply.
     */
    function resolveCursor () {
      const stream = messageIndex()
      if (!stream.text) return null
      const anchor = startSegment()
      const anchorSpan = anchor ? spanOfSegment(stream, anchor) : null
      const saved = state.cursor
      let offset = anchorSpan ? anchorSpan.start : 0
      if (saved && typeof saved.key === 'string' && Number.isFinite(Number(saved.offset))) {
        for (const span of stream.spans) {
          if (entryKey(span.segment) === saved.key) {
            const local = clampInt(saved.offset, 0, span.end - span.start)
            offset = span.start + local
            break
          }
        }
      }
      const hit = locateOffset(stream, offset)
      return {
        stream,
        segment: hit ? hit.segment : anchor,
        span: hit ? hit.span : anchorSpan,
        offset: hit ? hit.point : offset,
        rect: rectAtOffset(stream, hit ? hit.point : offset),
      }
    }

    /** Persist a caret position (stream offset) and draw the caret there. */
    function setCursor (offset, mode) {
      const stream = messageIndex()
      const hit = locateOffset(stream, offset)
      if (!hit) return null
      state.cursor = { key: entryKey(hit.segment), offset: hit.local }
      cursorAnchor = { segment: hit.segment, local: hit.local }
      state.rect = rectInSegment(hit.segment, hit.local)
      cursorStyle.show(state.rect, mode, mode !== 'quiet')
      saveState()
      notify()
      return state.rect
    }

    function refreshCaret () {
      if (!state.cursor && !cursorAnchor) return
      const stream = messageIndex()
      if (!stream.text) { state.rect = null; cursorStyle.hide(); return }
      let segment = null
      let local = 0
      if (cursorAnchor && cursorAnchor.segment && cursorAnchor.segment.node.isConnected) {
        segment = cursorAnchor.segment
        local = cursorAnchor.local
      } else {
        const hit = locateOffset(stream, defaultStartOffset(stream))
        if (hit) { segment = hit.segment; local = hit.local }
      }
      if (!segment) { state.rect = null; cursorStyle.hide(); return }
      cursorAnchor = { segment, local }
      state.rect = rectInSegment(segment, local)
      cursorStyle.show(state.rect, state.picking ? 'pick' : cursorStyle.mode, state.picking ? true : cursorStyle.blink)
    }

    /** Move the caret to the point under the pointer (pick mode). */
    function cursorFromPoint (x, y) {
      const offset = offsetFromPoint(x, y)
      if (offset === null || offset === undefined) return null
      const stream = messageIndex()
      const hit = locateOffset(stream, offset)
      if (!hit) return null
      return { offset: hit.point, segment: hit.segment, local: hit.local, text: hit.segment.text }
    }

    // ---------------------------------------------------------------------
    // Reading the page aloud.
    // ---------------------------------------------------------------------
    const reader = { token: 0, audio: null, tts: null, media: null }

    const DROP_LINE = /^(\d+(\.\d+)?\s*(ms|s|秒)|\d+\s*(tok|tokens|字))\s*$/i
    const ACTION_LINE = new Set(['复制', '重试', '编辑', '赞', '踩', 'Copy', 'Retry', 'Edit'])

    /**
     * Speech-ready text for ONE node. Chrome lines (time badges, token counts,
     * copy/retry labels) are dropped per line so a user message that happens to
     * *start* with such a word keeps its real characters; the caller joins node
     * texts, never the other way round. Paragraph breaks survive: consecutive
     * blank lines collapse to exactly one break, not to nothing.
     */
    function speakable (raw) {
      const lines = String(raw || '').split('\n').map((line) => line.trim())
      const kept = []
      let blank = false
      for (const line of lines) {
        if (!line) { blank = true; continue }
        if (DROP_LINE.test(line) || ACTION_LINE.has(line)) continue
        if (blank && kept.length) kept.push('')
        blank = false
        kept.push(line)
      }
      return kept.join('\n').trim()
    }

    function chunkText (text, max = 220) {
      const chunks = []
      let buffer = ''
      const flush = () => { const trimmed = buffer.trim(); if (trimmed) chunks.push(trimmed); buffer = '' }
      for (const char of String(text)) {
        buffer += char
        const endsSentence = '。！？!?；;\n'.includes(char)
        if (buffer.length >= max) flush()
        else if (endsSentence && buffer.trim().length >= max * 0.6) flush()
      }
      flush()
      return chunks
    }

    /** Is `dsh-tts` installed and serving? Cached per page. */
    async function ttsAvailable () {
      if (reader.tts !== null) return reader.tts
      try {
        const res = await fetch(TTS_STATUS, { cache: 'no-store' })
        reader.tts = res.ok
        if (!res.ok) report('tts:absent', `${res.status}`)
      } catch (error) {
        reader.tts = false
        report('tts:probe-failed', String((error && error.message) || error))
      }
      return reader.tts
    }

    async function synthesize (text) {
      try {
        const res = await fetch(TTS_SPEAK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) { report('synth:http', `${res.status}`); return null }
        const data = await res.json()
        if (!data || !data.ok || !data.audioBase64) {
          report('synth:empty', JSON.stringify(data && data.error ? data.error : {}))
          return null
        }
        return { mime: data.mime || 'audio/mpeg', base64: data.audioBase64 }
      } catch (error) {
        report('synth:throw', String((error && error.message) || error))
        return null
      }
    }

    function playClip (clip, token) {
      return new Promise((resolve) => {
        if (reader.token !== token) { resolve('stopped'); return }
        const audio = new Audio(`data:${clip.mime};base64,${clip.base64}`)
        reader.audio = audio
        const done = (why) => {
          if (reader.audio === audio) reader.audio = null
          resolve(why || 'ended')
        }
        audio.onended = () => done('ended')
        audio.onerror = () => done('error')
        try { audio.volume = state.pageMuted ? 0 : state.page } catch { /* volume not settable */ }
        audio.play().then(
          () => report('play:ok', `${clip.mime} ${clip.base64.length}b vol=${audio.volume}`),
          (error) => { report('play:blocked', String((error && error.name) || error)); done('blocked') },
        )
        if (reader.token !== token) { try { audio.pause() } catch { /* not playing */ } done('stopped') }
      })
    }

    function speakInBrowser (text, token) {
      return new Promise((resolve) => {
        if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') { resolve('unsupported'); return }
        const utterance = new window.SpeechSynthesisUtterance(text)
        utterance.lang = 'zh-CN'
        const finish = (why) => resolve(why || 'ended')
        utterance.onend = () => finish('ended')
        utterance.onerror = () => finish('error')
        try { window.speechSynthesis.speak(utterance) } catch { finish('error') }
        if (reader.token !== token) { try { window.speechSynthesis.cancel() } catch { /* not supported */ } finish('stopped') }
      })
    }

    function finishReading () {
      reader.token += 1
      state.reading = false
      state.busy = false
      // 朗读自然结束：光标回到最后一次提问的位置，不再闪烁。
      focusStartQuiet()
      notify()
    }

    function stopReading () {
      reader.token += 1
      const audio = reader.audio
      reader.audio = null
      if (audio) { try { audio.pause() } catch { /* already stopped */ } }
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* not supported */ } }
      state.reading = false
      state.busy = false
      // 人为停止：光标同样回到最后一次提问的位置，静止不闪。 The crosshair, the
      // hint and any old coordinates go; the resting marker takes their place.
      cursorAnchor = null
      state.rect = null
      cursorStyle.hide()
      try { document.body.style.cursor = '' } catch { /* no body */ }
      hideHint()
      state.pickHint = ''
      focusStartQuiet()
      notify()
    }

    /**
     * Everything to read: the reading stream from the marked offset onward.
     * Reading *starts* at that character (the newest question by default) and
     * never skips back, so earlier turns stay silent. Reasoning steps and the
     * turn furniture were already excluded when the stream was built.
     */
    function readingPlan () {
      const resolved = resolveCursor()
      if (!resolved) return null
      const text = speakable(resolved.stream.text.slice(resolved.offset))
      return {
        stream: resolved.stream,
        segment: resolved.segment,
        offset: resolved.offset,
        rect: resolved.rect,
        text,
      }
    }

    /**
     * Park the caret on the newest question's first character without the
     * pulse: the resting marker left behind when a reading ends or a pick is
     * cancelled ("光标回到最后一次提问的位置，不用闪烁").
     */
    function focusStartQuiet () {
      const stream = messageIndex()
      if (!stream.text) { state.rect = null; cursorStyle.hide(); return null }
      const hit = locateOffset(stream, defaultStartOffset(stream))
      if (!hit) { state.rect = null; cursorStyle.hide(); return null }
      state.cursor = { key: entryKey(hit.segment), offset: hit.local }
      cursorAnchor = { segment: hit.segment, local: hit.local }
      state.rect = rectInSegment(hit.segment, hit.local)
      cursorStyle.show(state.rect, 'quiet', false)
      saveState()
      report('caret:rest', `${state.cursor.key}@${state.cursor.offset} rect=${state.rect ? 'yes' : 'no'} anim=${appliedAnimation()}`)
      // A streaming turn re-lays the page out for a moment: re-measure the
      // marker briefly so it lands on the question's first character, not on
      // the coordinates that character had half a second ago.
      const startedAt = Date.now()
      const settle = () => {
        if (state.picking || state.reading || state.busy) return // a new gesture owns it
        refreshCaret()
        if (Date.now() - startedAt < CURSOR_SETTLE_MS) window.setTimeout(settle, 120)
      }
      window.setTimeout(settle, 60)
      notify()
      return state.rect
    }

    /** Scroll to the start position and leave the caret blinking there. */
    function focusStartPosition (plan) {
      const rect = plan.rect || (plan.stream ? rectAtOffset(plan.stream, plan.offset) : null)
      const hit = plan.stream ? locateOffset(plan.stream, plan.offset) : null
      if (hit) cursorAnchor = { segment: hit.segment, local: hit.local }
      state.cursor = hit ? { key: entryKey(hit.segment), offset: hit.local } : state.cursor
      state.rect = rect
      cursorStyle.show(rect, 'read')
      saveState()
      scrollToRect(rect)
      // Smooth scrolling moves the rect for a few frames: re-measure briefly.
      const startedAt = Date.now()
      const settle = () => {
        if (!state.reading && Date.now() - startedAt > 200) return
        refreshCaret()
        if (Date.now() - startedAt < CURSOR_SETTLE_MS) window.setTimeout(settle, 120)
      }
      window.setTimeout(settle, 60)
    }

    async function startReading () {
      const plan = readingPlan()
      report('read:start', JSON.stringify({ offset: plan ? plan.offset : -1, length: plan ? plan.text.length : 0, page: state.page, muted: state.pageMuted }))
      if (!plan || !plan.text) {
        state.note = '页面上没有可朗读的内容'
        notify()
        return
      }
      state.note = ''
      state.pickHint = ''
      state.picking = false
      state.pickStage = 'idle'
      hideHint()
      focusStartPosition(plan)

      // dsh-tts may be auto-reading the same reply right now (speakReplies on):
      // stop it first, so pressing the button is a clean replay, not a duet.
      ensureMediaPatch()
      const mediaPatch = window[MEDIA_PATCH]
      if (mediaPatch) mediaPatch.pauseAll(null)
      if (window.speechSynthesis) { try { window.speechSynthesis.cancel() } catch { /* not supported */ } }

      const token = reader.token + 1
      reader.token = token
      state.reading = true
      state.busy = true
      notify()

      const chunks = chunkText(plan.text)
      report('read:chunks', `${chunks.length}`)
      const useTts = await ttsAvailable()
      let spoken = 0
      for (const chunk of chunks) {
        if (reader.token !== token) return
        if (useTts) {
          const clip = await synthesize(chunk)
          if (reader.token !== token) return
          if (clip) {
            state.busy = false
            notify()
            const why = await playClip(clip, token)
            if (reader.token !== token || why === 'stopped') return
            if (why === 'error' || why === 'blocked') {
              // Playback broke mid-way: browser voice picks up the remainder.
              report('read:browser-fallback', `after ${spoken} chars (${why})`)
              await speakInBrowser(chunks.slice(chunks.indexOf(chunk)).join('\n'), token)
              return
            }
            spoken += chunk.length
            continue
          }
          report('read:browser-fallback', `synthesis failed after ${spoken} chars`)
          const remaining = chunks.slice(chunks.indexOf(chunk)).join('\n')
          await speakInBrowser(remaining, token)
          return
        }
        state.busy = false
        notify()
        const why = await speakInBrowser(chunk, token)
        if (reader.token !== token || why === 'stopped') return
        if (why === 'unsupported') {
          state.note = '浏览器不支持语音朗读，且未检测到 dsh-tts'
          state.reading = false
          state.busy = false
          notify()
          return
        }
        spoken += chunk.length
      }
      if (reader.token === token) finishReading()
    }

    function toggleReading () {
      report('toggle', state.reading || state.busy ? 'stop' : 'start')
      if (state.reading || state.busy) stopReading()
      else startReading()
    }

    // ---------------------------------------------------------------------
    // System output volume: the host owns it (osascript / pactl).
    // ---------------------------------------------------------------------
    async function fetchSystem () {
      try {
        const res = await fetch(ROUTE, { cache: 'no-store' })
        const data = await res.json()
        state.systemSupported = !!data.supported
        state.systemReason = data.reason || ''
        if (data.supported) state.system = { volume: Number(data.volume), muted: !!data.muted }
      } catch (error) {
        state.systemSupported = false
        state.systemReason = String((error && error.message) || error)
      }
      notify()
    }

    async function pushSystem (patch) {
      try {
        const res = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const data = await res.json()
        state.systemSupported = !!data.supported
        if (data.supported) state.system = { volume: Number(data.volume), muted: !!data.muted }
        else state.systemReason = data.reason || (data.error && data.error.message) || ''
      } catch (error) {
        state.systemReason = String((error && error.message) || error)
      }
      notify()
    }

    // ---------------------------------------------------------------------
    // Popover: plain DOM appended to <body>, so no composer ancestor can clip
    // it. It closes on any click outside, on Escape, and on a plain click of
    // the button that opened it.
    // ---------------------------------------------------------------------
    const PANEL_WIDTH = 168
    const MUTE_BTN = 'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16));background:transparent;color:inherit;border-radius:6px;cursor:pointer;font-size:11px;padding:1px 6px'
    // Vertical mixer fader: writing-mode is the modern way, `orient` covers
    // Firefox, and the old -webkit-appearance value is left as a last resort.
    const RANGE_V = [
      'writing-mode:vertical-lr', 'direction:rtl', 'width:22px', 'height:104px', 'margin:0',
      'accent-color:var(--dsw-alias-brand-primary, #6f7bff)',
    ].join(';')
    const VALUE = 'opacity:.72;font-variant-numeric:tabular-nums;font-size:11px'

    function el (tag, props = {}, children = []) {
      const node = document.createElement(tag)
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'style') node.setAttribute('style', value)
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
        else if (value !== null && value !== undefined) node.setAttribute(key, String(value))
      }
      for (const child of children) node.append(child)
      return node
    }

    function createPanel () {
      const root = el('div', {
        style: [
          'position:fixed', 'z-index:2147483000', `width:${PANEL_WIDTH}px`, 'box-sizing:border-box',
          'padding:10px 12px 12px', 'border-radius:12px',
          'background:var(--dsw-alias-bg-layer-2, rgba(28,28,32,.98))',
          'border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.16))',
          'box-shadow:0 12px 32px rgba(0,0,0,.42)',
          'color:var(--dsw-alias-label-primary, #e8e8ea)',
          'font:12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
          'display:none',
        ].join(';'),
      })

      const pageValue = el('span', { style: VALUE })
      const pageMute = el('button', {
        class: 'vk-mute', type: 'button', style: MUTE_BTN,
        onclick: () => { state.pageMuted = !state.pageMuted; saveState(); applyPageVolume() },
      })
      const pageRange = el('input', {
        type: 'range', min: '0', max: '100', step: '1', orient: 'vertical',
        title: '页内音量：本页所有音频（含语音朗读）',
        style: RANGE_V,
        oninput: (event) => {
          state.page = clamp01(Number(event.target.value) / 100)
          if (state.page > 0) state.pageMuted = false
          saveState()
          applyPageVolume()
        },
      })

      const sysValue = el('span', { style: VALUE })
      const sysMute = el('button', {
        class: 'vk-mute', type: 'button', style: MUTE_BTN,
        onclick: () => { pushSystem({ muted: !(state.system && state.system.muted) }) },
      })
      const sysRange = el('input', {
        type: 'range', min: '0', max: '100', step: '1', orient: 'vertical',
        title: '系统音量：系统输出（macOS osascript / Linux pactl）',
        style: RANGE_V,
        oninput: (event) => { sysValue.textContent = `${event.target.value}%` },
        onchange: (event) => { pushSystem({ volume: Number(event.target.value), muted: false }) },
      })

      const fader = (label, range, valueNode, muteNode) => el('div', {
        style: 'display:flex;flex-direction:column;align-items:center;gap:6px;flex:1 1 0;min-width:0',
      }, [
        el('span', { text: label, style: 'font-weight:600;font-size:11px;white-space:nowrap' }),
        range,
        valueNode,
        muteNode,
      ])

      const mixer = el('div', {
        style: 'display:flex;align-items:flex-start;justify-content:space-around;gap:10px',
      }, [
        fader('页内音量', pageRange, pageValue, pageMute),
        fader('系统音量', sysRange, sysValue, sysMute),
      ])
      root.append(mixer)
      document.body.append(root)

      function paintMute (node, on) {
        node.textContent = on ? '已静音' : '静音'
        node.style.background = on ? '#b4453c' : 'transparent'
        node.style.borderColor = on ? '#b4453c' : 'var(--dsw-alias-border-l2, rgba(255,255,255,.16))'
        node.style.color = on ? '#fff' : 'inherit'
      }

      function render () {
        pageValue.textContent = `${percent(state.page)}%`
        paintMute(pageMute, state.pageMuted)
        if (document.activeElement !== pageRange) pageRange.value = String(percent(state.page))

        if (state.systemSupported === false) {
          sysRange.disabled = true
          sysMute.disabled = true
          sysMute.style.opacity = '.5'
          sysValue.textContent = '不可用'
          sysValue.title = state.systemReason || 'unsupported'
          return
        }
        sysRange.disabled = false
        sysMute.disabled = false
        sysMute.style.opacity = '1'
        if (state.system) {
          sysValue.textContent = state.system.muted ? '静音' : `${Math.round(state.system.volume)}%`
          sysValue.title = ''
          paintMute(sysMute, state.system.muted)
          if (document.activeElement !== sysRange && !state.system.muted) {
            sysRange.value = String(Math.round(state.system.volume))
          }
        } else {
          sysValue.textContent = '…'
        }
      }

      render()
      const unsubscribe = subscribe(render)
      fetchSystem()

      return {
        el: root,
        place (anchor) {
          if (!anchor) return
          root.style.display = 'block' // measure only once the panel has a box
          const rect = anchor.getBoundingClientRect()
          const height = root.offsetHeight || 200
          let left = rect.left + rect.width / 2 - PANEL_WIDTH / 2
          left = Math.max(8, Math.min(left, window.innerWidth - PANEL_WIDTH - 8))
          let top = rect.top - height - 8 // the composer sits at the bottom: open upward
          if (top < 8) top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8))
          root.style.left = `${Math.round(left)}px`
          root.style.top = `${Math.round(top)}px`
        },
        destroy () {
          unsubscribe()
          try { root.remove() } catch { /* already gone */ }
        },
      }
    }

    // ---------------------------------------------------------------------
    // Composer button.
    //
    //   click                    → read from the start position / stop
    //   press and hold (≥400ms)  → choose the start position
    //   press, drag up           → the volume panel
    //   click anywhere else      → hide the volume panel
    // ---------------------------------------------------------------------
    /**
     * Two states only: neutral when idle, the brand colour while reading. There
     * is deliberately no red "muted" look — the muted flag lives in
     * localStorage, so a red icon read as "the plugin is broken" and stayed
     * that way across reloads. Mute status belongs to the mixer, not the icon.
     */
    const ICON_COLOR = (reading) => (reading
      ? 'var(--dsw-alias-brand-primary, #6f7bff)'
      : 'var(--dsw-alias-label-secondary)')

    const SpeakerIcon = (reading) => {
      const children = [
        React.createElement('path', { key: 'body', d: 'M11 5 6 9H3v6h3l5 4V5z' }),
        React.createElement('path', { key: 'wave', d: 'M15.5 8.5a5 5 0 0 1 0 7' }),
        React.createElement('path', { key: 'wave2', d: 'M18.5 5.5a9 9 0 0 1 0 13' }),
      ]
      if (reading) children.push(React.createElement('path', { key: 'wave3', d: 'M21 3a13 13 0 0 1 0 18' }))
      return React.createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, children)
    }

    function VolumeButton () {
      const btnRef = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const press = React.useRef({
        active: false, startX: 0, startY: 0, moved: false, picked: false,
        longHold: false, timer: null, pointerId: null,
      })
      const hintRect = React.useRef(null)
      /** Pending "nobody is doing anything" cancel for the pick session. */
      const idleTimer = React.useRef(null)
      /**
       * Restart the idle countdown: the pick gives up on its own when nothing
       * happens for PICK_IDLE_CANCEL_MS, and every mouse move buys a full new
       * window. It starts the moment the picker is armed, so a release that is
       * followed by nothing at all still times out.
       */
      const armIdleCancel = () => {
        if (idleTimer.current) clearTimeout(idleTimer.current)
        idleTimer.current = window.setTimeout(() => {
          idleTimer.current = null
          if (state.picking && state.pickStage === 'armed') cancelPick()
        }, PICK_IDLE_CANCEL_MS)
      }
      const lastPointerAt = React.useRef(0)
      const [, force] = React.useReducer((count) => count + 1, 0)
      /** Is the pick bubble still live? (the first pointer move retires it) */
      let hintLive = false
      /** The pick bubble owns the icon's airspace; pointerenter must not undo that. */
      let tipFresh = false
      const hideHintOnMove = () => {
        hintLive = false
        hideHint()
      }

      React.useEffect(() => subscribe(force), [])

      // Panel lifetime: outside click, Escape, resize/scroll repositioning.
      React.useEffect(() => {
        if (!open) return undefined
        const panel = createPanel()
        panel.place(btnRef.current)
        const onPointerDown = (event) => {
          if (panel.el.contains(event.target)) return
          if (btnRef.current && btnRef.current.contains(event.target)) return // the button owns its own click
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        const reposition = () => panel.place(btnRef.current)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', reposition)
          window.removeEventListener('scroll', reposition, true)
          panel.destroy()
        }
      }, [open])

      /**
       * While the picker is armed the page waits for exactly one click on the
       * start position. Moving the pointer only retires the bubble; every other
       * operation — a key, a wheel turn, a drag, a context click, losing focus —
       * means "not now" and cancels the pick.
       */
      React.useEffect(() => {
        if (!state.picking) return undefined
        const ownIcon = (event) => !!(btnRef.current && event.target && btnRef.current.contains(event.target))
        const onDown = (event) => {
          if (ownIcon(event)) return // the icon owns its own press
          const button = typeof event.button === 'number' ? event.button : 0
          if (button !== 0) { cancelPick(); return } // a context click is not a pick
          // Only a press that lands on readable text counts; a click on empty
          // space is one of the "other operations", so it cancels the pick.
          if (!placePick(event.clientX, event.clientY)) cancelPick()
        }
        const onUp = () => {
          // The click that placed the caret also starts the reading, so the
          // caret is on screen before playback begins.
          if (state.pickStage === 'placed' && commitPick()) startReading()
        }
        const onKey = () => cancelPick() // Esc, typing, shortcuts: anything cancels
        const onWheel = () => cancelPick()
        const onContextMenu = () => cancelPick()
        const onMove = (event) => {
          if (event && event.buttons) { cancelPick(); return } // a drag, not a hover
          hideHintOnMove()
          armIdleCancel() // movement buys another full window
        }
        const onBlur = () => cancelPick()
        const onVisibility = () => { if (document.hidden) cancelPick() }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('pointerup', onUp, true)
        document.addEventListener('pointermove', onMove, true)
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('wheel', onWheel, { capture: true, passive: true })
        document.addEventListener('contextmenu', onContextMenu, true)
        window.addEventListener('blur', onBlur)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null }
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('pointerup', onUp, true)
          document.removeEventListener('pointermove', onMove, true)
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('wheel', onWheel, true)
          document.removeEventListener('contextmenu', onContextMenu, true)
          window.removeEventListener('blur', onBlur)
          document.removeEventListener('visibilitychange', onVisibility)
          document.removeEventListener('pointermove', hideHintOnMove, true)
        }
      }, [state.picking])

      React.useEffect(() => {
        const onScroll = () => refreshCaret()
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        refreshCaret()
        return () => {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
        }
      }, [])

      React.useEffect(() => () => {
        if (press.current.timer) clearTimeout(press.current.timer)
        hideTip()
      }, [])

      const onPointerDown = (event) => {
        // 按下了 → 悬浮提示词消失，不论这一下最后是朗读还是长按挑起点。
        hideTip()
        if (typeof event.button === 'number' && event.button !== 0) return
        hintRect.current = btnRef.current ? btnRef.current.getBoundingClientRect() : null
        const current = press.current
        current.active = true
        current.startX = event.clientX
        current.startY = event.clientY
        current.moved = false
        current.picked = false
        current.longHold = false
        current.armedOnHold = false
        current.pointerId = event.pointerId === undefined ? null : event.pointerId
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* not capturable */ }
        if (current.timer) clearTimeout(current.timer)
        // Held long enough without dragging: this press is a pick gesture. The
        // bubble only changes when the button is released (the operator asked
        // for the hold itself to stay quiet).
        current.timer = setTimeout(() => { current.longHold = true }, LONG_PRESS_MS)
      }

      /**
       * Stage 1: the icon was held down, so the picker now waits for one click
       * on the page. The "选择开始位置后点击 / After Pick → Tap" bubble
       * stays over the icon until the pointer is moved — the first move means
       * the operator is on the way to the start position, so the bubble is done
       * and the click itself must not have to dismiss it.
       */
      const armPick = (rect) => {
        const current = press.current
        if (state.picking) return
        current.picked = true
        state.picking = true
        state.pickStage = 'armed'
        report('gesture:hold', 'armed')
        cursorStyle.hide()
        state.pickHint = ''
        hintRect.current = rect || (btnRef.current ? btnRef.current.getBoundingClientRect() : null)
        hintLive = true
        showHint(PICK_TEXT, PICK_HINT, hintRect.current)
        // A still-hovering pointer would leave the idle bubble next to the pick
        // bubble; a paint later it is taken down for good (tipFresh=true keeps
        // that deferred call from ever touching a restored bubble).
        tipFresh = true
        hideTip()
        // One-shot: the next pointer movement anywhere retires the bubble (the
        // picker stays armed). This also has to run after the hold's own
        // pointermove, so it is bound on the document.
        document.addEventListener('pointermove', hideHintOnMove, { capture: true, once: true })
        armIdleCancel() // 松手后长时间不动 → 自动取消本次操作
        // The pointer is still over the icon, so the idle hover bubble would be
        // hiding exactly where the pick bubble sits: take it down now and again
        // after the next paint, in case the browser re-fires pointerenter.
        hideTip()
        window.setTimeout(() => { if (state.picking && !tipFresh) hideTip() }, 0)
        document.body.style.cursor = 'crosshair'
        notify()
      }

      /**
       * Stage 2: the user clicked a spot on the page — put the caret on the
       * nearest readable character and let it blink there. Nothing is read yet;
       * the following pointer release starts the reading.
       */
      const placePick = (x, y) => {
        const hit = cursorFromPoint(x, y)
        if (!hit) return false
        setCursor(hit.offset, 'read')
        state.pickStage = 'placed'
        state.pickHint = ''
        report('gesture:place', `offset=${hit.offset}`)
        notify()
        return true
      }

      /**
       * Abandon an armed picker without reading: Esc, a key, a wheel, a drag, a
       * context click, a blur — or a click that lands on empty space. The
       * blinking caret it was working with goes with it.
       */
      const cancelPick = () => {
        const current = press.current
        current.picked = false
        document.body.style.cursor = ''
        state.picking = false
        state.pickStage = 'idle'
        hintRect.current = null
        hintLive = false
        hideHint()
        state.pickHint = ''
        // 人为取消：光标回到最后一次提问的位置，不再闪烁。 Both the stored
        // position and the live anchor are replaced, or refreshCaret would draw
        // the old spot again.
        state.cursor = null
        cursorAnchor = null
        state.rect = null
        cursorStyle.hide()
        focusStartQuiet()
        notify()
      }

      /** Stage 3: the pointer was released, so start reading where the caret is. */
      const commitPick = () => {
        const current = press.current
        if (!current.picked) return false
        current.picked = false
        state.picking = false
        const stage = state.pickStage
        state.pickStage = 'idle'
        document.body.style.cursor = ''
        hintRect.current = null
        hintLive = false
        hideHint() // only a picker that is still armed can own the bubble
        state.pickHint = ''
        report('gesture:pick-commit', stage)
        refreshCaret()
        notify()
        return true
      }

      const onPointerMove = (event) => {
        const current = press.current
        if (!current.active) return
        const dx = event.clientX - current.startX
        const dy = event.clientY - current.startY
        if (dy <= -DRAG_UP_PX && Math.abs(dy) > Math.abs(dx)) {
          current.moved = true
          if (!open) setOpen(true) // 按住上滑 → 调出音量控制
        }
      }

      const endPress = () => {
        const current = press.current
        if (current.timer) { clearTimeout(current.timer); current.timer = null }
        current.active = false
        return current
      }

      const onPointerUp = (event) => {
        const current = press.current
        lastPointerAt.current = Date.now()
        if (!current.active) return
        const picked = current.picked
        const armedOnHold = !!current.armedOnHold
        const { moved, longHold } = endPress()
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* not captured */ }
        report('gesture:up', `moved=${moved} picked=${picked} armedOnHold=${armedOnHold} longHold=${longHold} open=${open}`)
        if (moved) return // the drag already opened the panel; no reading
        if (open) { setOpen(false); return } // panel open: a plain click just hides it
        if (longHold) {
          // 长按后松手 → 图标上方悬浮提示词变为「选择开始位置后点击」
          if (!state.picking) armPick(hintRect.current)
          return
        }
        if (state.picking) return // the picker owns the next click, not the icon
        toggleReading()
      }

      const onPointerCancel = () => {
        const current = press.current
        current.armedOnHold = false
        if (current.picked) cancelPick()
        endPress()
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleReading(); return }
        if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); setOpen((value) => !value); return }
        if (!state.cursor) return
        if (event.key === 'Escape' && state.picking) {
          event.preventDefault()
          cancelPick()
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const resolved = resolveCursor()
          if (!resolved) return
          event.preventDefault()
          const step = event.shiftKey ? 20 : 1
          const next = clampInt(resolved.offset + (event.key === 'ArrowRight' ? step : -step), 0, resolved.stream.text.length)
          setCursor(next, state.picking ? 'pick' : 'read')
        }
      }

      /**
       * The hover bubble, as a bilingual pair: the Chinese line plus the grey
       * English caption. A live note ("页面上没有可朗读的内容") replaces the idle
       * wording on its own, since it is not part of the fixed three-gesture text.
       */
      const hintText = () => {
        if (state.reading || state.busy) return { text: STOP_TEXT, hint: STOP_HINT }
        if (state.note) return { text: state.note, hint: '' }
        return { text: IDLE_TEXT, hint: IDLE_HINT }
      }

      return React.createElement('button', {
        ref: btnRef,
        type: 'button',
        // No native `title`: the system tooltip cannot be styled, so the same
        // text is shown in our own bubble with the pick hint's size and colour.
        onPointerEnter: () => {
          // While the picker is armed the pick bubble owns the space above the
          // icon: showing the idle bubble too would stack the two on top of
          // each other (they measure the same anchor).
          if (state.picking) { hideTip(); return }
          showTip(hintText().text, hintText().hint, btnRef.current)
        },
        onPointerLeave: () => hideTip(),
        'aria-label': hintText().text,
        'aria-pressed': (state.reading || state.busy) ? 'true' : 'false',
        'aria-expanded': open ? 'true' : 'false',
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onKeyDown,
        // Keyboard activation arrives here as a click with detail 0. Pointer
        // clicks are handled by pointerup; this branch only fires when pointer
        // events never arrived at all (some shells swallow them), which keeps
        // "single click reads aloud" true everywhere.
        onClick: (event) => {
          // No pointer event reached us recently: this is a keyboard/programmatic
          // activation rather than the second half of a pointer gesture.
          const keyboardish = Date.now() - lastPointerAt.current > 600
          report('click', `detail=${event.detail} afterPointer=${!keyboardish}`)
          if (event.detail === 0 || keyboardish) {
            event.preventDefault()
            if (open) { setOpen(false); return }
            toggleReading()
          }
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '32px',
          height: '32px',
          padding: '0',
          background: open ? 'var(--dsw-alias-button-tool-bar-hover, rgba(255,255,255,.08))' : 'transparent',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '8px',
          cursor: 'pointer',
          color: ICON_COLOR(state.reading || state.busy),
          flex: '0 0 auto',
          touchAction: 'none',
          userSelect: 'none',
        },
      }, SpeakerIcon(state.reading || state.busy))
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    loadState()

    function apply (ctx) {
      report('apply', `v${VERSION}`)
      ctx.effect(() => {
        ensureMediaPatch()
        cursorStyle.ensure()
        return () => { cursorStyle.destroy() }
      }, 'sh-volume-shuff: in-page media volume + caret layer')

      try {
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'sh-volume-shuff',
          order: ORDER,
        }, VolumeButton))
      } catch { /* shell without this slot: the button simply does not mount */ }
    }

    exports.apply = apply
    exports.inject = ['slots']
    // Testing seam: the jsdom harness loads the same bundle and drives these.
    exports.__internals = {
      state, reader, readingPlan, resolveCursor, chunkText, speakable,
      walkText, tidy, buildIndex, segmentIndexOf, readableFlow, messageIndex, locateOffset,
      offsetFromRangeForTest: (range, segment) => localOffsetFromRange(range, segment),
      rectInSegment, rectAtOffset, offsetFromPoint, cursorFromPoint,
      focusStartPosition, focusStartQuiet, startReading, stopReading, finishReading, toggleReading,
      isReadableFlowNode, newestAnswerSegment, newestUserSegment, defaultStartOffset,
    }
    return module.exports
  },
})
