import { buildSnapshot, computeHeat, CUE_DIMENSIONS, estimateTokens, facetValues, recallByCue, renderRecordLine } from './engine.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    id: { type: 'string' },
    tier: { type: 'string' },
    recordStatus: { type: 'string' },
    summary: { type: 'string' },
    cue: { type: 'string' },
    suppliedDimensions: { type: 'array', items: { type: 'string' } },
    candidates: { type: 'array', items: { type: 'object' } },
    items: { type: 'array', items: { type: 'object' } },
    tokens: { type: 'object' },
    degraded: { type: 'string' },
    counts: { type: 'object' },
    top: { type: 'array', items: { type: 'object' } },
    lifecycle: { type: 'object' },
    continuity: { type: 'object' },
    error: { type: 'object' },
  },
}

const TEXT_OUTPUT = { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function stringList(value, max) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = cleanString(item)
    if (text && !out.includes(text)) out.push(text)
    if (max && out.length >= max) break
  }
  return out
}

function newId(store, hint) {
  const base = cleanString(hint).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 6)
    const id = base ? `m-${base}-${suffix}` : `m-${Date.now().toString(36)}-${suffix}`
    if (!store.has(id)) return id
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizefacets(args, config) {
  const cap = config.index.maxValuesPerDimension
  const occurred = {}
  if (cleanString(args.occurred_start)) occurred.start = cleanString(args.occurred_start)
  if (cleanString(args.occurred_end)) occurred.end = cleanString(args.occurred_end)
  occurred.precision = cleanString(args.occurred_precision) || 'unknown'
  return {
    types: stringList(args.types, cap),
    occurred_time: occurred,
    places: stringList(args.places, cap).map((name) => ({ name })),
    people: stringList(args.people, cap).map((name) => ({ name })),
    objects: stringList(args.objects, cap).map((name) => ({ name })),
    topics: stringList(args.topics, cap),
  }
}

/**
 * 注册记忆工具。返回已注册的工具名，供状态查询与自检使用。
 */
export function registerMemoryTools(ctx, options) {
  const { store, config, runLifecycle, recallState, archive, archiveIndex } = options

  /** 删除或更正后立即让召回缓存失效，符合「权限限制、更正和删除立即生效」。 */
  const invalidateRecall = (recordId) => {
    if (!recallState || !Array.isArray(recallState.items) || recallState.items.length === 0) return
    const before = recallState.items.length
    recallState.items = recallState.items.filter((item) => !item || !item.record || item.record.id !== recordId)
    if (recallState.items.length === before) return
    recallState.tokens = recallState.items.reduce((total, item) => total + estimateTokens(item.line) + 8, 0)
    if (recallState.items.length === 0) recallState.status = 'expired'
  }

  const definitions = [
    {
      name: 'memory_remember',
      description:
        '写入或更新一条陪伴记忆卡（带来源片段与维度索引）。用户明确要求记住、更正、或确认某事实时使用。同一事实重复提及只更新统计与摘要，不追加同义副本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', description: '给模型看的短摘要，保留说话方、否定词、时间与身份等限定。' },
          id: { type: 'string', description: '已有记忆的 id；提供时更新该条而不是新建。' },
          fact_key: { type: 'string', description: '可合并的事实键，例如 user.current_city；事件建议带日期避免误合并。' },
          topic_id: { type: 'string', description: '主题标识，用于每主题 2 条的注入上限。' },
          types: { type: 'array', items: { type: 'string' }, description: '类型维度，例如 preference / project / experience / fact。' },
          places: { type: 'array', items: { type: 'string' }, description: '地点名称。' },
          people: { type: 'array', items: { type: 'string' }, description: '人物名称。' },
          objects: { type: 'array', items: { type: 'string' }, description: '物品名称。' },
          topics: { type: 'array', items: { type: 'string' }, description: '话题标签。' },
          occurred_start: { type: 'string', description: '事件发生时间的起点（ISO 日期或更粗粒度）。' },
          occurred_end: { type: 'string', description: '事件发生时间的终点；单点事件可省略。' },
          occurred_precision: { type: 'string', enum: ['unknown', 'year', 'month', 'day'], description: '发生时间的精度；含糊时间不要写成精确年份。' },
          source_excerpt: { type: 'string', description: '用户原话片段，作为唯一可追溯来源。' },
          pinned: { type: 'boolean', description: '用户明确要求固定为长期事实。固定项有独立限额，最多 4 条。' },
          recall_only: { type: 'boolean', description: '用户要求「问到再说」：设为 true 会立即降为冷存。' },
          ongoing_until: { type: 'string', description: '进行中事项的复核期限；没有明确期限不要填。' },
          supersedes: { type: 'string', description: '被本条更正的旧记忆 id，旧条会被标记 superseded。' },
          mention: { type: 'boolean', description: '本次是否为用户的一次新的有效提及；省略视为是。助手复述、检索读取、定时任务都不算。' },
        },
        required: ['summary'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const summary = cleanString(args.summary)
        if (!summary) return fail('invalid_summary', 'summary 不能为空。')
        const excerpt = cleanString(args.source_excerpt)
        const existing = cleanString(args.id) ? store.get(cleanString(args.id)) : undefined
        const hasExistingSource = existing !== undefined && Array.isArray(existing.source_refs) && existing.source_refs.length > 0
        if (!excerpt && !hasExistingSource) {
          return fail('missing_source', '至少需要一个 source_excerpt 作为可追溯来源（模型生成的摘要必须保留原话证据）。')
        }
        const now = Date.now()
        const at = new Date(now).toISOString()
        const record = existing ?? {
          id: newId(store, args.topic_id || summary),
          owner_id: 'local-user',
          scope_id: 'companion',
          fact_key: cleanString(args.fact_key) || null,
          topic_id: cleanString(args.topic_id) || 'general',
          summary: '',
          source_refs: [],
          created_at: at,
          last_user_mention_at: at,
          mention_events: [],
          ongoing_until: null,
          pinned: false,
          recall_only: false,
          tier: 'hot',
          stage: 'detail',
          status: 'valid',
          supersedes: null,
          heat: null,
          heat_at: null,
        }

        record.summary = summary
        if (cleanString(args.fact_key)) record.fact_key = cleanString(args.fact_key)
        if (cleanString(args.topic_id)) record.topic_id = cleanString(args.topic_id)
        record.facets = normalizefacets(args, config)

        if (excerpt) {
          record.source_refs = [
            ...(Array.isArray(record.source_refs) ? record.source_refs : []),
            { event_id: `turn-${now.toString(36)}`, excerpt },
          ].slice(-8)
        }

        const supersedes = cleanString(args.supersedes)
        if (supersedes) {
          const previous = store.get(supersedes)
          if (previous) {
            previous.status = 'superseded'
            previous.tier = 'cold'
            previous.stage = 'cold'
            await store.put(previous)
          }
          record.supersedes = supersedes
        }

        if (args.pinned === true) {
          record.pinned = true
          record.tier = 'pinned'
          record.stage = 'detail'
        } else if (args.pinned === false) {
          record.pinned = false
          if (record.tier === 'pinned') record.tier = 'hot'
        }

        if (args.recall_only === true) {
          record.recall_only = true
          record.tier = 'cold'
          record.stage = 'cold'
        }

        if (cleanString(args.ongoing_until)) record.ongoing_until = cleanString(args.ongoing_until)

        if (args.mention !== false) {
          record.last_user_mention_at = at
          record.mention_events = [
            ...(Array.isArray(record.mention_events) ? record.mention_events : []),
            { interaction_id: `interaction-${now.toString(36)}`, occurred_at: at, kind: 'substantive' },
          ].slice(-200)
        }

        const computed = computeHeat(record, now, config.heat)
        record.heat = Number(computed.heat.toFixed(4))
        record.heat_at = at

        await store.put(record)
        await store.archive({
          at,
          memory_id: record.id,
          kind: 'memory_card',
          summary: record.summary,
          source_excerpt: excerpt || null,
        })
        runLifecycle()
        await store.saveState()

        return {
          ok: true,
          id: record.id,
          tier: record.tier,
          recordStatus: record.status,
          summary: record.summary,
          created: !existing,
          heat: record.heat,
          stage: record.stage,
          sourceRefs: record.source_refs.length,
        }
      },
    },

    {
      name: 'memory_recall',
      description:
        '按用户线索检索冷库，两条通道一起查：记忆卡（带维度索引、强精确匹配优先）与归档原文（词法 BM25，能看到原始对话片段）。只有用户明确给出人物、地点、时间、物品、话题或旧事件线索时才调用。返回 matched / ambiguous / not_found，并受 3 条 / 480 tokens 上限约束。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cue: { type: 'string', description: '用户给出的线索原话，保留其中的时间、地点、人物与物品词。' },
          limit: { type: 'integer', minimum: 1, maximum: 3, description: '最多返回几条，默认 3，也是上限而非配额。' },
        },
        required: ['cue'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const cue = cleanString(args.cue)
        if (!cue) return fail('missing_cue', 'cue 不能为空；没有用户线索就不要检索冷库。')
        runLifecycle()
        const now = Date.now()
        const limit = Math.max(1, Math.min(3, Number(args.limit) || config.selection.maxRecalledItemsPerRequest))

        // 通道 1：记忆卡（带 facets，强精确匹配优先）
        const cards = recallByCue(store, cue, config, now)

        // 通道 2：归档原文的词法检索（首次调用惰性建索引）
        let archiveResult = null
        if (archiveIndex && config.archiveIndex.enabled) {
          try {
            await archiveIndex.ensureFresh(store)
            archiveResult = archiveIndex.search(cue, limit)
          } catch (error) {
            archiveResult = null
          }
        }

        const budget = config.budgets.recalledTokens
        const merged = []
        let used = 0
        const push = (item) => {
          if (merged.length >= limit) return false
          if (used + item.cost > budget) return false
          used += item.cost
          merged.push(item)
          return true
        }

        for (const item of cards.items) {
          push({ source: 'card', record: item.record, line: item.line, strong: item.strong, cost: estimateTokens(item.line) + 8, id: item.record.id })
        }

        // 归档命中要同时满足「过了阈值」和「命中含稀有词」才当作已定位；
        // 否则只作为候选卡，让用户补一句线索（避免 confidently wrong）。
        const archiveBest = archiveResult ? archiveResult.bestScore : 0
        const archiveCoverage = archiveResult ? (archiveResult.bestCoverage ?? 0) : 0
        // 是否算"已定位"由索引层统一判定（稀有词 + 分数 + 覆盖 + 判别性线索）。
        const archiveStrong = Boolean(archiveResult && archiveResult.accepted)
        if (archiveStrong) {
          for (const item of archiveResult.items) {
            const atLabel = typeof item.at === 'string' ? item.at.slice(0, 10) : '未知日期'
            const who = item.speaker === 'user' ? '用户' : item.speaker === 'assistant' ? '助手' : String(item.speaker)
            const line = `- [${item.id}] ${who} ${atLabel}：${item.excerpt}`
            push({ source: 'archive', archive: item, line, strong: false, cost: estimateTokens(line) + 8, id: item.id })
          }
        }

        const candidates = [
          ...cards.candidates.map((c) => ({ source: 'card', ...c })),
          ...(archiveResult ? archiveResult.candidates.map((c) => ({ source: 'archive', ...c })) : []),
        ].slice(0, 12)

        let status = 'not_found'
        if (merged.length > 0) status = 'matched'
        else if (candidates.length > 0) status = 'ambiguous'

        recallState.at = now
        recallState.cue = cue
        recallState.status = status
        recallState.tokens = used
        recallState.degraded = archiveResult && archiveResult.degraded ? `archive_index_${archiveResult.degraded}` : cards.degraded
        recallState.items = merged

        return {
          ok: true,
          status,
          cue,
          suppliedDimensions: cards.supplied,
          items: merged.map((m) =>
            m.source === 'card'
              ? { source: 'card', id: m.id, summary: m.record.summary, tier: m.record.tier, matched: m.strong ? 'strong_exact' : 'ordinary', line: m.line }
              : { source: 'archive', id: m.id, speaker: m.archive.speaker, at: m.archive.at, score: m.archive.score, excerpt: m.archive.excerpt, line: m.line },
          ),
          candidates,
          channels: {
            cards: { status: cards.status, items: cards.items.length, candidates: cards.candidates.length },
            archive: archiveResult
              ? {
                  entries: archiveResult.scored,
                  items: archiveResult.items.length,
                  candidates: archiveResult.candidates.length,
                  bestScore: archiveBest,
                  bestCoverage: archiveCoverage,
                  minCoverage: config.archiveIndex.minCoverage,
                  hasLatinCue: archiveResult.hasLatinCue,
                  rareHit: archiveResult.rareHit,
                  accepted: archiveStrong,
                  ms: archiveResult.ms,
                  degraded: archiveResult.degraded,
                }
              : { enabled: false },
          },
          tokens: { used, budget },
          degraded: recallState.degraded,
          truncated: Boolean(cards.truncated),
          hint:
            status === 'matched'
              ? '只用这些已核验的条目接续对话，不要补充上下文里没有的细节。'
              : status === 'ambiguous'
                ? '命中多条或只命中弱相关，给用户极短候选让他补一句线索，不要猜。'
                : '未定位到，请如实说明并问一句补充线索；不要编造，也不要声称已想起来。',
        }
      },
    },

    {
      name: 'memory_forget',
      description:
        '管理一条记忆的状态：delete 明确删除（连原文归档一起清理）、supersede 更正并保留旧版本、recall_only 转为「问到再说」、unpin 取消固定、allow_normal 解除「问到再说」限制。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '目标记忆 id。' },
          mode: { type: 'string', enum: ['delete', 'supersede', 'recall_only', 'unpin', 'allow_normal'], description: '要执行的动作。' },
          superseded_by: { type: 'string', description: '更正后的新记忆 id，仅 supersede 使用。' },
          reason: { type: 'string', description: '操作依据的用户原话片段。' },
        },
        required: ['id', 'mode'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const id = cleanString(args.id)
        const mode = cleanString(args.mode)
        const record = store.get(id)
        if (!record) return fail('not_found', `没有 id 为 ${id} 的记忆。`)
        const at = new Date().toISOString()

        if (mode === 'delete') {
          await store.remove(id)
          const purged = await store.purgeArchive(id)
          invalidateRecall(id)
          runLifecycle()
          await store.saveState()
          return { ok: true, id, status: 'deleted', purgedArchiveEntries: purged, note: '原文与派生副本已清理，该条不再可召回。' }
        }

        if (mode === 'supersede') {
          record.status = 'superseded'
          record.tier = 'cold'
          record.stage = 'cold'
          record.superseded_at = at
          const replacement = cleanString(args.superseded_by)
          if (replacement) record.superseded_by = replacement
          await store.put(record)
          invalidateRecall(id)
          runLifecycle()
          await store.saveState()
          return { ok: true, id, status: 'superseded', superseded_by: replacement || null, note: '旧版本默认退出召回，历史关系保留。' }
        }

        if (mode === 'recall_only') {
          record.recall_only = true
          record.pinned = false
          record.tier = 'cold'
          record.stage = 'cold'
          await store.put(record)
          runLifecycle()
          await store.saveState()
          return { ok: true, id, status: 'recall_only', tier: 'cold', note: '该条优先于热度与进行中状态，只有用户线索能取回。' }
        }

        if (mode === 'allow_normal') {
          if (!cleanString(args.reason)) return fail('missing_reason', '解除「问到再说」需要用户明确解除限制的依据。')
          record.recall_only = false
          record.tier = 'hot'
          record.stage = 'detail'
          record.last_user_mention_at = at
          await store.put(record)
          runLifecycle()
          await store.saveState()
          return { ok: true, id, status: 'allow_normal', tier: record.tier, note: '限制已解除，按正常热度规则参与筛选；不会自动恢复固定。' }
        }

        if (mode === 'unpin') {
          record.pinned = false
          if (record.tier === 'pinned') record.tier = 'hot'
          await store.put(record)
          runLifecycle()
          await store.saveState()
          return { ok: true, id, status: 'unpinned', tier: record.tier }
        }

        return fail('invalid_mode', `不支持的 mode：${mode}`)
      },
    },

    {
      name: 'memory_continuity',
      description:
        '维护跨天的连续性状态：基础人格与当前相处状态。基础人格跨会话保留，当前状态缓慢变化且旧版本进历史档，不要在零点或重启时清空。用户明确要求重置时用 reset。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          base_persona: { type: 'string', description: '基础人格底色，长期保留，不随事件冷却。省略则保持不变。' },
          current_state: { type: 'string', description: '当前相处状态与近期语气的简短快照，受 320 tokens 子预算约束。' },
          note: { type: 'string', description: '变化依据的用户原话片段。' },
          reset: { type: 'boolean', description: '显式清空基础人格与当前相处状态，仅在用户明确要求重置时使用；省略时两者都保持不变。' },
        },
        required: [],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      async execute(args) {
        const entity = store.state.entity
        const at = new Date().toISOString()
        let changed = false
        let cleared = false
        if (cleanString(args.base_persona)) {
          entity.base_persona = cleanString(args.base_persona)
          changed = true
        }
        if (args.reset === true) {
          entity.base_persona = ''
          entity.current_state = ''
          entity.state_version = (entity.state_version ?? 1) + 1
          changed = true
          cleared = true
        } else if (cleanString(args.current_state)) {
          entity.current_state = cleanString(args.current_state)
          entity.state_version = (entity.state_version ?? 1) + 1
          changed = true
        }
        if (changed) {
          entity.updated_at = at
          await store.saveState()
          await store.archive({
            at,
            memory_id: 'state',
            kind: 'continuity_state',
            summary: cleared ? '(reset)' : entity.current_state,
            source_excerpt: cleanString(args.note) || null,
          })
        }
        return {
          ok: true,
          changed,
          cleared,
          continuity: {
            base_persona: entity.base_persona,
            current_state: entity.current_state,
            state_version: entity.state_version ?? 1,
            updated_at: entity.updated_at,
          },
          note: cleared
            ? '已重置：基础人格与当前相处状态都已清空，下次写入会重新建立。'
            : '基础人格不参加事件排序；当前状态不计入普通事件的 Top N 淘汰。',
        }
      },
    },

    {
      name: 'memory_archive',
      description:
        '全自动对话归档的管理入口：stats 查看归档量与会话分布，backfill 从会话日志回填历史轮次，purge 清理本插件的归档副本。归档只保存用户与助手的对话原文，工具结果与推理不入档。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['stats', 'backfill', 'purge'], description: '要执行的动作。' },
          session_id: { type: 'string', description: 'purge 时限定某个会话；与 before、all 三选一。' },
          before: { type: 'string', description: 'purge 时删除早于该 ISO 时间的归档条目。' },
          all: { type: 'boolean', description: 'purge 时清空整个归档，仅在用户明确要求时使用。' },
          reason: { type: 'string', description: 'purge 的用户依据原话。' },
          limit_per_session: {
            type: 'integer',
            minimum: 0,
            maximum: 100000,
            description: 'backfill 时每个会话回填的轮次上限，0 = 不限。',
          },
        },
        required: ['action'],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: (args) => Boolean(args) && args.action === 'stats',
      async execute(args) {
        if (!archive) return fail('archive_unavailable', '归档模块未启用。')
        const action = cleanString(args.action)
        if (action === 'stats') {
          const stats = await archive.stats()
          return {
            ok: true,
            ...stats,
            note: '归档保存每一轮用户与助手原文；工具结果、系统消息与推理不入档。',
          }
        }
        if (action === 'backfill') {
          return archive.backfill(args.limit_per_session)
        }
        if (action === 'purge') {
          if (!cleanString(args.reason)) {
            return fail('missing_reason', 'purge 需要用户明确要求清理的依据（reason）。')
          }
          return archive.purge({ session_id: args.session_id, before: args.before, all: args.all })
        }
        return fail('invalid_action', `不支持的 action：${action}`)
      },
    },

    {
      name: 'memory_status',
      description: '查看记忆分层状态：各层条目数、Top 热度、预算占用、固定事实超额与最近一次冷却结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          top: { type: 'integer', minimum: 1, maximum: 20, description: '按热度列出前几条，默认 8。' },
        },
        required: [],
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(args) {
        const report = runLifecycle()
        const now = Date.now()
        const snapshot = buildSnapshot(store, config, now)
        const counts = { total: store.size(), pinned: 0, hot: 0, cold: 0, superseded: 0 }
        for (const record of store.list()) {
          if (record.status === 'superseded') counts.superseded += 1
          if (record.status !== 'valid') continue
          if (record.pinned || record.tier === 'pinned') counts.pinned += 1
          else if (record.tier === 'hot') counts.hot += 1
          else counts.cold += 1
        }
        const topCount = Number.isSafeInteger(args.top) && args.top > 0 ? args.top : 8
        const top = store
          .list()
          .filter((record) => record.status === 'valid')
          .sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || (a.id < b.id ? -1 : 1))
          .slice(0, topCount)
          .map((record) => ({
            id: record.id,
            heat: record.heat ?? null,
            tier: record.tier,
            stage: record.stage ?? null,
            topic: record.topic_id ?? null,
            lastMention: record.last_user_mention_at ?? null,
            line: renderRecordLine(record, now),
          }))
        const fileStats = await store.stats()
        const cueDimensionsUsed = CUE_DIMENSIONS.filter((dimension) =>
          store.list().some((record) => record.status === 'valid' && facetValues(record, dimension).length > 0),
        )
        let indexStats = null
        if (archiveIndex && config.archiveIndex.enabled) {
          try {
            await archiveIndex.ensureFresh(store)
            indexStats = archiveIndex.stats()
          } catch {
            indexStats = null
          }
        }
        return {
          ok: true,
          counts,
          files: fileStats,
          tokens: snapshot.tokens,
          indexDimensionsInUse: cueDimensionsUsed,
          archiveIndex: indexStats,
          snapshot: {
            pinned: snapshot.pinned.map((item) => item.id),
            hot: snapshot.hot.map((item) => item.id),
            continuityVersion: snapshot.continuity.state_version,
          },
          lifecycle: {
            lastAt: store.state.last_lifecycle_at ? new Date(store.state.last_lifecycle_at).toISOString() : null,
            changes: report.changes.length,
            recentChanges: report.changes.slice(-10),
            hotPoolSize: report.hotPoolSize,
            hotPoolLimit: config.selection.maxHotPoolItems,
            pinOverflow: report.pinOverflow,
          },
          top,
          budgetMode: 'estimated',
          note: 'top 是上限不是配额；空槽位不会被不相关条目填满。',
        }
      },
    },
  ]

  const registered = []
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `companion-memory: ${definition.name}`)
    registered.push(definition.name)
  }
  return registered
}

export function estimateSnapshotTokens(snapshot) {
  return estimateTokens(JSON.stringify(snapshot))
}