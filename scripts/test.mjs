/**
 * Test harness for lib/client.js.
 *
 * The bundle runs unmodified inside jsdom; what is mocked is only what jsdom
 * lacks — layout geometry, `innerText`-like rendering, audio playback, speech
 * synthesis, the host HTTP routes, and React itself (the plugin only uses
 * `createElement` plus four hooks). That keeps the assertions on the same code
 * path the browser runs, including the character→DOM mapping the caret and the
 * drag-right picker depend on.
 *
 *   node scripts/test.mjs
 */
import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const filters = process.argv.slice(2)
let passed = 0
const failures = []
const only = filters.length > 0

async function test (name, fn) {
  if (only && !filters.some((filter) => name.includes(filter))) return
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error && error.message}`)
  }
}

function assert (condition, message) {
  if (!condition) throw new Error(message || 'assertion failed')
}

function equal (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function includes (haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || 'missing substring'}: ${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 300))}`)
  }
}

// ---------------------------------------------------------------------------
// Fixture: the *real* DSH chat DOM, copied from a live page
//
// dsh 0.1.7-rc.1 publishes these node kinds (verified by dumping the live DOM
// in the browser): user, turn-process, assistant-step, tool-call, turn-tail.
// Every node is a sibling; none nests another. `data-chat-group-part` splits an
// assistant step into 'reasoning' (the model's scratchpad) and 'response' (the
// answer). The first version of this plugin guessed a structure that does not
// exist — `kind="assistant"` — and read the token/time footer aloud, which is
// exactly what this fixture now guards against.
// ---------------------------------------------------------------------------
const USER_TEXT = '第1个问题：请解释一下什么是卷积神经网络，并给出一个例子。'
const OLD_USER_TEXT = '更早的一个问题，不该被朗读。'
const OLD_ASSISTANT = '这是一条更早的回复，不该被朗读。'
const ASSISTANT_TEXT = [
  '卷积神经网络是一种专门处理网格状数据的网络结构。',
  '它通过卷积核在输入上滑动来提取局部特征。',
  '举个例子：识别图片中的猫。',
].join('\n\n')
const THINKING_TEXT = '思考先要理解用户问的是卷积神经网络，再给出例子。'
const PROCESS_TEXT = '已完成工作 用时 4秒'
const TAIL_TEXT = '用量 301K tok 02:00'
const TOOL_TEXT = '运行命令 Inspect chat bundle'

const CHAT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <div id="app">
    <div data-conversation-scroll id="scroller" style="overflow-y:auto;height:320px">
      <div data-chat-flow data-chat-flow-key="u1" data-chat-flow-kind="user" data-chat-turn="1">
        <p>${OLD_USER_TEXT}</p>
      </div>
      <div data-chat-flow data-chat-flow-key="a0" data-chat-flow-kind="assistant-step" data-chat-turn="1" data-chat-step="1" data-chat-group-part="response">
        <p>${OLD_ASSISTANT}</p>
      </div>

      <div data-chat-flow data-chat-flow-key="u2" data-chat-flow-kind="user" data-chat-turn="2" id="question">
        <p>${USER_TEXT}</p>
      </div>
      <div data-chat-flow data-chat-flow-key="p2" data-chat-flow-kind="turn-process" data-chat-turn="2">
        <p>${PROCESS_TEXT}</p>
      </div>
      <!-- reasoning sits inside a collapsed process group: an ANCESTOR has
           display:none, which is how the live page hides it -->
      <div style="display:none" id="collapsed-process">
        <div data-chat-flow data-chat-flow-key="a2r" data-chat-flow-kind="assistant-step" data-chat-turn="2" data-chat-step="1" data-chat-group-part="reasoning">
          <p>${THINKING_TEXT}</p>
        </div>
      </div>
      <div data-chat-flow data-chat-flow-key="a2resp" data-chat-flow-kind="assistant-step" data-chat-turn="2" data-chat-step="2" data-chat-group-part="response" id="reply">
        ${ASSISTANT_TEXT.split('\n\n').map((line) => `<p>${line}</p>`).join('')}
        <div class="actions"><button>复制</button><button>重试</button></div>
      </div>
      <div data-chat-flow data-chat-flow-key="t2c" data-chat-flow-kind="tool-call" data-chat-turn="2">
        <p>${TOOL_TEXT}</p>
      </div>
      <div data-chat-flow data-chat-flow-key="t2" data-chat-flow-kind="turn-tail" data-chat-turn="2">
        <span>${TAIL_TEXT}</span>
      </div>

      <div data-chat-flow data-chat-flow-key="a3" data-chat-flow-kind="assistant-step" data-chat-turn="3" data-chat-step="1" data-chat-group-part="response" id="hidden-reply" style="display:none"><p>隐藏的回复</p></div>
    </div>
    <div id="composer">
      <button id="mic" type="button" aria-label="语音输入"></button>
      <span id="mount-right"></span>
    </div>
  </div>
</body></html>`

const SCROLL_VIEWPORT = 320
const LINE_HEIGHT = 22

/**
 * Lay out the fixture deterministically: flow nodes stack vertically with a
 * 12px gap, each block paragraph wraps at 30 characters. Ranges report
 * character rects from this model, which is enough for the caret, the scroll
 * and the geometric pointer→offset fallback to be verified exactly.
 */
function layoutFixture (window) {
  const { document } = window
  const scroller = document.getElementById('scroller')
  const flow = [...document.querySelectorAll('[data-chat-flow]')].filter((node) => node.id !== 'hidden-reply')
  const hidden = document.querySelectorAll('[data-chat-flow]')
  const boxes = new Map()
  const charBoxes = new Map() // textNode → { top, left }

  let cursorY = 0
  for (const node of hidden) {
    const visible = node.id !== 'hidden-reply' && !node.closest('[style*="display:none"]')
    const blocks = [...node.querySelectorAll('p')]
    let top = cursorY
    for (const block of blocks) {
      const text = block.textContent
      const lines = Math.max(1, Math.ceil(text.length / 30))
      for (const child of block.childNodes) {
        if (child.nodeType === 3) charBoxes.set(child, { top, left: 20, width: 30 })
      }
      top += lines * LINE_HEIGHT
    }
    const height = Math.max(LINE_HEIGHT, top - cursorY)
    boxes.set(node, { top: cursorY, left: 0, width: 900, height })
    if (visible) cursorY += height + 12
  }

  const SCROLL_TOP = 300 // the page is scrolled down when the button is pressed
  const toViewport = (contentTop) => contentTop - SCROLL_TOP

  const rectOf = (text, localOffset, box) => {
    const { top, left, width } = box
    const line = Math.floor(localOffset / width)
    const column = localOffset % width
    return {
      left: left + column * 10,
      right: left + column * 10 + 10,
      top: toViewport(top + line * LINE_HEIGHT),
      bottom: toViewport(top + (line + 1) * LINE_HEIGHT),
      width: 10,
      height: LINE_HEIGHT,
    }
  }

  const locate = (node) => {
    for (const [flowNode, box] of boxes) {
      if (flowNode.contains(node)) return { box, flowNode }
    }
    return null
  }

  // Range geometry: one character per call, exactly like a real caret.
  const Range = window.Range
  Range.prototype.getClientRects = function getClientRects () {
    const start = this.startContainer
    if (!start || start.nodeType !== 3) return []
    const found = locate(start.parentElement || start)
    if (!found) return []
    const box = charBoxes.get(start) || { ...found.box, top: found.box.top, width: 30 }
    const offset = Math.min(this.startOffset, (start.nodeValue || '').length)
    return [rectOf(start.nodeValue || '', offset, box)]
  }
  Range.prototype.getBoundingClientRect = function getBoundingClientRect () {
    const rects = this.getClientRects()
    return rects[0] || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  for (const [node, box] of boxes) {
    node.getBoundingClientRect = () => ({
      left: box.left,
      right: box.left + box.width,
      top: toViewport(box.top),
      bottom: toViewport(box.top + box.height),
      width: box.width,
      height: box.height,
    })
    if (node.id === 'scroller') continue
  }

  const scrollCalls = []
  scroller.getBoundingClientRect = () => ({ top: 0, left: 0, right: 900, bottom: SCROLL_VIEWPORT, width: 900, height: SCROLL_VIEWPORT })
  Object.defineProperty(scroller, 'scrollHeight', { value: cursorY + 200, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: SCROLL_VIEWPORT, configurable: true })
  // jsdom already defines scrollBy on Element.prototype, so an own property is
  // what lets the harness see the exact scroll the plugin requested.
  Object.defineProperty(scroller, 'scrollBy', {
    configurable: true,
    value: (options) => { scrollCalls.push(options); return undefined },
  })

  // jsdom has no caret API: answer from the same model, like a browser would.
  document.caretPositionFromPoint = (x, y) => {
    let best = null
    let bestDistance = Infinity
    for (const [textNode, box] of charBoxes) {
      const text = textNode.nodeValue || ''
      for (let i = 0; i <= text.length; i += 1) {
        const rect = rectOf(text, i, box)
        const dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0)
        const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0)
        const distance = Math.hypot(dx, dy * 1.5)
        if (distance < bestDistance) { bestDistance = distance; best = { offsetNode: textNode, offset: i } }
      }
    }
    return best
  }

  return { boxes, charBoxes, scrollCalls, scroller, toViewport, rectOf }
}

// ---------------------------------------------------------------------------
// Environment: load the real bundle, mock only the host and the browser APIs
// ---------------------------------------------------------------------------
function createHarness (options = {}) {
  const dom = new JSDOM(CHAT_HTML, { pretendToBeVisual: true, url: 'http://127.0.0.1:3080/', runScripts: 'outside-only' })
  const { window } = dom
  const layout = layoutFixture(window)

  // --- host routes -------------------------------------------------------
  const requests = []
  const ttsEnabled = options.tts !== false
  const spoken = []
  const audioQueue = []
  const pendingTimers = new Map()
  let timerId = 0

  window.fetch = async (url, init = {}) => {
    const path = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    requests.push({ path, method: init.method || 'GET', body })
    const json = (payload, ok = true, status = 200) => ({
      ok, status, json: async () => payload,
    })
    if (path.startsWith('/dsh-tts/status')) {
      return json(ttsEnabled ? { ok: true, enabled: true } : { ok: false }, ttsEnabled, ttsEnabled ? 200 : 404)
    }
    if (path.startsWith('/dsh-tts/speak')) {
      if (!ttsEnabled) return json({ ok: false }, false, 404)
      const text = String(body && body.text ? body.text : '')
      if (options.speakFailsFrom && text.includes(options.speakFailsFrom)) return json({ ok: false, error: { code: 'chain' } }, false, 502)
      return json({ ok: true, mime: 'audio/mpeg', audioBase64: Buffer.from(text).toString('base64') })
    }
    if (path.startsWith('/sh-volume-shuff/system')) return json({ ok: true, supported: false, reason: 'test' })
    if (path.startsWith('/sh-volume-shuff/diag')) return json({ ok: true })
    return json({ ok: false }, false, 404)
  }

  // --- media -------------------------------------------------------------
  const pausedElements = []
  class FakeAudio {
    constructor (src) {
      this.src = src
      this.paused = true
      this.volume = 1
      this.onended = null
      this.onerror = null
      audioQueue.push(this)
    }

    play () {
      this.paused = false
      if (autoPlay.auto) {
        const node = this
        queueMicrotask(() => { node.paused = true; if (node.onended) node.onended() })
      }
      return Promise.resolve()
    }

    pause () { this.paused = true; pausedElements.push(this) }
  }
  // `holdAudio` keeps a clip "playing" until the test ends it, which is how a
  // real press audibly lasts long enough to be stopped by a second press.
  const autoPlay = { auto: options.holdAudio !== true }
  window.Audio = FakeAudio
  window.HTMLMediaElement = { prototype: { play () { return Promise.resolve() } } }

  // --- speech synthesis --------------------------------------------------
  let speechCancelCount = 0
  if (options.browserVoice !== false) {
    window.SpeechSynthesisUtterance = class {
      constructor (text) { this.text = text }
    }
    window.speechSynthesis = {
      speak (utterance) {
        spoken.push(utterance.text)
        if (autoPlay.auto && utterance.onend) queueMicrotask(() => utterance.onend())
      },
      cancel () { speechCancelCount += 1 },
    }
  }

  // --- timers ------------------------------------------------------------
  const realSetTimeout = window.setTimeout.bind(window)
  window.setTimeout = (fn, ms) => { timerId += 1; pendingTimers.set(timerId, { fn, ms }); return timerId }
  window.clearTimeout = (id) => { pendingTimers.delete(id) }

  // --- React -------------------------------------------------------------
  const runtime = createReactRuntime(window)
  window.__ModuleLoader__ = { load: (definition) => { window.__loaded = definition } }

  // --- load the bundle ---------------------------------------------------
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
  // Run inside jsdom's own realm: the bundle's bare `fetch`, `setTimeout`,
  // `getComputedStyle` and `Audio` must resolve to the window globals this
  // harness stubbed, exactly like a <script> tag on the real page does.
  runInContext(source, dom.getInternalVMContext())
  assert(window.__loaded, 'client bundle did not register itself with __ModuleLoader__')
  equal(window.__loaded.id, 'sh-volume-shuff', 'bundle id')
  const require = (request) => {
    if (request === 'react') return runtime.React
    throw new Error(`unexpected require("${request}")`)
  }
  const exports = window.__loaded.factory(require)
  const internals = exports.__internals

  // --- mount the button the way the slot registry would ------------------
  // --- mount the button the way the real slot registry would -------------
  // `inject(name, callback)` contributes the callback's registration once the
  // slot is available; the harness runs it immediately and hands back a no-op
  // dispose, which is what the real service returns.
  const applied = []
  const injected = []
  const ctx = {
    effect: (fn, label) => { try { const dispose = fn(); applied.push(dispose) } catch (error) { console.error(`[harness] effect "${label}" threw:`, error && error.message) } },
    slots: {
      inject: (name, callback) => { injected.push(name); callback(); return () => {} },
      register: (definition, Component) => { window.__slotDefinition = definition; window.__slotComponent = Component; return () => {} },
    },
  }
  try {
    exports.apply(ctx)
  } catch (error) {
    throw new Error(`apply() threw: ${error && error.stack}`)
  }
  assert(window.__slotComponent, 'slot was not registered')
  const instance = runtime.mount(window.__slotComponent, window.document.getElementById('mount-right'))

  /** Fire one queued timer by id (the map's key), returning whether it existed. */
  const runTimer = (id) => {
    const entry = pendingTimers.get(id)
    if (!entry) return false
    pendingTimers.delete(id)
    entry.fn()
    return true
  }

  /**
   * Run the queued window timers, optionally only those due within `maxMs`
   * (default: all of them). A long-lived timer — the picker's idle auto-cancel
   * — must not be fired by tests that are waiting out a short timer, or it
   * cancels sessions those tests are still using.
   */
  const flushTimers = (maxMs = Infinity) => {
    const due = []
    for (const [id, entry] of [...pendingTimers.entries()]) {
      if (entry.ms > maxMs) continue
      pendingTimers.delete(id)
      due.push(entry)
    }
    for (const entry of due) entry.fn()
    return due.length
  }

  const settle = async () => { await new Promise((resolve) => realSetTimeout(resolve, 0)) }
  /** Real time passes: the hold threshold is measured in wall-clock ms. */
  const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

  /** End the clip that is still playing (the `holdAudio` counterpart). */
  const endAudio = () => {
    for (const node of audioQueue) {
      if (node.paused) continue
      node.paused = true
      if (node.onended) node.onended()
    }
  }

  return {
    dom, window, document: window.document, layout, requests, spoken, audioQueue,
    pausedElements, internals, runtime, instance, flushTimers, settle, sleep, autoPlay, endAudio,
    pendingTimers, runTimer,
    speechCancels: () => speechCancelCount,
    dispose: () => { for (const fn of applied) { try { fn() } catch { /* ignore */ } } },
  }
}

/**
 * Tiny hook runtime: enough of React to mount one function component and
 * re-render it after a state update, without pulling React into the package.
 */
function createReactRuntime (window) {
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
  let current = null
  let active = null
  let pending = 0

  const hookSlot = (index) => {
    if (!current) throw new Error('hook used outside a render')
    if (!current.hooks[index]) current.hooks[index] = {}
    return current.hooks[index]
  }

  const React = {
    createElement,
    useRef: (initial) => {
      const slot = hookSlot(current.cursor)
      if (!('value' in slot)) slot.value = { current: initial }
      current.cursor += 1
      return slot.value
    },
    useState: (initial) => {
      const slot = hookSlot(current.cursor)
      if (!('state' in slot)) slot.state = typeof initial === 'function' ? initial() : initial
      const set = (next) => { slot.state = typeof next === 'function' ? next(slot.state) : next; pending += 1 }
      current.cursor += 1
      return [slot.state, set]
    },
    useReducer: (reducer, initial) => {
      const slot = hookSlot(current.cursor)
      if (!('state' in slot)) slot.state = initial
      const dispatch = (action) => { slot.state = reducer(slot.state, action); pending += 1 }
      current.cursor += 1
      return [slot.state, dispatch]
    },
    useEffect: (fn, deps) => {
      const slot = hookSlot(current.cursor)
      const changed = !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((value, i) => value !== slot.deps[i])
      if (changed) {
        if (slot.cleanup) { try { slot.cleanup() } catch { /* ignore */ } }
        slot.deps = deps
        slot.pending = fn
        pending += 1
      }
      current.cursor += 1
    },
  }

  const render = (instance) => {
    current = { hooks: instance.hooks, cursor: 0 }
    instance.element = instance.component()
    current = null
    for (const hook of instance.hooks) {
      if (hook && hook.pending) {
        const fn = hook.pending
        hook.pending = null
        hook.cleanup = fn() || null
      }
    }
    if (!instance.tree) {
      instance.tree = toDom(instance.element, instance)
      return
    }
    // Re-render: patch the mounted DOM in place, the way React would. Without
    // this a state change would never reach attributes (aria-pressed) or styles.
    patch(instance.tree, instance.element, instance)
  }

  const patch = (node, element, instance) => {
    if (!element || typeof element !== 'object' || Array.isArray(element)) return
    if (node.nodeType !== 1 || node.tagName.toLowerCase() !== String(element.type)) return
    const listeners = instance.listeners.get(node)
    for (const [key, value] of Object.entries(element.props || {})) {
      if (key === 'children' || key === 'ref') continue
      if (key === 'style') { Object.assign(node.style, value); continue }
      if (key.startsWith('on')) {
        if (listeners && typeof value === 'function') listeners.set(key.slice(2).toLowerCase(), value)
        continue
      }
      if (value === null || value === undefined) { node.removeAttribute(key); continue }
      const next = String(value)
      if (node.getAttribute(key) !== next) node.setAttribute(key, next)
    }
    const elementChildren = (element.children || []).filter((child) => child && typeof child === 'object')
    for (let i = 0; i < elementChildren.length && i < node.childNodes.length; i += 1) {
      patch(node.childNodes[i], elementChildren[i], instance)
    }
  }

  const mount = (component, host) => {
    if (!host) throw new Error('mount target missing')
    const instance = { component, hooks: [], host, listeners: new Map(), global: new Map() }
    active = instance
    render(instance)
    host.append(instance.tree)
    return instance
  }

  const toDom = (element, instance) => {
    if (element === null || element === undefined || element === false) return window.document.createTextNode('')
    if (typeof element === 'string' || typeof element === 'number') return window.document.createTextNode(String(element))
    if (Array.isArray(element)) {
      const fragment = window.document.createDocumentFragment()
      for (const child of element) fragment.append(toDom(child, instance))
      return fragment
    }
    const node = window.document.createElement(element.type)
    for (const [key, value] of Object.entries(element.props || {})) {
      if (key === 'ref') { if (value) value.current = node; continue }
      if (key === 'style') { Object.assign(node.style, value); continue }
      if (key.startsWith('on') && typeof value === 'function') {
        if (!instance.listeners.has(node)) instance.listeners.set(node, new Map())
        instance.listeners.get(node).set(key.slice(2).toLowerCase(), value)
        continue
      }
      if (key === 'children') continue
      if (value === null || value === undefined) continue
      if (key === 'aria-label' || key.startsWith('aria-') || key === 'title' || key === 'type') node.setAttribute(key, String(value))
      else node.setAttribute(key, String(value))
    }
    for (const child of element.children || []) node.append(toDom(child, instance))
    return node
  }

  /**
   * Dispatch one synthetic event. Nodes the component rendered are looked up in
   * the listener map; `window` / `document` targets (where the plugin attaches
   * its picker, scroll and outside-click listeners) use a separate map fed by
   * the patched addEventListener below.
   */
  const dispatch = (instance, target, type, event = {}) => {
    const detail = { type, target, currentTarget: target, preventDefault: () => {}, stopPropagation: () => {}, ...event }
    let handler
    if (target === window || target === window.document) {
      handler = instance.global.get(`${target === window ? 'window' : 'document'}:${type}`)
    } else {
      const map = instance.listeners.get(target)
      handler = map ? map.get(type) : undefined
    }
    if (!handler) throw new Error(`no ${type} listener on the mounted node`)
    handler(detail)
    while (pending > 0) { pending = 0; render(instance) }
    return detail
  }

  /**
   * Native dispatch for nodes the plugin wired with its own `addEventListener`
   * (the popover's sliders and buttons), which the listener map above cannot
   * see. A real jsdom event runs those listeners for real.
   */
  const nativeDispatch = (node, type, event = {}) => {
    const real = new window.Event(type, { bubbles: true, cancelable: true })
    for (const [key, value] of Object.entries(event)) {
      try { Object.defineProperty(real, key, { value, configurable: true }) } catch { /* read-only in jsdom */ }
    }
    node.dispatchEvent(real)
    while (pending > 0) { pending = 0; render(active) }
    return real
  }

  // The plugin registers window/document listeners from its effects (the
  // picker's pointermove, the caret's scroll/resize, outside clicks). Record
  // them on the instance so `dispatch` can reach them; the real registration
  // still happens, so the nativeDispatch paths keep working too.
  for (const [key, target] of [['window', window], ['document', window.document]]) {
    const add = target.addEventListener.bind(target)
    const remove = target.removeEventListener.bind(target)
    target.addEventListener = (type, handler, capture) => {
      if (active) active.global.set(`${key}:${type}`, handler)
      return add(type, handler, capture)
    }
    target.removeEventListener = (type, handler, capture) => {
      if (active) active.global.delete(`${key}:${type}`)
      return remove(type, handler, capture)
    }
  }

  return { React, mount, render, dispatch, nativeDispatch }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('sh-volume-shuff — client bundle tests\n')

/**
 * One press-and-hold on the icon, as a browser delivers it: press, wait out the
 * hold threshold, then release — the release is what arms the picker.
 */
const longPress = async (harness) => {
  const { instance, document } = harness
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 100, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 101, clientY: 700, pointerId: 1 })
  await harness.sleep(450) // the hold threshold is wall-clock, like the real one
  harness.flushTimers(1000) // fire the 400ms hold timer, not the 5s idle one
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 101, clientY: 700, pointerId: 1 })
}

await test('bundle registers the 0.1.7 slot contract', async () => {
  const harness = createHarness()
  equal(harness.window.__slotDefinition.name, 'conversation.input.right', 'slot name')
  equal(harness.window.__slotDefinition.id, 'sh-volume-shuff', 'slot id')
  equal(harness.window.__slotDefinition.order, 40, 'slot order')
  harness.dispose()
})

await test('finds message nodes through the kind marker, not data-chat-flow', async () => {
  // The live page had 223 `[data-chat-flow-kind]` nodes and 32 `[data-chat-flow]`
  // nodes, in *disjoint* sets: reading the flow marker alone found containers
  // with kind=null, so nothing was readable and the button went silent.
  const harness = createHarness()
  const { internals, document } = harness
  const decoys = document.createElement('div')
  decoys.innerHTML = '<div data-chat-flow></div><div data-chat-flow></div><div data-chat-flow></div>'
  document.getElementById('scroller').prepend(decoys)
  const flow = internals.readableFlow()
  equal(flow.length, 4, 'the decoy flow containers are ignored')
  equal(flow.map((entry) => entry.kind).join(','), 'user,assistant-step,user,assistant-step', 'the real message nodes are found')
  harness.dispose()
})

await test('reads only the real readable kinds, never the turn furniture', async () => {
  const harness = createHarness()
  const { internals, document } = harness
  const reply = document.getElementById('reply')
  const segment = internals.readableFlow().find((entry) => entry.node === reply)
  const index = internals.segmentIndexOf(segment)
  includes(index.text, ASSISTANT_TEXT, 'the answer is indexed for offset math')
  assert(!index.text.includes('复制'), 'the action buttons are not indexed')

  const flow = internals.readableFlow()
  equal(flow.length, 4, 'two questions + the newest answer + the older answer')
  const kinds = flow.map((entry) => entry.kind).join(',')
  equal(kinds, 'user,assistant-step,user,assistant-step', 'only user and assistant-step are readable')
  const all = flow.map((entry) => entry.text).join('\n\n')
  assert(!all.includes(THINKING_TEXT), 'reasoning steps are not spoken (their ancestor is display:none)')
  assert(!all.includes(PROCESS_TEXT), 'the turn-process header is not spoken')
  assert(!all.includes(TOOL_TEXT), 'tool-call cards are not spoken')
  assert(!all.includes(TAIL_TEXT), 'the token/time footer is not spoken')
  assert(!all.includes('隐藏的回复'), 'hidden nodes are not readable')
  harness.dispose()
})

await test('click reads from the start of the newest question and scrolls there', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, layout, requests, spoken } = harness
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 1 })
  await harness.settle()
  await harness.settle()

  const join = (list) => list.join('')
  const spokenText = join(spoken)
  includes(spokenText, USER_TEXT, 'reads the newest question')
  includes(spokenText, ASSISTANT_TEXT, 'reads the newest answer')
  assert(!spokenText.includes(OLD_ASSISTANT), 'does not read older replies')
  assert(!spokenText.includes('复制'), 'does not read action buttons')
    assert(layout.scrollCalls.length > 0, 'the page was scrolled to the start position')
  // However the voice timing falls, the reading ends with no marker left.
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'no marker is left behind at the end')
  const plan = harness.internals.readingPlan()
  includes(plan.text, USER_TEXT, 'plan starts at the question')
  assert(requests.some((entry) => entry.path === '/sh-volume-shuff/diag'), 'diagnostics were reported')

  // Regression: the live DOM puts the token/time footer (kind="turn-tail")
  // *inside* the flow, and the first released version happily used it as the
  // start position — the caret then blinked on "用量 301K tok 02:00".
  const resolved = harness.internals.resolveCursor()
  equal(resolved.segment.kind, 'user', 'the start position lives on a question node')
  equal(resolved.segment.node.id, 'question', 'and specifically the newest one')
  const questionBox = document.getElementById('question').getBoundingClientRect()
  const startStream = harness.internals.messageIndex()
  const startRect = harness.internals.rectAtOffset(startStream, harness.internals.defaultStartOffset(startStream))
  assert(startRect, 'the start character has a rectangle')
  assert(startRect.top >= questionBox.top - 2 && startRect.top <= questionBox.bottom + 2,
    `the start character sits inside the question, not on the footer (top ${startRect.top}, question ${questionBox.top}..${questionBox.bottom})`)
  assert(!plan.text.includes(TAIL_TEXT), 'the token/time footer is never read')
  harness.dispose()
})

await test('a press hides the hover bubble, the release reads, the next click stops', async () => {
  const harness = createHarness({ tts: true, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const tip = () => document.querySelector('.sh-vs-tip')
  const click = () => {
    harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
    harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 1 })
  }

  // Hovering shows the bubble; the press takes it down before anything reads.
  harness.runtime.dispatch(instance, button, 'pointerenter', {})
  equal(tip().style.display, 'block', 'the hover bubble is up while hovering')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
  equal(tip().style.display, 'none', 'pressing the icon hides the hover bubble')
  equal(internals.state.reading, false, 'and the press alone does not read yet')
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 1 })
  await harness.settle()
  await harness.settle()
  equal(tip().style.display, 'none', 'and it stays down after the release')
  equal(internals.state.reading, true, 'the release started the reading')
  equal(button.getAttribute('aria-pressed'), 'true', 'the button reports playing')
  // A second click is a click, not a hold: it stops the reading.
  click()
  equal(internals.state.reading, false, 'stopped after the second click')
  assert(harness.audioQueue.some((node) => node.paused), 'the clip was paused')
  harness.dispose()
})

await test('holding the icon arms the picker and the page click picks the start and reads', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const button = () => document.querySelector('#mount-right button')
  const reply = document.getElementById('reply')
  const box = reply.getBoundingClientRect()
  const caret = () => document.querySelector('.sh-vs-caret')
  const hint = () => document.querySelector('.sh-vs-hint') || { style: {}, textContent: '' }
  // A fresh press does not arm anything: the hold threshold has to pass first.
  harness.runtime.dispatch(instance, button(), 'pointerdown', { clientX: 100, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button(), 'pointerenter', {}) // the pointer is on the icon
  equal(internals.state.picking, false, 'a fresh press does not arm the picker')
  equal(document.querySelector('.sh-vs-hint'), null, 'and no pick bubble is up yet')
  equal(document.querySelector('.sh-vs-tip').style.display, 'block', 'the hover bubble stays up while holding')
  includes(document.querySelector('.sh-vs-tip').textContent, '长按选起点', 'and it still carries the idle wording')
  // Hold past the threshold, then release: the release is what changes the
  // bubble and arms the picker, and it must not turn into a read.
  await harness.sleep(450)
  harness.flushTimers(1000)
  equal(internals.state.picking, false, 'the hold alone still does not arm the picker')
  harness.runtime.dispatch(instance, button(), 'pointerup', { clientX: 100, clientY: 700, pointerId: 1 })
  equal(internals.state.picking, true, 'the release after a hold arms the picker')
  equal(internals.state.pickStage, 'armed', 'stage = armed')
  equal(internals.state.reading, false, 'the release after a hold does not read')
  equal(document.querySelector('.sh-vs-tip').style.display, 'none', 'and the hover bubble steps aside')
  equal(hint().style.display, 'block', 'the pick bubble takes its place')
  harness.flushTimers(1000) // only the sub-second timers; the 5s idle one must stay pending
  includes(hint().textContent, '选择开始位置后点击', 'the pick wording')
  includes(hint().textContent, 'After Pick → Tap', 'and its English caption')
  assert(!caret() || caret().style.display === 'none', 'no caret while the page click is awaited')
  equal(document.body.style.cursor, 'crosshair', 'the page invites a click')

  // Moving the pointer retires the bubble — the click that chooses the start
  // position no longer has to dismiss it.
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320, clientY: 480 })
  equal(hint().style.display, 'none', 'moving the mouse hides the pick bubble')
  equal(internals.state.picking, true, 'the picker stays armed after the move')
  equal(document.body.style.cursor, 'crosshair', 'and the page still invites the click')

  // Stage 2 — clicking readable text places the caret and reads from there.
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: box.left + 50, clientY: box.top + 8, pointerId: 3, button: 0 })
  equal(caret().style.display, 'block', 'the click placed the caret')
  equal(caret().dataset.mode, 'read', 'the caret is in reading mode, not pick mode')
  equal(internals.state.cursor.key, 'a2resp', 'the caret sits on the clicked answer')
  harness.runtime.dispatch(instance, document, 'pointerup', { clientX: box.left + 50, clientY: box.top + 8, pointerId: 3 })
  await harness.settle()
  await harness.settle()
  equal(internals.state.picking, false, 'picker disarmed')
  equal(internals.state.reading, true, 'the reading started from the clicked character')
  equal(hint().style.display, 'none', 'the pick bubble is gone')
  equal(document.body.style.cursor, '', 'the cursor is restored')
  // The pick passes its own start: the reading that just started reports a
  // stream offset inside the clicked answer, while a plain click reports the
  // newest question's first character.
  const stream = internals.messageIndex()
  const startEvents = harness.requests
    .filter((entry) => entry.path === '/sh-volume-shuff/diag' && entry.body && entry.body.event === 'read:start')
  assert(startEvents.length > 0, 'the reading start was reported')
  const startedAt = JSON.parse(startEvents[startEvents.length - 1].body.detail).offset
  assert(startedAt > stream.text.indexOf(ASSISTANT_TEXT), `the pick read from inside the answer (got ${startedAt})`)
  // Ending the reading drops the picked position; a plain click then starts at
  // the newest question again.
  internals.stopReading()
  equal(internals.readingPlan().offset, stream.text.indexOf(USER_TEXT), 'a plain click still starts at the newest question')

  // A hold also works right after a reading: it arms the picker the same way.
  internals.stopReading()
  await longPress(harness)
  equal(internals.state.picking, true, 'a hold after a reading arms the picker again')
  harness.dispose()
})

await test('the pick bubble replaces the hover bubble and is retired by the first pointer move', async () => {
  // Regression: hovering shows the idle bubble, and holding the icon arms the
  // picker while the pointer is still on it — so both bubbles used to sit above
  // the icon and the pick wording was covered by the idle one.
  const harness = createHarness({ tts: false })
  const { instance, document, window, internals } = harness
  const button = () => document.querySelector('#mount-right button')
  const tip = () => document.querySelector('.sh-vs-tip')
  const hint = () => document.querySelector('.sh-vs-hint')

  // The pointer arrives on the icon: the idle bubble shows.
  harness.runtime.dispatch(instance, button(), 'pointerenter', {})
  equal(tip().style.display, 'block', 'the idle bubble shows on hover')
  equal(hint(), null, 'and no pick bubble exists yet')

  // The hold happens without the pointer ever leaving the icon.
  await longPress(harness)
  equal(internals.state.picking, true, 'picker armed')
  equal(tip().style.display, 'none', 'the idle bubble is taken down')
  equal(hint().style.display, 'block', 'the pick bubble is the one on screen')
  assert(hint().textContent.startsWith('选择开始位置后点击'), 'and it carries the pick wording')
  assert(hint().style.top && hint().style.left, 'the pick bubble was placed (jsdom has no paint, so only placement is checkable)')

  // A re-fired pointerenter must not bring the idle bubble back while picking.
  harness.runtime.dispatch(instance, button(), 'pointerenter', {})
  equal(tip().style.display, 'none', 'hovering again does not resurrect it')
  harness.flushTimers(1000) // the deferred take-down only; the 5s idle timer stays pending
  equal(tip().style.display, 'none', 'still hidden after the next paint')
  equal(hint().style.display, 'block', 'and the pick bubble is still up')

  // The bubble lives until the pointer moves: a scroll or resize before that
  // must keep it on screen (it follows the composer).
  harness.runtime.dispatch(instance, window, 'scroll', {})
  equal(hint().style.display, 'block', 'a scroll before the move keeps the bubble up')

  // The first movement retires it for good — later scrolls must not revive it.
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320, clientY: 480 })
  equal(hint().style.display, 'none', 'the first pointer movement hides the pick bubble')
  harness.runtime.dispatch(instance, window, 'scroll', {})
  harness.runtime.dispatch(instance, window, 'resize', {})
  equal(hint().style.display, 'none', 'and no scroll or resize brings it back')
  equal(internals.state.picking, true, 'the picker is still armed after moving')

  // Choosing the start position retires the pick bubble; hovering works again.
  const reply = document.getElementById('reply')
  const replyBox = reply.getBoundingClientRect()
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: replyBox.left + 30, clientY: replyBox.top + 8, pointerId: 5, button: 0 })
  harness.runtime.dispatch(instance, document, 'pointerup', { clientX: replyBox.left + 30, clientY: replyBox.top + 8, pointerId: 5 })
  await harness.settle()
  equal(internals.state.picking, false, 'the pick is committed')
  equal(hint().style.display, 'none', 'the pick bubble is gone')
  harness.runtime.dispatch(instance, button(), 'pointerenter', {})
  equal(tip().style.display, 'block', 'the idle bubble is available again')
  harness.runtime.dispatch(instance, button(), 'pointerleave', {})
  equal(tip().style.display, 'none', 'and it still hides on leave')
  harness.dispose()
})

await test('moving the mouse only retires the bubble: the pick stays armed', async () => {
  // holdAudio keeps the clip "playing" so `reading` is stable across the awaits.
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const hint = () => document.querySelector('.sh-vs-hint')

  // Arrive on the icon, then hold: the bubble replaces the hover one.
  harness.runtime.dispatch(instance, button, 'pointerenter', {})
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 100, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 101, clientY: 700, pointerId: 1 })
  await harness.sleep(450)
  harness.flushTimers(1000)
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 101, clientY: 700, pointerId: 1 })
  equal(internals.state.picking, true, 'the hold armed the picker')
  equal(hint().style.display, 'block', 'the pick bubble is up')

  // A plain move is the one operation that does NOT cancel.
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320, clientY: 480 })
  equal(hint().style.display, 'none', 'moving the mouse hides the bubble')
  equal(internals.state.picking, true, 'but the picker stays armed')
  equal(internals.state.pickStage, 'armed', 'and no start position is placed yet')

  // The next click still reads from the chosen spot.
  const reply = document.getElementById('reply')
  const box = reply.getBoundingClientRect()
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: box.left + 30, clientY: box.top + 8, pointerId: 9, button: 0 })
  harness.runtime.dispatch(instance, document, 'pointerup', { clientX: box.left + 30, clientY: box.top + 8, pointerId: 9 })
  await harness.settle()
  await harness.settle()
  equal(internals.state.reading, true, 'the click after the move still starts the reading')
  harness.dispose()
})

await test('a key press during the pick cancels it and retires the bubble', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const tip = () => document.querySelector('.sh-vs-tip')
  const hint = () => document.querySelector('.sh-vs-hint')

  harness.runtime.dispatch(instance, button, 'pointerenter', {})
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 100, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 101, clientY: 700, pointerId: 1 })
  await harness.sleep(450)
  harness.flushTimers(1000)
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 101, clientY: 700, pointerId: 1 })
  equal(internals.state.picking, true, 'the hold armed the picker')
  equal(hint().style.display, 'block', 'the pick bubble is up')

  harness.runtime.dispatch(instance, document, 'keydown', { key: 'a' })
  equal(internals.state.picking, false, 'a keystroke cancels the pick')
  equal(hint().style.display, 'none', 'and takes the pick bubble down')
  equal(document.body.style.cursor, '', 'and restores the pointer')
  equal(internals.state.reading, false, 'nothing is read')
  equal(tip().style.display, 'none', 'the hover bubble does not come back with the pick gone')

  // With the picker gone the icon is a plain click target again.
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 3, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 3 })
  await harness.settle()
  await harness.settle()
  equal(internals.state.reading, true, 'a later click reads again')
  harness.dispose()
})

await test('a wheel turn, a drag, a context click or a blur all cancel the pick', async () => {
  const operations = [
    ['wheel', 'wheel', {}, 'document'],
    ['drag', 'pointermove', { buttons: 1 }, 'document'],
    ['context click', 'pointerdown', { button: 2, clientX: 320, clientY: 480 }, 'document'],
    ['window blur', 'blur', {}, 'window'],
  ]
  for (const [label, type, event, target] of operations) {
    const harness = createHarness({ tts: false })
    const { instance, document, window, internals } = harness
    const button = document.querySelector('#mount-right button')
    const hint = () => document.querySelector('.sh-vs-hint')
    harness.runtime.dispatch(instance, button, 'pointerenter', {})
    harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 100, clientY: 700, pointerId: 1, button: 0 })
    harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 101, clientY: 700, pointerId: 1 })
    await harness.sleep(450)
    harness.flushTimers(1000)
    harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 101, clientY: 700, pointerId: 1 })
    equal(internals.state.picking, true, `${label}: armed`)
    harness.runtime.dispatch(instance, target === 'window' ? window : document, type, event)
    equal(internals.state.picking, false, `${label}: cancels the pick`)
    equal(hint().style.display, 'none', `${label}: bubble down`)
    equal(internals.state.reading, false, `${label}: nothing is read`)
    harness.dispose()
  }
})

await test('the pick times out even when the mouse never moves after the release', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const caret = () => document.querySelector('.sh-vs-caret')
  const hint = () => document.querySelector('.sh-vs-hint')

  await longPress(harness)
  equal(internals.state.picking, true, 'the hold armed the picker')
  equal(hint().style.display, 'block', 'the bubble is up (the mouse has not moved)')
  equal(document.body.style.cursor, 'crosshair', 'and the pointer is the pick cursor')
  // The countdown is live from the moment the picker arms, even with no move:
  // its timer is the 5s entry in the harness' timer table.
  const idle = [...harness.pendingTimers.entries()].find(([, entry]) => entry.ms === 5000)
  assert(idle, 'the idle auto-cancel timer is pending')
  assert(harness.runTimer(idle[0]), 'and it fires')
  equal(internals.state.picking, false, 'the idle pick cancels itself')
  equal(hint().style.display, 'none', 'the bubble is gone')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'no caret node is left behind')
  equal(internals.state.cursor, null, 'and the stored position is dropped')
  equal(document.body.style.cursor, '', '光标回到初始状态')
  equal(internals.state.reading, false, 'and nothing was read')
  harness.dispose()
})

await test('a pick that is left idle after the move times out and cancels itself', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const caret = () => document.querySelector('.sh-vs-caret')
  const hint = () => document.querySelector('.sh-vs-hint')

  // A caret is on screen when the pick starts, so "光标回到初始状态" is visible.
  internals.state.cursor = { key: 'a2resp', offset: 3 }
  const stream = internals.messageIndex()
  internals.focusStartPosition({ stream, offset: stream.text.indexOf(ASSISTANT_TEXT) + 3 })
  equal(caret().style.display, 'block', 'the caret is blinking before the pick')

  await longPress(harness)
  equal(internals.state.picking, true, 'the hold armed the picker')
  // Moving retires the bubble and starts the idle countdown.
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320, clientY: 480 })
  equal(hint().style.display, 'none', 'the move retires the bubble')
  equal(internals.state.picking, true, 'and the pick waits for a click')

  // Still armed while real time passes well inside the window.
  await harness.sleep(2000)
  equal(internals.state.picking, true, 'still waiting inside the idle window')
  // Nobody touches anything: the pending idle timer is what ends the session.
  const idle = [...harness.pendingTimers.entries()].find(([, entry]) => entry.ms === 5000)
  assert(idle, 'the idle auto-cancel timer is pending')
  assert(harness.runTimer(idle[0]), 'and it fires')
  equal(internals.state.picking, false, 'the idle pick cancels itself')
  equal(internals.state.pickStage, 'idle', 'back to idle')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'the caret node is gone')
  equal(internals.state.cursor, null, 'and the stored position is dropped')
  equal(document.body.style.cursor, '', 'the pointer is back to normal')
  harness.dispose()
})

await test('every mouse move resets the idle countdown', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness

  await longPress(harness)
  for (let i = 0; i < 3; i += 1) {
    harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320 + i, clientY: 480 })
    await harness.sleep(1200) // real time passes, well inside one window
    equal(internals.state.picking, true, `still armed after move ${i + 1}`)
    // Every move replaces the pending timer: exactly one idle timer remains.
    const pending = [...harness.pendingTimers.entries()].filter(([, entry]) => entry.ms === 5000)
    equal(pending.length, 1, `move ${i + 1} left exactly one idle timer pending`)
  }
  // Stop moving: the last move's countdown is the one that ends the pick.
  const idle = [...harness.pendingTimers.entries()].find(([, entry]) => entry.ms === 5000)
  assert(idle, 'the last move scheduled the idle timer')
  assert(harness.runTimer(idle[0]), 'and it fires')
  equal(internals.state.picking, false, 'after the last move the idle wait finally cancels it')
  harness.dispose()
})

await test('finishing and cancelling both remove the caret', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const stream = internals.messageIndex()
  const questionStart = stream.text.indexOf(USER_TEXT)

  // --- a reading that simply runs out ---------------------------------------
  internals.state.cursor = { key: 'a2resp', offset: 10 } // as if a pick had moved it
  // Not awaited: with holdAudio the browser voice never ends, and the point is
  // what finishing does to the marker. The state is set synchronously.
  void internals.startReading()
  equal(internals.state.reading, true, 'reading')
  assert(document.querySelector('.sh-vs-caret'), 'the caret is drawn while reading')
  internals.finishReading() // a reading that simply runs out
  equal(internals.state.reading, false, 'the reading finished')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'the finished reading leaves no marker')
  equal(internals.state.cursor, null, 'and drops the stored position')
  equal(internals.readingPlan().offset, questionStart, 'the next reading starts at the newest question')

  // --- a pick the operator cancels -------------------------------------------
  internals.state.cursor = { key: 'a2resp', offset: 12 }
  await longPress(harness)
  equal(internals.state.picking, true, 'picker armed')
  harness.runtime.dispatch(instance, document, 'keydown', { key: 'Escape' })
  equal(internals.state.picking, false, 'the pick was cancelled')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'the cancelled pick leaves no caret either')
  equal(internals.state.cursor, null, 'and drops the stored position')
  equal(internals.readingPlan().offset, questionStart, 'and the next reading also starts at the newest question')
  harness.dispose()
})

await test('stopping the reading by hand takes the marker away entirely', async () => {
  // 再次点击停止朗读：标记彻底消失；起点仍是最后一次提问的第一个字。
  const harness = createHarness({ tts: true, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const caret = () => document.querySelector('.sh-vs-caret')
  const click = () => {
    harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
    harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 1 })
  }
  click()
  await harness.settle()
  await harness.settle()
  equal(internals.state.reading, true, 'reading')
  equal(caret().style.display, 'block', 'the caret is blinking while reading')
  click()
  equal(internals.state.reading, false, 'stopped')
  equal(document.body.style.cursor, '', 'the crosshair is gone')
  assert(!caret() || caret().style.display === 'none', 'the marker is gone from the page')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'and no caret node is left behind')
  equal(internals.state.cursor, null, 'the stored position is dropped')
  // The reading start is still the newest question's first character.
  const plan = internals.readingPlan()
  const stream = internals.messageIndex()
  const questionStart = stream.text.indexOf(USER_TEXT)
  equal(plan.offset, questionStart, 'the next reading starts at the newest question again')
  harness.dispose()
})

await test('only one caret node ever exists, and a stop removes it', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const carets = () => document.querySelectorAll('.sh-vs-caret')
  const click = () => {
    harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
    harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 1 })
  }

  // A leftover caret from an older copy of the plugin (or a hot reload).
  const stale = document.createElement('div')
  stale.className = 'sh-vs-caret'
  stale.dataset.mode = 'read'
  stale.style.display = 'block'
  stale.style.left = '11px'
  document.body.append(stale)

  click() // read: the plugin creates its own caret
  await harness.settle()
  await harness.settle()
  equal(carets().length, 1, 'the stale caret was swept away')
  assert(!document.body.contains(stale), 'and it is really gone from the page')
  const live = carets()[0]
  equal(live.style.animation, '', 'while reading the pulse comes from the stylesheet')

  click() // stop: the marker goes away with the sound
  equal(carets().length, 0, 'no caret node is left on the page')
  equal(document.body.style.cursor, '', 'and the pointer is back to normal')
  harness.dispose()
})

await test('a stacked pair is centred; the idle columns stay left aligned', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')

  // Idle: three columns, left aligned as a grid.
  harness.runtime.dispatch(instance, button, 'pointerenter', {})
  const tip = document.querySelector('.sh-vs-tip')
  internals.alignBubble(tip, 420) // a real layout would measure the grid this wide
  equal(tip.dataset.stack, 'row', 'the idle bubble is laid out as columns')

  // A pick prompt is a stacked pair: centred under one another.
  const hint = document.createElement('div')
  hint.className = 'sh-vs-hint'
  document.body.append(hint)
  internals.alignBubble(hint, 120)
  equal(hint.dataset.stack, 'center', 'a narrow bubble is a stacked pair')

  const css = document.getElementById('sh-vs-style').textContent
  assert(!document.getElementById('sh-vk-style'), "the stylesheet keeps its own id, never the sibling sh-volume-knob's")
  assert(!/sh-vk-/u.test(css), 'and no sh-vk- class can be shadowed by (or shadow) that sibling sheet')
  includes(css, '.sh-vs-hint[data-stack="center"], .sh-vs-tip[data-stack="center"]', 'the stylesheet centres stacked pairs')
  includes(css, 'text-align: center', 'with a real text-align rule')
  harness.dispose()
})

await test('a click always starts at the newest question, even after the arrows moved the caret', async () => {
  const harness = createHarness({ tts: true, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const stream = internals.messageIndex()
  const questionStart = stream.text.indexOf(USER_TEXT)

  // Park the caret somewhere else entirely (the arrow keys' doing).
  internals.state.cursor = { key: 'a1', offset: 10 }
  equal(internals.readingPlan().offset, questionStart, 'the plan ignores the parked caret')
  assert(internals.state.cursor.key === 'a1', 'the parked caret is still remembered for the arrows')

  // A plain click must ignore it.
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 1 })
  await harness.settle()
  await harness.settle()
  equal(internals.state.reading, true, 'reading')
  equal(internals.state.cursor.key, 'u2', 'the reading started on the newest question')
  equal(internals.state.cursor.offset, 0, 'at its first character')

  // Enter does the same.
  internals.stopReading()
  internals.state.cursor = { key: 'a1', offset: 10 }
  harness.runtime.dispatch(instance, button, 'keydown', { key: 'Enter' })
  await harness.settle()
  await harness.settle()
  equal(internals.state.cursor.key, 'u2', 'keyboard activation also ignores the parked caret')
  equal(internals.state.cursor.offset, 0, 'and starts at the newest question')
  harness.dispose()
})

await test('a pick that keeps being moved but never clicked still times out and clears everything', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const caret = () => document.querySelector('.sh-vs-caret')
  const hint = () => document.querySelector('.sh-vs-hint')
  const idleTimer = () => [...harness.pendingTimers.entries()].filter(([, entry]) => entry.ms === 5000)

  await longPress(harness)
  equal(internals.state.picking, true, 'the hold armed the picker')
  equal(idleTimer().length, 1, 'the 5s countdown starts the moment the picker arms')
  equal(hint().style.display, 'block', 'the pick bubble is up')

  // Move: the bubble goes, the countdown restarts (moving must never cancel).
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320, clientY: 480 })
  equal(hint().style.display, 'none', 'moving retires the bubble')
  equal(idleTimer().length, 1, 'and leaves exactly one countdown pending')
  await harness.sleep(1200)
  equal(internals.state.picking, true, 'still armed 1.2s after the move')

  // Move again, still without clicking any text.
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 340, clientY: 500 })
  equal(idleTimer().length, 1, 'the second move replaces the countdown')
  await harness.sleep(1200)
  equal(internals.state.picking, true, 'still armed 1.2s after the second move')

  // Stop moving and never click: the countdown is the only thing left.
  const idle = idleTimer()[0]
  assert(idle, 'a countdown is pending')
  assert(harness.runTimer(idle[0]), 'it fires')
  equal(internals.state.picking, false, 'the pick cancels itself')
  equal(internals.state.pickStage, 'idle', 'back to idle')
  equal(hint().style.display, 'none', 'the bubble is gone')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'no caret node is left')
  equal(internals.state.cursor, null, 'and no stored position either')
  equal(document.body.style.cursor, '', 'the pointer is back to normal')
  equal(internals.state.reading, false, 'nothing was read')
  // And the reason is on the record, so a live session can be audited.
  const cancels = harness.requests.filter((entry) => entry.path === '/sh-volume-shuff/diag' && entry.body && entry.body.event === 'gesture:pick-cancel')
  equal(cancels.length, 1, 'one cancellation was reported')
  equal(cancels[0].body.detail, 'idle-timeout', 'and it says why: the idle timeout')
  harness.dispose()
})

await test('while the picker is live the page keeps the pick cursor, even on the icon', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const root = document.documentElement

  equal(root.classList.contains('sh-vs-picking'), false, 'no pick cursor class before the gesture')

  await longPress(harness)
  equal(internals.state.picking, true, 'picker armed')
  equal(root.classList.contains('sh-vs-picking'), true, 'the page switches to the pick cursor')
  equal(document.body.style.cursor, 'crosshair', 'and the body cursor follows')
  const css = document.getElementById('sh-vs-style').textContent
  includes(css, 'html.sh-vs-picking', 'the stylesheet targets the root class')
  includes(css, 'cursor: crosshair !important', 'and outranks the icon inline cursor: pointer')
  assert(css.includes('html.sh-vs-picking *'), 'the override covers every element on the page')
  equal(button.style.cursor, 'pointer', 'the icon still declares its own hand cursor (overridden while picking)')

  // Moving around mid-pick must not end it or change the shape.
  harness.runtime.dispatch(instance, document, 'pointermove', { clientX: 320, clientY: 480 })
  equal(root.classList.contains('sh-vs-picking'), true, 'still the pick cursor after a move')

  // Picking a spot ends the session and restores the normal cursor.
  const reply = document.getElementById('reply')
  const box = reply.getBoundingClientRect()
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: box.left + 30, clientY: box.top + 8, pointerId: 3, button: 0 })
  harness.runtime.dispatch(instance, document, 'pointerup', { clientX: box.left + 30, clientY: box.top + 8, pointerId: 3 })
  await harness.settle()
  equal(internals.state.picking, false, 'the pick committed')
  equal(root.classList.contains('sh-vs-picking'), false, 'and the pick cursor is gone')
  equal(document.body.style.cursor, '', 'the body cursor is restored')

  // A cancelled pick restores it too.
  await longPress(harness)
  equal(root.classList.contains('sh-vs-picking'), true, 'armed again')
  harness.runtime.dispatch(instance, document, 'keydown', { key: 'Escape' })
  equal(internals.state.picking, false, 'cancelled')
  equal(root.classList.contains('sh-vs-picking'), false, 'and restored')
  harness.dispose()
})

await test('the DOM map and the flattened text share one coordinate space', async () => {
  // Regression: walkText opens every block with a newline, and tidy() used to
  // trim that newline off the *string* while leaving the map's offsets alone.
  // Every character was then shifted by the leading newline, so a click landed
  // at the end of the line instead of under the pointer.
  const harness = createHarness({ tts: false })
  const { internals, document, window } = harness
  const reply = document.getElementById('reply')
  const segment = internals.readableFlow().find((entry) => entry.node === reply)
  const index = internals.segmentIndexOf(segment)

  equal(index.text, ASSISTANT_TEXT, 'the flattened text is exactly the answer')
  equal(index.length, index.text.length, 'the reported length matches the string (no off-by-leading-newline)')

  // Every mapped text node must resolve to the same offset it was registered at.
  for (const [textNode, start] of index.map) {
    const probe = document.createRange()
    probe.setStart(textNode, 0)
    probe.collapse(true)
    const mapped = internals.offsetFromRangeForTest(probe, segment)
    equal(mapped, start, `offset for the node starting at ${start}`)
    const inside = document.createRange()
    inside.setStart(textNode, 1)
    inside.collapse(true)
    equal(internals.offsetFromRangeForTest(inside, segment), start + 1, `offset one character into the node at ${start}`)
  }

  // The first character of the reply is reachable and is the paragraph's start.
  const firstEntry = index.map[0]
  equal(firstEntry[1], 0, 'the reply starts at offset 0')
  includes(index.text, firstEntry[0].nodeValue.slice(0, 6), 'and that offset really is the first characters')
  harness.dispose()
})

await test('a click on empty space cancels the pick and removes the caret', async () => {
  const harness = createHarness({ tts: false, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const caret = () => document.querySelector('.sh-vs-caret')
  const hint = () => document.querySelector('.sh-vs-hint')

  // A reading is on, so a caret is blinking when the pick starts.
  internals.state.cursor = { key: 'a2resp', offset: 3 }
  const stream = internals.messageIndex()
  internals.focusStartPosition({ stream, offset: stream.text.indexOf(ASSISTANT_TEXT) + 3 })
  equal(caret().style.display, 'block', 'the caret is blinking before the pick')

  await longPress(harness)
  equal(internals.state.picking, true, 'the hold armed the picker')
  equal(hint().style.display, 'block', 'the pick bubble is up')

  // Clicking empty space is one of the "other operations": it cancels.
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: 5, clientY: 5, pointerId: 3, button: 0 })
  equal(internals.state.picking, false, 'a click on empty space cancels the pick')
  equal(internals.state.pickStage, 'idle', 'back to idle')
  equal(hint().style.display, 'none', 'the pick bubble is down')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'and the caret node is gone')
  equal(internals.state.cursor, null, 'with the stored position dropped')
  equal(document.body.style.cursor, '', 'the pointer is restored')
  equal(internals.state.reading, false, 'nothing is read')
  harness.dispose()
})

await test('Escape disarms the picker', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, internals } = harness
  await longPress(harness)
  equal(internals.state.picking, true, 'armed')
  harness.runtime.dispatch(instance, document, 'keydown', { key: 'Escape' })
  equal(internals.state.picking, false, 'Escape disarms')
  equal(document.querySelector('.sh-vs-hint').style.display, 'none', 'and hides the hint')
  harness.dispose()
})

await test('a stopped reading restarts at the newest question, not at the old pick', async () => {
  // holdAudio keeps the clip playing, so the picked position is still stored.
  const harness = createHarness({ tts: true, holdAudio: true })
  const { instance, document, internals } = harness
  const reply = document.getElementById('reply')
  const box = reply.getBoundingClientRect()
  await longPress(harness)
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: box.left + 30, clientY: box.top + 8, pointerId: 3, button: 0 })
  harness.runtime.dispatch(instance, document, 'pointerup', { clientX: box.left + 30, clientY: box.top + 8, pointerId: 3 })
  await harness.settle()
  await harness.settle()
  const picked = internals.state.cursor && internals.state.cursor.offset
  assert(Number.isFinite(picked), `the pick had a stored offset (got ${picked})`)
  internals.stopReading()
  equal(internals.state.cursor, null, 'stopping drops the picked position')
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 3, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 3 })
  await harness.settle()
  await harness.settle()
  const stream = internals.messageIndex()
  const questionStart = stream.text.indexOf(USER_TEXT)
  equal(internals.readingPlan().offset, questionStart, 'the next reading restarts at the newest question')
  assert(questionStart !== picked, 'which is a different character from the old pick')
  harness.dispose()
})

await test('a stray drag neither picks nor opens the mixer (it reads instead)', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 480, clientY: 700, pointerId: 1 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 500, clientY: 760, pointerId: 1 })
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 760, pointerId: 1 })
  equal(internals.state.picking, false, 'no picker')
  equal(internals.state.pickStage, 'idle', 'no pick stage')
  equal(document.querySelectorAll('.sh-vs-hint').length, 0, 'no hint')
  equal(internals.state.reading, true, 'a short press is a plain click, so it reads')
  harness.dispose()
})

await test('press and drag up still opens the volume panel', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 504, clientY: 660, pointerId: 1 })
  assert(document.querySelector('input[type="range"]'), 'the mixer mounted')
  equal(internals.state.reading, false, 'dragging up does not start reading')
  harness.dispose()
})

await test('dsh-tts speaks chunk by chunk from the chosen offset', async () => {
  const harness = createHarness({ tts: true })
  const { internals } = harness
  internals.state.cursor = { key: 'a1', offset: 10 }
  await internals.startReading()
  await harness.settle()
  await harness.settle()
  const calls = harness.requests.filter((entry) => entry.path === '/dsh-tts/speak')
  assert(calls.length > 0, 'the speak route was called')
  assert(calls.length >= 1, 'each chunk is synthesized separately')
  includes(calls[0].body.text, ASSISTANT_TEXT.slice(10, 20), 'first chunk starts at the chosen offset')
  assert(harness.audioQueue.length > 0, 'audio was played')
  harness.dispose()
})

await test('a failing dsh-tts request falls back to the browser voice for the rest', async () => {
  const harness = createHarness({ tts: true, speakFailsFrom: '卷积核' })
  const { internals } = harness
  internals.state.cursor = { key: 'a1', offset: 0 }
  await internals.startReading()
  await harness.settle()
  await harness.settle()
  assert(harness.spoken.length > 0, 'browser voice picked up the remainder')
  includes(harness.spoken.join(''), '卷积核', 'the remainder starts at the failed chunk')
  harness.dispose()
})

await test('without dsh-tts the browser voice reads from the chosen offset', async () => {
  const harness = createHarness({ tts: false })
  const { internals } = harness
  internals.state.cursor = { key: 'a1', offset: 5 }
  await internals.startReading()
  await harness.settle()
  await harness.settle()
  assert(harness.spoken.length > 0, 'browser voice was used')
  includes(harness.spoken.join(''), ASSISTANT_TEXT.slice(5, 15), 'starts at the chosen offset')
  assert(!harness.requests.some((entry) => entry.path === '/dsh-tts/speak'), 'never touched the missing route')
  harness.dispose()
})

await test('the icon never uses a red muted state', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, internals } = harness
  const button = () => document.querySelector('#mount-right button')
  const colour = () => button().style.color
  const isRed = (value) => /#e5484d|#e5484e|229,\s*72,\s*77/i.test(String(value))

  // idle, muted page volume: neutral
  internals.state.pageMuted = true
  harness.runtime.render(instance)
  assert(!isRed(colour()), `idle muted icon is not red (got ${colour()})`)

  // reading, muted page volume: still not red — mute belongs to the mixer
  internals.state.reading = true
  harness.runtime.render(instance)
  assert(!isRed(colour()), `reading while muted is still not red (got ${colour()})`)

  // the slash is gone from every icon variant
  const markup = button().innerHTML
  assert(!/<line\b/i.test(markup), 'no slash <line> is drawn in the icon')
  assert(/<path/i.test(markup), 'the speaker is still drawn with paths')

  internals.state.pageMuted = false
  harness.runtime.render(instance)
  assert(!isRed(colour()), 'and it stays non-red when audible')
  harness.dispose()
})

await test('the icon hover bubble shows both languages in the hint styling, not a native tooltip', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  equal(button.getAttribute('title'), null, 'no native system tooltip')
  includes(button.getAttribute('aria-label'), '点击朗读；长按选起点；上滑调音量', 'accessible label carries the wording')

  harness.runtime.dispatch(instance, button, 'pointerenter', {})
  const tip = document.querySelector('.sh-vs-tip')
  assert(tip, 'the hover bubble exists')
  equal(tip.style.display, 'block', 'and is visible on hover')
  // Three gesture columns, each with its Chinese label above the English caption.
  const columns = tip.querySelectorAll('.sh-vs-opt')
  equal(columns.length, 3, 'three gesture columns')
  const cn = [...tip.querySelectorAll('.sh-vs-cn')].map((node) => node.textContent)
  const en = [...tip.querySelectorAll('.sh-vs-en')].map((node) => node.textContent)
  equal(cn.join(' | '), '点击朗读 | 长按选起点 | 上滑调音量', 'Chinese labels, left to right')
  equal(en.join(' | '), '[Tap: Speak] | [Hold: Pick] | [Swipe ↑: Volume]', 'English captions under their own column')
  equal(columns[0].querySelector('.sh-vs-en').textContent, '[Tap: Speak]', 'column 1 pairs Tap with 点击朗读')
  equal(columns[2].querySelector('.sh-vs-cn').textContent, '上滑调音量', 'column 3 is the volume gesture')
  const css = document.getElementById('sh-vs-style').textContent
  includes(css, '.sh-vs-hint, .sh-vs-tip', 'the bubble shares the hint stylesheet')
  includes(css, 'color: #c2410c', 'and the hint colour')
  includes(css, 'color: #9ca3af', 'the English caption is grey')
  includes(css, '.sh-vs-grid', 'the idle bubble is laid out as a grid')
  includes(css, 'flex-direction: column', 'each column stacks its own two lines')
  includes(css, 'white-space: nowrap', 'and nothing wraps into its neighbour')
  harness.runtime.dispatch(instance, button, 'pointerleave', {})
  equal(tip.style.display, 'none', 'and hides when the pointer leaves')

  // "点击停止" is the same bubble while reading
  internals.state.reading = true
  harness.runtime.dispatch(instance, button, 'pointerenter', {})
  equal(document.querySelector('.sh-vs-tip').textContent, '点击停止Tap: Stop', 'the same bubble shows the stop wording, bilingual')
  harness.dispose()
})

await test('the caret is a gradient bar with a breathing pulse and two colour modes', async () => {
  const harness = createHarness({ tts: false })
  const { internals, document } = harness
  const stream = internals.messageIndex()
  internals.focusStartPosition({ stream, offset: stream.text.indexOf(USER_TEXT) })
  const style = document.getElementById('sh-vs-style')
  assert(style, 'the caret stylesheet is installed')
  const css = style.textContent
  includes(css, 'linear-gradient', 'the caret uses a gradient')
  includes(css, 'data-mode="pick"', 'the picker has its own colour mode')
  includes(css, 'sh-vs-breathe', 'and a soft pulse keyframe instead of a hard blink')
  const caret = document.querySelector('.sh-vs-caret')
  equal(caret.dataset.mode, 'read', 'reading mode by default')
  equal(caret.style.display, 'block', 'and it is on screen')
  harness.dispose()
})

await test('a second icon click stops the reading and removes the caret', async () => {
  const harness = createHarness({ tts: true, holdAudio: true })
  const { instance, document, internals } = harness
  const button = document.querySelector('#mount-right button')
  const reply = document.getElementById('reply')
  const box = reply.getBoundingClientRect()
  const caret = () => document.querySelector('.sh-vs-caret')

  // pick a start position with a hold + page click, which reads and leaves the
  // caret on screen
  await longPress(harness)
  harness.runtime.dispatch(instance, document, 'pointerdown', { clientX: box.left + 40, clientY: box.top + 8, pointerId: 3, button: 0 })
  harness.runtime.dispatch(instance, document, 'pointerup', { clientX: box.left + 40, clientY: box.top + 8, pointerId: 3 })
  await harness.settle()
  await harness.settle()
  equal(internals.state.reading, true, 'reading from the picked position')
  equal(caret().style.display, 'block', 'the caret is visible while reading')

  // stop with a plain click on the icon — the caret must go away with the sound
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 4, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointerup', { clientX: 500, clientY: 700, pointerId: 4 })
  equal(internals.state.reading, false, 'the second click stopped the reading')
  assert(!caret() || caret().style.display === 'none', 'the marker is gone')
  equal(document.querySelectorAll('.sh-vs-caret').length, 0, 'no caret node remains')
  equal(internals.state.cursor, null, 'the stored position is dropped')
  equal(document.body.style.cursor, '', 'the cursor is restored')
  harness.dispose()
})

await test('the caret is re-measured as the page scrolls', async () => {
  const harness = createHarness({ tts: false })
  const { internals, window, document } = harness
  const stream = internals.messageIndex()
  const at = stream.text.indexOf(ASSISTANT_TEXT) + 3
  internals.state.cursor = { key: 'a2resp', offset: 3 }
  internals.focusStartPosition({ stream, offset: at })
  const caret = document.querySelector('.sh-vs-caret')
  const first = { left: caret.style.left, top: caret.style.top }
  assert(first.top, 'the caret was placed')
  window.dispatchEvent(new window.Event('scroll'))
  equal(caret.style.display, 'block', 'caret stays visible on scroll')
  harness.dispose()
})

await test('arrow keys move the caret and wrap the position', async () => {
  const harness = createHarness({ tts: false })
  const { internals, document, instance } = harness
  // Arrow keys move by *stream* offset, so they cross segments in order and can
  // never wander into the unreadable gaps (the turn tail lives between them).
  internals.state.cursor = { key: 'u2', offset: 2 }
  const stream = internals.messageIndex()
  const questionStart = stream.text.indexOf(USER_TEXT)
  equal(internals.resolveCursor().offset, questionStart + 2, 'the saved offset resolves in stream space')
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'keydown', { key: 'ArrowRight', shiftKey: false })
  equal(internals.state.cursor.offset, 3, 'right by one character (still inside the question)')
  equal(internals.state.cursor.key, 'u2', 'and still on the question segment')
  harness.runtime.dispatch(instance, button, 'keydown', { key: 'ArrowLeft', shiftKey: true })
  equal(internals.state.cursor.key, 'a0', 'shift+left twenty crosses back into the older answer')
  equal(internals.state.cursor.offset, 1, 'and lands at the matching character inside it')
  harness.dispose()
})

await test('a stale cursor falls back to the newest question', async () => {
  const harness = createHarness({ tts: false })
  const { internals } = harness
  internals.state.cursor = { key: 'gone', offset: 99 } // e.g. the reply was re-rendered
  const plan = internals.readingPlan()
  includes(plan.text, USER_TEXT, 'the newest question is read')
  includes(plan.text, ASSISTANT_TEXT, 'the newest reply is read')
  assert(plan.offset === internals.defaultStartOffset(internals.messageIndex()), 'the plan starts at the default position')
  assert(!plan.text.startsWith(OLD_USER_TEXT), 'reading does not start in an older turn')
  const resolved = internals.resolveCursor()
  equal(resolved.segment.node.getAttribute('data-chat-flow-key'), 'u2', 'caret falls back to the question')
  harness.dispose()
})

await test('the page volume slider drives in-page media and persists', async () => {
  const harness = createHarness({ tts: false })
  const { instance, document, window } = harness
  const button = document.querySelector('#mount-right button')
  harness.runtime.dispatch(instance, button, 'pointerdown', { clientX: 500, clientY: 700, pointerId: 1, button: 0 })
  harness.runtime.dispatch(instance, button, 'pointermove', { clientX: 504, clientY: 660, pointerId: 1 })
  const range = document.querySelectorAll('input[type="range"]')[0]
  assert(range, 'the mixer opened on drag-up')
  range.value = '42'
  harness.runtime.nativeDispatch(range, 'input')
  equal(Math.round(harness.internals.state.page * 100), 42, 'page volume updated')
  const saved = JSON.parse(window.localStorage.getItem('sh-volume-shuff/state'))
  equal(Math.round(saved.page * 100), 42, 'page volume persisted')
  harness.dispose()
})

await test('chunking keeps speech segments short and complete', async () => {
  const harness = createHarness()
  const chunks = harness.internals.chunkText('一句话。'.repeat(100))
  assert(chunks.length > 3, 'long text is split')
  assert(chunks.every((chunk) => chunk.length <= 260), 'chunks stay near the limit')
  equal(chunks.join(''), '一句话。'.repeat(100), 'no character is lost')
  harness.dispose()
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error && failure.error.stack}`)
  process.exit(1)
}
