/**
 * 归档词法索引：把 archive.jsonl 里的对话原文建成内存倒排表，供线索召回。
 *
 * 为什么是词法而不是向量：见 README「已知边界」。这里用 BM25 + IDF，
 * 让「硅基流动」「npm」这类稀有词压过「插件」「视频」这类泛词；
 * 排序**不使用**时间或新近衰减（方案硬性要求：旧事不因年头久被压下去）。
 *
 * 该模块只做内存计算，不写盘：索引里含原文 token，落盘等于多一份隐私副本。
 */
import { stat } from 'node:fs/promises'

import { ARCHIVE_INDEX_DEFAULTS, tokenList } from './engine.js'

function excerptOf(text, cueTokens, width) {
  if (!text) return ''
  const lower = text.toLowerCase()
  let best = -1
  for (const token of cueTokens) {
    const at = lower.indexOf(token)
    if (at >= 0 && (best < 0 || at < best)) best = at
  }
  if (best < 0) {
    return text.length > width * 2 ? `${text.slice(0, width * 2)}…` : text
  }
  const start = Math.max(0, best - width)
  const end = Math.min(text.length, best + width)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export class ArchiveIndex {
  constructor(rawConfig) {
    const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
    this.config = { ...ARCHIVE_INDEX_DEFAULTS, ...source }
    this.entries = []
    this.postings = new Map()
    this.byId = new Map()
    this.totalTokens = 0
    this.degraded = null
    this.builtOnce = false
    this.builtAt = 0
    this.lastCheckAt = 0
    this.lastFileBytes = -1
  }

  get size() {
    return this.entries.length
  }

  clear() {
    this.entries = []
    this.postings = new Map()
    this.byId = new Map()
    this.totalTokens = 0
    this.degraded = null
    this.builtOnce = false
    this.builtAt = 0
    this.lastFileBytes = -1
  }

  /**
   * 把一条归档记录加入索引。返回是否真的加入。
   * 只收对话轮次，明确排除 harness 注入的运行时上下文与空正文。
   */
  addEntry(entry) {
    if (!this.config.enabled) return false
    if (!entry || entry.kind !== 'turn') return false
    if (entry.system_context === true) return false
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!text) return false
    const id = `${entry.session_id ?? '?'}#${entry.seq ?? '?'}`
    if (this.byId.has(id)) return false
    if (this.entries.length >= this.config.maxEntries) {
      if (this.degraded === null) this.degraded = 'max_entries'
      return false
    }
    const tokens = tokenList(text).slice(0, this.config.maxEntryTokens)
    if (tokens.length === 0) return false

    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)

    const idx = this.entries.length
    this.entries.push({
      idx,
      id,
      session_id: entry.session_id ?? null,
      seq: entry.seq ?? null,
      at: entry.at ?? null,
      speaker: entry.speaker ?? 'unknown',
      text,
      len: tokens.length,
      tf,
    })
    this.byId.set(id, idx)
    for (const token of tf.keys()) {
      let list = this.postings.get(token)
      if (!list) {
        list = []
        this.postings.set(token, list)
      }
      list.push(idx)
    }
    this.totalTokens += tokens.length
    return true
  }

  /** 全量重建。归档只有几 MB 时是几十毫秒的量级。 */
  async rebuild(store) {
    this.clear()
    let lines = []
    try {
      lines = await store.readArchiveLines()
    } catch {
      lines = []
    }
    for (const entry of lines) this.addEntry(entry)
    this.builtOnce = true
    this.builtAt = Date.now()
    this.lastCheckAt = this.builtAt
    try {
      this.lastFileBytes = (await stat(store.archivePath)).size
    } catch {
      this.lastFileBytes = -1
    }
    return this.entries.length
  }

  /**
   * 惰性保鲜：首次调用做全量构建；之后按间隔检查归档文件大小，
   * 变了才重建。运行期新增的轮次由 addEntry 增量加入，不需要走这里。
   */
  async ensureFresh(store) {
    if (!this.config.enabled) return { rebuilt: false, skipped: 'disabled' }
    if (!this.builtOnce) {
      const entries = await this.rebuild(store)
      return { rebuilt: true, entries }
    }
    const now = Date.now()
    if (now - this.lastCheckAt < this.config.recheckMs) return { rebuilt: false }
    this.lastCheckAt = now
    let bytes = -1
    try {
      bytes = (await stat(store.archivePath)).size
    } catch {
      bytes = -1
    }
    if (bytes !== this.lastFileBytes) {
      const entries = await this.rebuild(store)
      return { rebuilt: true, entries }
    }
    return { rebuilt: false }
  }

  /**
   * 按线索打分。BM25 + IDF；不读时间字段，因此不惩罚年代。
   * 返回 items（达到阈值的前 limit 条）与 candidates（候选卡，含弱命中）。
   */
  search(cue, limit = 3) {
    const started = Date.now()
    const result = {
      enabled: this.config.enabled,
      items: [],
      candidates: [],
      bestScore: 0,
      bestCoverage: 0,
      hasLatinCue: false,
      accepted: false,
      rareHit: false,
      scored: this.entries.length,
      degraded: this.degraded,
      ms: 0,
    }
    if (!this.config.enabled) {
      result.degraded = 'disabled'
      return result
    }
    const cueTokens = [...new Set(tokenList(cue))]
    const total = this.entries.length
    // 拉丁/数字 token（npm、codearts、api、2019）判别力远高于中文二元组：
    // 后者会跨词边界产生「站那」「个刷」这种稀有但无意义的碎片。
    result.hasLatinCue = cueTokens.some((token) => /[a-z0-9]/.test(token))
    if (total === 0 || cueTokens.length === 0) {
      result.ms = Date.now() - started
      return result
    }

    const avgdl = this.totalTokens / total
    const scores = new Map()
    const covers = new Map()
    let maxIdfSum = 0
    let rareHit = false

    for (const token of cueTokens) {
      const list = this.postings.get(token)
      if (!list || list.length === 0) continue
      const dfRatio = list.length / total
      if (dfRatio > this.config.maxDfRatio) continue
      const idf = Math.log(1 + (total - list.length + 0.5) / (list.length + 0.5))
      maxIdfSum += idf
      if (dfRatio <= this.config.rareDfRatio) rareHit = true
      for (const idx of list) {
        const entry = this.entries[idx]
        const tf = entry.tf.get(token) ?? 0
        if (tf === 0) continue
        const norm = 1 - this.config.b + (this.config.b * entry.len) / avgdl
        const partial = idf * ((tf * (this.config.k1 + 1)) / (tf + this.config.k1 * norm))
        scores.set(idx, (scores.get(idx) ?? 0) + partial)
        // 覆盖率按「命中的线索权重」累加：只有稀有词命中但线索大部分没对上时，覆盖率会很低。
        covers.set(idx, (covers.get(idx) ?? 0) + idf)
      }
    }

    const ranked = []
    for (const [idx, raw] of scores) {
      const entry = this.entries[idx]
      let score = maxIdfSum > 0 ? raw / maxIdfSum : 0
      const coverage = maxIdfSum > 0 ? (covers.get(idx) ?? 0) / maxIdfSum : 0
      if (entry.speaker === 'user') score *= this.config.userWeight
      ranked.push({ entry, score: Math.min(1, score), coverage: Math.min(1, coverage) })
    }
    // 冷召回：只用分数排序，同分按 id 升序（稳定、可复现）。
    ranked.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : 1))

    const build = (row, width) => ({
      id: row.entry.id,
      session_id: row.entry.session_id,
      seq: row.entry.seq,
      at: row.entry.at,
      speaker: row.entry.speaker,
      score: Number(row.score.toFixed(4)),
      coverage: Number(row.coverage.toFixed(4)),
      excerpt: excerptOf(row.entry.text, cueTokens, width),
    })

    result.bestScore = ranked.length > 0 ? Number(ranked[0].score.toFixed(4)) : 0
    result.bestCoverage = ranked.length > 0 ? Number(ranked[0].coverage.toFixed(4)) : 0
    result.rareHit = rareHit

    // 判定"已定位"需要四个条件同时成立：
    // ① 命中稀有词 ② 分数过线 ③ 线索权重覆盖够 ④ 线索含拉丁/数字这种判别力强的 token。
    // ④ 是关键：中文二元组会跨词边界产生稀有但无意义的碎片，单独命中不足以定案，
    // 这类线索一律降级为候选卡，请用户补一句更具体的线索。
    result.accepted =
      rareHit && result.hasLatinCue && result.bestScore >= this.config.minScore && result.bestCoverage >= this.config.minCoverage

    result.candidates = ranked.slice(0, this.config.maxCandidates).map((row) => build(row, Math.floor(this.config.excerptChars / 2)))
    result.items = result.accepted
      ? ranked
          .filter((row) => row.score >= this.config.minScore)
          .slice(0, Math.max(0, limit))
          .map((row) => build(row, this.config.excerptChars))
      : []
    result.ms = Date.now() - started
    return result
  }

  stats() {
    let postings = 0
    for (const list of this.postings.values()) postings += list.length
    return {
      enabled: this.config.enabled,
      entries: this.entries.length,
      distinctTokens: this.postings.size,
      postings,
      avgTokensPerEntry: this.entries.length > 0 ? Number((this.totalTokens / this.entries.length).toFixed(1)) : 0,
      builtAt: this.builtAt > 0 ? new Date(this.builtAt).toISOString() : null,
      degraded: this.degraded,
      minScore: this.config.minScore,
      minCoverage: this.config.minCoverage,
      maxEntries: this.config.maxEntries,
    }
  }
}