/**
 * 全自动对话归档：订阅 Session 的提交后事件流，把每一轮用户与助手原文留底。
 *
 * 依据：
 * - `session/event` 是「post-commit, fire-and-forget append feed」，拿到的是已落盘的原始事件。
 * - `SessionEventMap` 里 `user/message` 的 data 就是 UserMessage，
 *   `assistant/message` 的 data 含 message / stream / usage / interrupted。
 * - 正文还原优先用 Session 自带的 `deriveEventMessage(event)`（方法在实例上，无需额外依赖），
 *   失败时退回事件 data 本身并用容错的正文块读取（content / blocks / parts 三种命名都试）。
 */

/** 只归档真正的对话轮次；工具结果、系统消息与推理不进入用户记忆。 */
export const ARCHIVED_EVENT_TYPES = ['user/message', 'assistant/message']

/**
 * harness 会把运行时上下文、时间戳与注入块作为 user 消息拼进模型请求。
 * 它们出现在日志里，但不是用户说的话，必须标记出来，避免被当成用户事实。
 * 这是启发式判断，标记本身也写进归档供后续核对。
 */
export const SYSTEM_CONTEXT_MARKERS = [
  'Current runtime context.',
  'Time sampled while preparing',
  '【陪伴记忆快照】',
  '【陪伴记忆策略',
]

export function looksLikeInjectedContext(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const head = text.slice(0, 240)
  return SYSTEM_CONTEXT_MARKERS.some((marker) => head.includes(marker))
}

/** 用 turn/start 与 step/start 维护当前进度，让 user 消息也能带上 turn/step。 */
export function advanceCursor(cursor, event) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}
  if (event && event.type === 'turn/start' && typeof data.turn === 'number') {
    cursor.turn = data.turn
    cursor.step = null
  } else if (event && event.type === 'step/start') {
    if (typeof data.turn === 'number') cursor.turn = data.turn
    if (typeof data.step === 'number') cursor.step = data.step
  }
  return cursor
}

export function fillCursor(entry, cursor) {
  if (!entry || !cursor) return entry
  if (entry.turn === null && cursor.turn !== null) entry.turn = cursor.turn
  if (entry.step === null && cursor.step !== null) entry.step = cursor.step
  return entry
}

function blocksOf(message) {
  if (!message || typeof message !== 'object') return []
  for (const key of ['content', 'blocks', 'parts']) {
    if (Array.isArray(message[key])) return message[key]
  }
  return []
}

/** 从一条消息里取出可见正文。 */
export function messageText(message) {
  const blocks = blocksOf(message)
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function toolCallNames(message) {
  const names = []
  for (const block of blocksOf(message)) {
    if (block && block.type === 'tool-call' && typeof block.name === 'string' && block.name) names.push(block.name)
  }
  return names
}

function surfaceOpOf(event) {
  const op = event && event.surfaceOp
  if (typeof op === 'string') return op
  if (op && typeof op === 'object' && typeof op.op === 'string') return op.op
  return null
}

/**
 * 把一个 Session 事件折算成一条归档记录；不是对话事件（或没有可见内容）时返回 null。
 * session 可为 null（回填时不需要实例）。
 */
export function deriveTurnEntry(event, session) {
  if (!event || typeof event !== 'object') return null
  if (!ARCHIVED_EVENT_TYPES.includes(event.type)) return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}

  let message = null
  try {
    if (session && typeof session.deriveEventMessage === 'function') message = session.deriveEventMessage(event)
  } catch {
    message = null
  }
  if (!message) message = data.message ?? data

  const text = messageText(message)
  const toolCalls = toolCallNames(message)
  if (!text && toolCalls.length === 0) return null

  const sessionId = session && session.id !== undefined ? String(session.id) : null
  const seq = Number(event.seq)
  if (!Number.isFinite(seq)) return null

  return {
    kind: 'turn',
    session_id: sessionId,
    seq,
    at: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
    turn: typeof data.turn === 'number' ? data.turn : null,
    step: typeof data.step === 'number' ? data.step : null,
    speaker: event.type === 'user/message' ? 'user' : 'assistant',
    text,
    system_context: looksLikeInjectedContext(text),
    tool_calls: toolCalls,
    interrupted: data.interrupted === true,
    surface_op: surfaceOpOf(event),
    source_seqs: Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.map(Number) : [],
    usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
    memory_id: null,
  }
}