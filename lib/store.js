import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 解析数据目录：显式配置优先，其次 $DSH_HOME/companion-memory。 */
export function resolveDataDir(config) {
  const configured = config && typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured) return path.resolve(configured)
  const envHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = envHome || path.join(os.homedir(), '.dsh')
  return path.join(home, 'companion-memory')
}

function emptyState() {
  return {
    version: 1,
    entity: { base_persona: '', current_state: '', state_version: 1, updated_at: null },
    counters: { interactions: 0 },
    recall_permits: [],
    pin_overflow: [],
    archive_watermarks: {},
    last_lifecycle_at: 0,
    updated_at: null,
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/** 文件支撑的记忆存储：记忆卡、状态与原文归档。 */
export class MemoryStore {
  constructor(dir) {
    this.dir = dir
    this.records = new Map()
    this.state = emptyState()
    this.recordsPath = path.join(dir, 'records.json')
    this.statePath = path.join(dir, 'state.json')
    this.archivePath = path.join(dir, 'archive.jsonl')
    this.loaded = false
  }

  async load() {
    await fs.mkdir(this.dir, { recursive: true })
    const doc = await readJson(this.recordsPath)
    if (doc && Array.isArray(doc.records)) {
      for (const record of doc.records) {
        if (record && typeof record.id === 'string' && record.id) this.records.set(record.id, record)
      }
    }
    const state = await readJson(this.statePath)
    if (state && typeof state === 'object') {
      const base = emptyState()
      this.state = {
        ...base,
        ...state,
        entity: { ...base.entity, ...(state.entity && typeof state.entity === 'object' ? state.entity : {}) },
        counters: { ...base.counters, ...(state.counters && typeof state.counters === 'object' ? state.counters : {}) },
        recall_permits: Array.isArray(state.recall_permits) ? state.recall_permits : [],
        pin_overflow: Array.isArray(state.pin_overflow) ? state.pin_overflow : [],
        archive_watermarks:
          state.archive_watermarks && typeof state.archive_watermarks === 'object' ? state.archive_watermarks : {},
      }
    }
    this.loaded = true
    return this
  }

  list() {
    return [...this.records.values()]
  }

  get(id) {
    return this.records.get(id)
  }

  has(id) {
    return this.records.has(id)
  }

  size() {
    return this.records.size
  }

  async put(record) {
    this.records.set(record.id, record)
    await this.saveRecords()
    return record
  }

  async remove(id) {
    if (!this.records.delete(id)) return false
    await this.saveRecords()
    await this.purgeArchive(id)
    return true
  }

  async saveRecords() {
    const doc = { version: 1, updated_at: new Date().toISOString(), records: this.list() }
    await writeAtomic(this.recordsPath, JSON.stringify(doc, null, 2))
  }

  async saveState() {
    this.state.updated_at = new Date().toISOString()
    await writeAtomic(this.statePath, JSON.stringify(this.state, null, 2))
  }

  async archive(entry) {
    await fs.appendFile(this.archivePath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async readArchive(limit) {
    let text = ''
    try {
      text = await fs.readFile(this.archivePath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const tail = typeof limit === 'number' && limit > 0 ? lines.slice(-limit) : lines
    const entries = []
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // 损坏的归档行只跳过，不影响召回。
      }
    }
    return entries
  }

  /** 追加一条归档记录（对话轮次或记忆卡）。 */
  async archiveTurn(entry) {
    await fs.appendFile(this.archivePath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async readArchiveLines() {
    let text = ''
    try {
      text = await fs.readFile(this.archivePath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const entries = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        // 损坏的归档行只跳过，不影响召回与统计。
      }
    }
    return entries
  }

  /** 明确删除时连带清理归档里引用该记忆的派生副本。 */
  async purgeArchive(memoryId) {
    return this.purgeArchiveWhere((entry) => entry.memory_id === memoryId)
  }

  /** 按条件重写归档并返回删除条数；损坏行原样保留。 */
  async purgeArchiveWhere(predicate) {
    let text = ''
    try {
      text = await fs.readFile(this.archivePath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return 0
      throw error
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const kept = []
    let removed = 0
    for (const line of lines) {
      let entry = null
      try {
        entry = JSON.parse(line)
      } catch {
        kept.push(line)
        continue
      }
      let drop = false
      try {
        drop = predicate(entry) === true
      } catch {
        drop = false
      }
      if (drop) removed += 1
      else kept.push(line)
    }
    if (removed > 0) await writeAtomic(this.archivePath, kept.length ? `${kept.join('\n')}\n` : '')
    return removed
  }

  /** 归档总量与分布（按会话、按说话方、时间跨度）。 */
  async archiveStats() {
    const entries = await this.readArchiveLines()
    let bytes = 0
    try {
      bytes = (await fs.stat(this.archivePath)).size
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    const bySession = {}
    const bySpeaker = { user: 0, assistant: 0, other: 0 }
    let turns = 0
    let memoryCards = 0
    let first = null
    let last = null
    for (const entry of entries) {
      if (entry.kind === 'turn') {
        turns += 1
        const id = entry.session_id ?? '(unknown)'
        bySession[id] = (bySession[id] ?? 0) + 1
        if (entry.speaker === 'user') bySpeaker.user += 1
        else if (entry.speaker === 'assistant') bySpeaker.assistant += 1
        else bySpeaker.other += 1
      } else {
        memoryCards += 1
      }
      if (typeof entry.at === 'string') {
        if (first === null || entry.at < first) first = entry.at
        if (last === null || entry.at > last) last = entry.at
      }
    }
    return {
      entries: entries.length,
      turns,
      memoryCards,
      bytes,
      first,
      last,
      bySpeaker,
      sessions: Object.keys(bySession).length,
      bySession,
      watermarks: Object.keys(this.state.archive_watermarks ?? {}).length,
    }
  }

  async stats() {
    let archiveEntries = 0
    try {
      const text = await fs.readFile(this.archivePath, 'utf8')
      archiveEntries = text.split('\n').filter((line) => line.trim().length > 0).length
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    return { records: this.records.size, archiveEntries }
  }
}