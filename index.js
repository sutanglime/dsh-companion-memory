/**
 * dsh-companion-memory —— 陪伴 AI 的冷热分层记忆。
 *
 * 每轮把「连续性状态 + 固定事实 + 相关活跃记忆」作为有预算上限的记忆快照注入上下文，
 * 旧事只有用户给出线索时才通过 memory_recall 从冷库取回。
 */
import { advanceCursor, deriveTurnEntry, fillCursor } from './lib/archive.js'
import { ArchiveIndex } from './lib/archive-index.js'
import { buildSnapshot, estimateTokens, lifecyclePass, resolveConfig } from './lib/engine.js'
import { CONTEXT_ORDER, POLICY_SECTION_NAME, SNAPSHOT_CONTEXT_NAME, SECTION_ORDER, policyText, renderSnapshotText } from './lib/render.js'
import { MemoryStore, resolveDataDir } from './lib/store.js'
import { registerMemoryTools } from './lib/tools.js'

export const name = 'companion-memory'
export const inject = ['tools']

/** 生命周期惰性求值的最小间隔，避免每轮都对全库重算热度。 */
const LIFECYCLE_THROTTLE_MS = 60 * 1000

function warn(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  } catch {
    // 日志失败不影响插件功能。
  }
}

export async function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const dataDir = resolveDataDir(config)
  const store = new MemoryStore(dataDir)
  try {
    await store.load()
  } catch (error) {
    warn(ctx, `dsh-companion-memory: 读取 ${dataDir} 失败，将从空记忆继续：${error && error.message ? error.message : String(error)}`)
  }

  const archiveIndex = new ArchiveIndex(resolved.archiveIndex)
  const recallState = { at: 0, cue: '', status: 'not_run', tokens: 0, degraded: 'lexical_fallback', items: [] }
  let lastLifecycleAt = 0
  let persistQueue = Promise.resolve()

  /**
   * 召回缓存必须在渲染前对齐当前存储：删除、更正（supersede）或外部改动
   * 都要立即从后续请求里移除，不能靠有效期到期才失效。
   */
  const liveRecall = () => {
    if (!Array.isArray(recallState.items) || recallState.items.length === 0) return null
    const alive = recallState.items.filter((item) => {
      if (!item) return false
      // 记忆卡条目：按卡片的有效性判断。
      if (item.record && item.record.id) {
        const record = store.get(item.record.id)
        return record !== undefined && record.status === 'valid'
      }
      // 归档条目：按索引里是否还在判断（契约/删除后立即失效）。
      if (item.source === 'archive') return archiveIndex.byId.has(item.id)
      return false
    })
    if (alive.length === 0) {
      recallState.items = []
      recallState.status = 'expired'
      return null
    }
    if (alive.length !== recallState.items.length) {
      recallState.items = alive
      recallState.tokens = alive.reduce((total, item) => total + estimateTokens(item.line) + 8, 0)
    }
    return { ...recallState, items: alive }
  }

  const persist = () => {
    persistQueue = persistQueue
      .then(() => Promise.all([store.saveRecords(), store.saveState()]))
      .catch((error) => {
        warn(ctx, `dsh-companion-memory: 写入记忆失败：${error && error.message ? error.message : String(error)}`)
      })
    return persistQueue
  }

  const runLifecycle = (force) => {
    const now = Date.now()
    if (!force && now - lastLifecycleAt < LIFECYCLE_THROTTLE_MS) {
      return { changes: [], pinOverflow: store.state.pin_overflow ?? [], hotPoolSize: 0, throttled: true }
    }
    lastLifecycleAt = now
    try {
      const report = lifecyclePass(store, resolved, now)
      if (report.changes.length > 0) void persist()
      return report
    } catch (error) {
      warn(ctx, `dsh-companion-memory: 生命周期计算失败：${error && error.message ? error.message : String(error)}`)
      return { changes: [], pinOverflow: [], hotPoolSize: 0, failed: true }
    }
  }

  let archiveQueue = Promise.resolve()
  const archiveWatermark = (sessionId) => (store.state.archive_watermarks ?? {})[sessionId] ?? -1

  /**
   * 串行写入归档。水位线在写入成功之后才推进，避免一次失败让这一轮永久丢失；
   * 同会话靠 seq 去重，重复事件直接跳过。
   */
  const enqueueTurn = (entry) => {
    archiveQueue = archiveQueue
      .then(async () => {
        if (entry.seq <= archiveWatermark(entry.session_id)) return null
        await store.archiveTurn(entry)
        store.state.archive_watermarks = { ...(store.state.archive_watermarks ?? {}), [entry.session_id]: entry.seq }
        await store.saveState()
        archiveIndex.addEntry(entry)
        return entry
      })
      .catch((error) => {
        warn(ctx, `dsh-companion-memory: 归档写入失败（seq ${entry.seq}）：${error && error.message ? error.message : String(error)}`)
        return null
      })
    return archiveQueue
  }

  /** 从会话日志回填历史轮次；按 (session_id, seq) 幂等。 */
  const runBackfill = async (limitPerSession) => {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
      return { ok: false, error: 'sessionQuery 服务不可用，无法回填历史会话。' }
    }
    const cap = Number.isSafeInteger(limitPerSession) && limitPerSession > 0 ? limitPerSession : 0
    const records = await query.listSessions()
    let archived = 0
    let sessionsArchived = 0
    let unreadable = 0
    for (const record of records) {
      const id = String(record.header.id)
      let snapshot = null
      try {
        snapshot = await query.readSession(record.header.id)
      } catch {
        unreadable += 1
        continue
      }
      let last = archiveWatermark(id)
      let count = 0
      const cursor = { turn: null, step: null }
      for (const event of snapshot.events ?? []) {
        advanceCursor(cursor, event)
        if (cap > 0 && count >= cap) break
        let entry = null
        try {
          entry = deriveTurnEntry(event, null)
        } catch {
          entry = null
        }
        if (!entry) continue
        fillCursor(entry, cursor)
        if (entry.seq <= last) continue
        entry.session_id = id
        try {
          await store.archiveTurn(entry)
          archiveIndex.addEntry(entry)
        } catch (error) {
          warn(ctx, `dsh-companion-memory: 回填写入失败（${id} seq ${entry.seq}）：${error && error.message ? error.message : String(error)}`)
          break
        }
        last = entry.seq
        count += 1
      }
      if (count > 0) {
        store.state.archive_watermarks = { ...(store.state.archive_watermarks ?? {}), [id]: last }
        archived += count
        sessionsArchived += 1
      }
    }
    await store.saveState()
    return { ok: true, sessionsScanned: records.length, sessionsArchived, turnsArchived: archived, unreadableSessions: unreadable }
  }

  /** 清理本插件自己的归档副本（不触碰 harness 的会话日志）。 */
  const purgeArchiveRange = async (options) => {
    const sessionId = options && typeof options.session_id === 'string' ? options.session_id.trim() : ''
    const before = options && typeof options.before === 'string' ? options.before.trim() : ''
    const all = options && options.all === true
    if (!all && !sessionId && !before) {
      return { ok: false, error: 'purge 需要 session_id、before 或 all 之一。' }
    }
    const removed = await store.purgeArchiveWhere((entry) => {
      if (all) return true
      if (sessionId && String(entry.session_id ?? '') === sessionId) return true
      if (before && typeof entry.at === 'string' && entry.at < before) return true
      return false
    })
    // 归档变了，索引必须跟着失效，否则会召回已删除的原文。
    if (removed > 0) archiveIndex.clear()
    if (sessionId || all) {
      const watermarks = { ...(store.state.archive_watermarks ?? {}) }
      if (all) store.state.archive_watermarks = {}
      else delete watermarks[sessionId]
      if (!all) store.state.archive_watermarks = watermarks
      await store.saveState()
    }
    return {
      ok: true,
      removed,
      note: '只清理本插件归档的副本；DSH 会话日志本身由 harness 的保留策略管理，本插件无法删除。',
    }
  }

  const archiveApi = {
    stats: () => store.archiveStats(),
    backfill: (limitPerSession) => runBackfill(limitPerSession),
    purge: (options) => purgeArchiveRange(options),
  }

  registerMemoryTools(ctx, { store, config: resolved, runLifecycle, recallState, archive: archiveApi, archiveIndex })

  // 全自动对话归档：订阅提交后的事件流，只取对话轮次。
  const cursors = new Map()
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || session.id === undefined || !event || typeof event !== 'object') return
      const sessionId = String(session.id)
      const cursor = cursors.get(sessionId) ?? { turn: null, step: null }
      cursors.set(sessionId, cursor)
      advanceCursor(cursor, event)
      const entry = deriveTurnEntry(event, session)
      if (!entry) return
      fillCursor(entry, cursor)
      void enqueueTurn(entry)
    } catch (error) {
      warn(ctx, `dsh-companion-memory: 归档事件处理失败：${error && error.message ? error.message : String(error)}`)
    }
  })

  if (resolved.archive.backfillOnStart) {
    void runBackfill(resolved.archive.backfillLimitPerSession).then(
      (result) => {
        if (result && result.ok && result.turnsArchived > 0) {
          warn(ctx, `dsh-companion-memory: 启动回填完成，归档 ${result.turnsArchived} 轮（${result.sessionsArchived} 个会话）。`)
        }
      },
      (error) => warn(ctx, `dsh-companion-memory: 启动回填失败：${error && error.message ? error.message : String(error)}`),
    )
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: POLICY_SECTION_NAME,
          order: SECTION_ORDER,
          interpolate: false,
          text: () => policyText(),
        }),
      'companion-memory: policy section',
    )

    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.context({
          name: SNAPSHOT_CONTEXT_NAME,
          order: CONTEXT_ORDER,
          text: () => {
            const now = Date.now()
            runLifecycle(false)
            const snapshot = buildSnapshot(store, resolved, now)
            return renderSnapshotText(snapshot, liveRecall(), now)
          },
        }),
      'companion-memory: snapshot context',
    )
  })

  ctx.effect(
    () => () => {
      void persist()
      void archiveQueue
    },
    'companion-memory: flush',
  )

  const stats = await store.stats().catch(() => ({ records: store.size(), archiveEntries: 0 }))
  warn(
    ctx,
    `dsh-companion-memory: 已就绪；记忆卡 ${stats.records} 条，归档 ${stats.archiveEntries} 条，数据目录 ${dataDir}，对话归档已开启，预算模式 estimated。`,
  )
}