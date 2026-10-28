/**
 * 冷热记忆引擎：纯计算，不碰 IO。
 * 数字与公式来自公开设计方案（policy / vector-ranking / continuity 三份配置）。
 */

const DEFAULT_CONFIG = Object.freeze({
  budgets: {
    memorySnapshotTokens: 1600,
    pinnedTokens: 160,
    hotTokens: 960,
    recalledTokens: 480,
    allowCrossBucketBorrowing: false,
  },
  selection: {
    maxPinnedItems: 4,
    maxHotPoolItems: 64,
    maxHotItemsPerRequest: 8,
    maxHotItemsPerTopic: 2,
    maxRecalledItemsPerRequest: 3,
    maxIndexCandidates: 12,
  },
  heat: {
    countingTimezone: 'Asia/Shanghai',
    frequencyWindowDays: 30,
    frequencySaturationCount: 6,
    maxMentionsPerFactPerDay: 3,
    recencyHalfLifeDays: 7,
    weights: { frequency: 0.45, recency: 0.35, ongoing: 0.2 },
  },
  lifecycle: {
    newMemoryHotCandidateDays: 7,
    demoteHeatBelow: 0.3,
    demoteInactiveAfterDays: 14,
    detailPreferredHours: 72,
    summaryEligibleMinHours: 24,
    ongoingReviewMaxDays: 30,
    coldPromotionWindowDays: 7,
    coldPromotionMinInteractions: 3,
    coldPromotionMinDistinctDates: 2,
  },
  index: { maxValuesPerDimension: 4 },
  archive: {
    backfillOnStart: false,
    backfillLimitPerSession: 0,
  },
  archiveIndex: {
    enabled: true,
    maxEntries: 50000,
    maxEntryTokens: 600,
    maxDfRatio: 0.35,
    rareDfRatio: 0.05,
    minScore: 0.32,
    minCoverage: 0.35,
    userWeight: 1.15,
    excerptChars: 90,
    maxCandidates: 12,
    recheckMs: 60000,
    k1: 1.4,
    b: 0.7,
  },
})

/** 归档词法索引的默认参数；archive-index.js 复用这一份，避免两处漂移。 */
export const ARCHIVE_INDEX_DEFAULTS = DEFAULT_CONFIG.archiveIndex

/** 线索可以切入的维度；顺序即候选卡展示顺序。 */
export const CUE_DIMENSIONS = ['types', 'occurred_time', 'places', 'people', 'objects', 'topics']

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const LATIN_PATTERN = /[A-Za-z0-9]/

export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const merge = (key) => ({ ...DEFAULT_CONFIG[key], ...(source[key] && typeof source[key] === 'object' ? source[key] : {}) })
  const heat = merge('heat')
  heat.weights = {
    ...DEFAULT_CONFIG.heat.weights,
    ...(source.heat && source.heat.weights && typeof source.heat.weights === 'object' ? source.heat.weights : {}),
  }
  return {
    budgets: merge('budgets'),
    selection: merge('selection'),
    heat,
    lifecycle: merge('lifecycle'),
    index: merge('index'),
    archive: merge('archive'),
    archiveIndex: merge('archiveIndex'),
  }
}

/**
 * 保守 token 估算（budget_mode = estimated）。
 * 中日韩字符按 1 字 1 token，拉丁数字按 4 字符 1 token，其余标点按 4 字符 1 token。
 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let latin = 0
  let other = 0
  for (const ch of String(text)) {
    if (CJK_PATTERN.test(ch)) cjk += 1
    else if (LATIN_PATTERN.test(ch)) latin += 1
    else other += 1
  }
  return Math.ceil(cjk + latin / 4 + other / 4)
}

/**
 * 词法 token 列表：拉丁词 + 中文二元组。
 * 保留重复项，供 BM25 计算词频；需要去重时用 tokenize()。
 */
export function tokenList(text) {
  const out = []
  if (!text) return out
  const lower = String(text).toLowerCase()
  const words = lower.match(/[a-z0-9]{2,}/g)
  if (words) out.push(...words)
  const runs = lower.match(/[\u3400-\u9fff\uf900-\ufaff]+/g)
  if (runs) {
    for (const run of runs) {
      if (run.length === 1) out.push(run)
      for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
    }
  }
  return out
}

/** 词法 token 集合：拉丁词 + 中文二元组，用作本地相似度的降级依据。 */
export function tokenize(text) {
  return new Set(tokenList(text))
}

/** 词法相似度（Jaccard）。方案要求无向量时使用统一的降级通道。 */
export function lexicalSimilarity(a, b) {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.size === 0 || right.size === 0) return 0
  let inter = 0
  for (const token of left) if (right.has(token)) inter += 1
  const union = left.size + right.size - inter
  return union > 0 ? inter / union : 0
}

export function dayKey(timestamp, timezone) {
  const date = new Date(timestamp)
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** 有效提及：同一交互最多一次、每日封顶、只保留窗口内的计分事件。 */
export function qualifyingMentions(record, now, heatConfig) {
  const windowDays = heatConfig.frequencyWindowDays
  const since = now - windowDays * 86400000
  const perInteraction = new Map()
  for (const mention of Array.isArray(record.mention_events) ? record.mention_events : []) {
    if (mention && mention.kind && mention.kind !== 'substantive') continue
    const at = Date.parse(mention && mention.occurred_at)
    if (!Number.isFinite(at) || at < since || at > now + 60000) continue
    const key = String(mention.interaction_id ?? at)
    if (!perInteraction.has(key)) perInteraction.set(key, at)
  }
  const perDay = new Map()
  let count = 0
  const ordered = [...perInteraction.values()].sort((a, b) => a - b)
  for (const at of ordered) {
    const key = dayKey(at, heatConfig.countingTimezone)
    const used = perDay.get(key) ?? 0
    if (used >= heatConfig.maxMentionsPerFactPerDay) continue
    perDay.set(key, used + 1)
    count += 1
  }
  return count
}

/** heat = 0.45*F + 0.35*R + 0.20*O */
export function computeHeat(record, now, heatConfig) {
  const mentions = qualifyingMentions(record, now, heatConfig)
  const frequency = Math.min(mentions / heatConfig.frequencySaturationCount, 1)
  const lastMention = Date.parse(record.last_user_mention_at ?? record.created_at)
  const days = Number.isFinite(lastMention) ? Math.max(0, (now - lastMention) / 86400000) : heatConfig.frequencyWindowDays * 2
  const recency = Math.pow(2, -days / heatConfig.recencyHalfLifeDays)
  const ongoingDeadline = Date.parse(record.ongoing_until)
  const ongoing = !record.recall_only && Number.isFinite(ongoingDeadline) && ongoingDeadline > now ? 1 : 0
  const weights = heatConfig.weights
  const heat = weights.frequency * frequency + weights.recency * recency + weights.ongoing * ongoing
  return { heat, frequency, recency, ongoing, mentions, daysSinceMention: days }
}

/** 取某个维度上的可匹配值。地点/人物/物品只取名称，不取机器层级 ID。 */
export function facetValues(record, dimension) {
  const facets = record && record.facets && typeof record.facets === 'object' ? record.facets : {}
  const raw = facets[dimension]
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) out.push(value.trim())
  }
  if (dimension === 'places' || dimension === 'people' || dimension === 'objects') {
    for (const item of Array.isArray(raw) ? raw : []) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object') push(item.name)
    }
  } else if (dimension === 'types' || dimension === 'topics') {
    for (const item of Array.isArray(raw) ? raw : []) push(item)
  } else if (dimension === 'occurred_time') {
    if (raw && typeof raw === 'object') {
      push(raw.start)
      push(raw.end)
      if (typeof raw.start === 'string' && raw.start.length >= 4) {
        push(raw.start.slice(0, 4))
        push(raw.start.slice(0, 7))
      }
    }
  }
  return out
}

/** 记录正文（摘要 + 全部维度值），用于本地相似度。 */
export function recordText(record) {
  const parts = [record.summary]
  for (const dimension of CUE_DIMENSIONS) parts.push(...facetValues(record, dimension))
  return parts.filter(Boolean).join(' ')
}

function matchedDimensions(record, cueTokens) {
  const matched = new Set()
  for (const dimension of CUE_DIMENSIONS) {
    for (const value of facetValues(record, dimension)) {
      const valueTokens = tokenize(value)
      if (valueTokens.size === 0) continue
      let hit = false
      for (const token of valueTokens) {
        if (cueTokens.has(token)) {
          hit = true
          break
        }
      }
      if (hit) {
        matched.add(dimension)
        break
      }
    }
  }
  return matched
}

/** 用户明确给出的原文片段是否唯一指向某条记录（≥6 字连续重合）。 */
function quoteHit(record, cueText) {
  const cue = String(cueText ?? '')
  if (cue.length < 6) return false
  for (const ref of Array.isArray(record.source_refs) ? record.source_refs : []) {
    const excerpt = ref && typeof ref.excerpt === 'string' ? ref.excerpt : ''
    for (let i = 0; i + 6 <= excerpt.length; i += 1) {
      if (cue.includes(excerpt.slice(i, i + 6))) return true
    }
  }
  return false
}

/**
 * 按用户线索检索冷库。
 * 冷召回分数 = 0.80*S + 0.20*C，不使用年代或最近提及的衰减。
 */
export function recallByCue(store, cueText, config, now) {
  const cue = String(cueText ?? '').trim()
  if (!cue) {
    return { status: 'disabled', reason: 'no_user_cue', items: [], candidates: [], tokens: 0, supplied: [] }
  }
  const cueTokens = tokenize(cue)
  const scoped = store.list().filter((record) => record && record.status === 'valid')
  const supplied = new Set()
  for (const record of scoped) {
    for (const dimension of matchedDimensions(record, cueTokens)) supplied.add(dimension)
  }
  const suppliedList = CUE_DIMENSIONS.filter((dimension) => supplied.has(dimension))
  const candidates = []
  for (const record of scoped) {
    const matched = matchedDimensions(record, cueTokens)
    const semantic = lexicalSimilarity(cue, recordText(record))
    const cueMatch = suppliedList.length > 0 ? matched.size / suppliedList.length : 0
    const matchScore = 0.8 * semantic + 0.2 * cueMatch
    const quote = quoteHit(record, cue)
    const strong = matched.size >= 2 || quote
    if (matchScore <= 0 && matched.size === 0 && !quote) continue
    candidates.push({ record, semantic, cueMatch, matchScore, matched: [...matched], strong, dimensionCount: matched.size })
  }
  candidates.sort((a, b) => {
    if (a.strong !== b.strong) return a.strong ? -1 : 1
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore
    return a.record.id < b.record.id ? -1 : 1
  })
  const fused = candidates.slice(0, config.selection.maxIndexCandidates)
  const maxItems = config.selection.maxRecalledItemsPerRequest
  const budget = config.budgets.recalledTokens
  const items = []
  let used = 0
  let truncated = false
  for (const candidate of fused) {
    if (items.length >= maxItems) {
      truncated = true
      break
    }
    const line = renderRecordLine(candidate.record, now, candidate.matchScore)
    const cost = estimateTokens(line) + 8
    if (used + cost > budget) {
      truncated = true
      continue
    }
    used += cost
    items.push({ record: candidate.record, line, matchScore: candidate.matchScore, strong: candidate.strong })
  }
  const ambiguous =
    items.length > 0 &&
    candidates.length > items.length &&
    candidates.length > 1 &&
    candidates[0].matchScore - candidates[Math.min(items.length, candidates.length - 1)].matchScore < 0.03
  return {
    status: items.length === 0 ? 'not_found' : ambiguous ? 'ambiguous' : 'matched',
    supplied: suppliedList,
    items,
    candidates: fused.map((candidate) => ({
      id: candidate.record.id,
      summary: candidate.record.summary,
      tier: candidate.record.tier,
      occurred: candidate.record.facets && candidate.record.facets.occurred_time ? candidate.record.facets.occurred_time : null,
      matchScore: Number(candidate.matchScore.toFixed(4)),
      strong: candidate.strong,
      matched: candidate.matched,
    })),
    tokens: used,
    truncated,
    degraded: 'lexical_fallback',
  }
}

/** 单条记忆的渲染行，供注入与预算计算共用。 */
export function renderRecordLine(record, now, score) {
  const parts = [`- [${record.id}] ${record.summary}`]
  const facets = record.facets && typeof record.facets === 'object' ? record.facets : {}
  const bits = []
  if (record.topic_id) bits.push(`主题 ${record.topic_id}`)
  if (facets.occurred_time && facets.occurred_time.start) bits.push(`发生 ${String(facets.occurred_time.start).slice(0, 10)}`)
  if (record.last_user_mention_at) bits.push(`最近提及 ${String(record.last_user_mention_at).slice(0, 10)}`)
  if (typeof record.heat === 'number') bits.push(`热度 ${record.heat.toFixed(2)}`)
  if (typeof score === 'number') bits.push(`匹配 ${score.toFixed(2)}`)
  if (record.ongoing_until) bits.push(`进行中至 ${String(record.ongoing_until).slice(0, 10)}`)
  if (record.recall_only) bits.push('问到再说')
  if (bits.length > 0) parts.push(`（${bits.join('｜')}）`)
  return parts.join('')
}

/**
 * 生命周期：惰性求值、不在零点重置。
 * 细节 → 摘要 → 冷库；冷库按近 7 天 ≥3 次独立交互且 ≥2 个日期重新升温。
 */
export function lifecyclePass(store, config, now) {
  const changes = []
  const { lifecycle, heat: heatConfig } = config
  for (const record of store.list()) {
    if (!record || record.status !== 'valid') continue
    const computed = computeHeat(record, now, heatConfig)
    record.heat = Number(computed.heat.toFixed(4))
    record.heat_at = new Date(now).toISOString()
    if (record.pinned || record.tier === 'pinned') {
      record.stage = 'detail'
      continue
    }
    if (record.recall_only) {
      if (record.tier !== 'cold') {
        changes.push({ id: record.id, from: record.tier, to: 'cold', reason: 'recall_only' })
        record.tier = 'cold'
      }
      record.stage = 'cold'
      continue
    }
    const lastMention = Date.parse(record.last_user_mention_at ?? record.created_at)
    const hours = Number.isFinite(lastMention) ? Math.max(0, (now - lastMention) / 3600000) : Number.POSITIVE_INFINITY
    const createdAt = Date.parse(record.created_at)
    const ageDays = Number.isFinite(createdAt) ? (now - createdAt) / 86400000 : 0
    const ongoingDeadline = Date.parse(record.ongoing_until)
    const ongoingActive = Number.isFinite(ongoingDeadline) && ongoingDeadline > now

    if (record.tier === 'cold') {
      const since = now - lifecycle.coldPromotionWindowDays * 86400000
      const recent = (Array.isArray(record.mention_events) ? record.mention_events : []).filter((mention) => {
        const at = Date.parse(mention && mention.occurred_at)
        return Number.isFinite(at) && at >= since
      })
      const interactions = new Set(recent.map((mention) => String(mention.interaction_id))).size
      const dates = new Set(recent.map((mention) => dayKey(Date.parse(mention.occurred_at), heatConfig.countingTimezone))).size
      if (
        interactions >= lifecycle.coldPromotionMinInteractions &&
        dates >= lifecycle.coldPromotionMinDistinctDates
      ) {
        record.tier = 'hot'
        record.stage = hours < lifecycle.detailPreferredHours ? 'detail' : 'summary'
        changes.push({ id: record.id, from: 'cold', to: 'hot', reason: 'repeated_user_mention' })
      }
      continue
    }

    if (hours < lifecycle.detailPreferredHours) record.stage = 'detail'
    else if (record.summary && hours >= lifecycle.summaryEligibleMinHours) record.stage = 'summary'
    else record.stage = 'detail'

    const coldEligible =
      ageDays >= lifecycle.newMemoryHotCandidateDays &&
      !ongoingActive &&
      record.stage === 'summary' &&
      (computed.heat < lifecycle.demoteHeatBelow || hours > lifecycle.demoteInactiveAfterDays * 24)
    if (coldEligible) {
      record.tier = 'cold'
      record.stage = 'cold'
      changes.push({
        id: record.id,
        from: 'hot',
        to: 'cold',
        reason: computed.heat < lifecycle.demoteHeatBelow ? 'low_heat' : 'inactive',
      })
    }
  }

  // 活跃池容量：超出上限时先淘汰热度最低的普通事件。
  const hotRecords = store.list().filter((record) => record.status === 'valid' && !record.pinned && record.tier === 'hot' && !record.recall_only)
  if (hotRecords.length > config.selection.maxHotPoolItems) {
    hotRecords.sort((a, b) => (a.heat ?? 0) - (b.heat ?? 0) || (a.id < b.id ? -1 : 1))
    const overflow = hotRecords.slice(0, hotRecords.length - config.selection.maxHotPoolItems)
    for (const record of overflow) {
      record.tier = 'cold'
      record.stage = 'cold'
      changes.push({ id: record.id, from: 'hot', to: 'cold', reason: 'capacity_eviction' })
    }
  }

  // 固定事实超额：报告缺口，不能静默丢弃已固定项。
  const pinnedRecords = store
    .list()
    .filter((record) => record.status === 'valid' && (record.pinned || record.tier === 'pinned'))
    .sort((a, b) => lastMentionOf(a) - lastMentionOf(b) || (a.id < b.id ? -1 : 1))
  const pinOverflow = pinnedRecords.slice(config.selection.maxPinnedItems).map((record) => record.id)
  store.state.pin_overflow = pinOverflow
  store.state.last_lifecycle_at = now
  return { changes, pinOverflow, hotPoolSize: hotRecords.length }
}

function lastMentionOf(record) {
  const at = Date.parse(record.last_user_mention_at ?? record.created_at)
  return Number.isFinite(at) ? at : 0
}

function priorityOf(record) {
  if (record.recall_only) return -1
  const deadline = Date.parse(record.ongoing_until)
  if (Number.isFinite(deadline) && deadline > Date.now()) return 2
  return record.pinned ? 1 : 0
}

/**
 * 构建本轮记忆快照：固定事实 160 / 活跃 960（含连续性状态）/ 临时召回 480，互不借用。
 * 上限是天花板不是配额，不相关条目不会被塞进来凑数。
 */
export function buildSnapshot(store, config, now) {
  const records = store.list().filter((record) => record && record.status === 'valid')
  for (const record of records) {
    if (typeof record.heat !== 'number') record.heat = Number(computeHeat(record, now, config.heat).heat.toFixed(4))
  }
  const entity = store.state.entity
  const continuityText = entity.current_state ? `当前相处状态：${entity.current_state}` : ''
  const continuityTokens = estimateTokens(continuityText)

  const pinnedPool = records
    .filter((record) => record.pinned || record.tier === 'pinned')
    .sort((a, b) => lastMentionOf(a) - lastMentionOf(b) || (a.id < b.id ? -1 : 1))
  const pinned = []
  let pinnedTokens = 0
  for (const record of pinnedPool) {
    if (pinned.length >= config.selection.maxPinnedItems) break
    const line = renderRecordLine(record, now)
    const cost = estimateTokens(line) + 8
    if (pinnedTokens + cost > config.budgets.pinnedTokens) break
    pinnedTokens += cost
    pinned.push({ id: record.id, line, tier: record.tier })
  }

  const hotPool = records
    .filter((record) => !(record.pinned || record.tier === 'pinned') && record.tier === 'hot' && !record.recall_only)
    .sort((a, b) => {
      const priority = priorityOf(b) - priorityOf(a)
      if (priority !== 0) return priority
      if ((b.heat ?? 0) !== (a.heat ?? 0)) return (b.heat ?? 0) - (a.heat ?? 0)
      if (lastMentionOf(b) !== lastMentionOf(a)) return lastMentionOf(b) - lastMentionOf(a)
      return a.id < b.id ? -1 : 1
    })
  const hot = []
  const perTopic = new Map()
  let hotTokens = continuityTokens
  const hotBudget = config.budgets.hotTokens
  for (const record of hotPool) {
    if (hot.length >= config.selection.maxHotItemsPerRequest) break
    const topic = record.topic_id || '(none)'
    const used = perTopic.get(topic) ?? 0
    if (used >= config.selection.maxHotItemsPerTopic) continue
    const line = renderRecordLine(record, now)
    const cost = estimateTokens(line) + 8
    if (hotTokens + cost > hotBudget) break
    hotTokens += cost
    perTopic.set(topic, used + 1)
    hot.push({ id: record.id, line, tier: record.tier, heat: record.heat, topic })
  }

  return {
    continuity: {
      base_persona: entity.base_persona || '',
      current_state: entity.current_state || '',
      state_version: entity.state_version ?? 1,
      updated_at: entity.updated_at ?? null,
    },
    pinned,
    hot,
    tokens: {
      mode: 'estimated',
      pinned: pinnedTokens,
      hot: hotTokens,
      continuity: continuityTokens,
      budgets: {
        pinned: config.budgets.pinnedTokens,
        hot: hotBudget,
        recalled: config.budgets.recalledTokens,
        snapshot: config.budgets.memorySnapshotTokens,
      },
    },
    overflow: { pinned: store.state.pin_overflow ?? [], pinnedTotal: pinnedPool.length },
  }
}