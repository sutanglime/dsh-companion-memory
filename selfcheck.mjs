/**
 * 自检：用固定夹具验证冷热记忆引擎的纯函数。
 * 运行：node selfcheck.mjs
 *
 * 这些用例锁住的是方案里的机制而非观感：热度公式、有效提及上限、
 * 渐进冷却条件、冷召回禁止新近衰减、预算上限、归档正文抽取。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { deriveTurnEntry } from './lib/archive.js'
import { ArchiveIndex } from './lib/archive-index.js'
import {
  buildSnapshot,
  computeHeat,
  estimateTokens,
  lexicalSimilarity,
  lifecyclePass,
  qualifyingMentions,
  recallByCue,
  resolveConfig,
} from './lib/engine.js'
import { MemoryStore } from './lib/store.js'

const DAY = 86400000
const HOUR = 3600000
const NOW = Date.parse('2026-10-27T12:00:00+08:00')

let passed = 0
let failed = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, message: error && error.message ? error.message : String(error) })
    console.log(`  FAIL ${name}`)
    console.log(`       ${error && error.message ? error.message : String(error)}`)
  }
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: 期望 ${expected} ±${tolerance}，实际 ${actual}`,
  )
}

function record(overrides) {
  return {
    id: 'm-x',
    owner_id: 'u',
    scope_id: 'companion',
    fact_key: null,
    topic_id: 'topic-a',
    summary: '摘要',
    source_refs: [{ event_id: 'e1', excerpt: '原话' }],
    created_at: new Date(NOW - DAY).toISOString(),
    last_user_mention_at: new Date(NOW - DAY).toISOString(),
    mention_events: [],
    ongoing_until: null,
    pinned: false,
    recall_only: false,
    tier: 'hot',
    stage: 'detail',
    status: 'valid',
    supersedes: null,
    facets: {
      types: [],
      occurred_time: { start: null, end: null, precision: 'unknown' },
      places: [],
      people: [],
      objects: [],
      topics: [],
    },
    ...overrides,
  }
}

function fakeStore(records, state = {}) {
  return {
    records,
    list() {
      return records
    },
    state: {
      entity: { base_persona: '', current_state: '', state_version: 1, updated_at: null },
      pin_overflow: [],
      archive_watermarks: {},
      ...state,
    },
    get(id) {
      return records.find((item) => item.id === id)
    },
  }
}

const config = resolveConfig({})

console.log('token 估算与词法相似度')
await check('estimateTokens 中文按字计', () => {
  assert.equal(estimateTokens('西安'), 2)
  assert.equal(estimateTokens(''), 0)
})
await check('estimateTokens 拉丁按 4 字符 1 token 估算', () => {
  assert.equal(estimateTokens('hello world'), 3)
})
await check('词法相似度：同义改写能匹配到地名', () => {
  assert.ok(lexicalSimilarity('当年在西安买的胶片相机', '2019年西安旅行买了一台胶片相机') > 0)
  assert.equal(lexicalSimilarity('今天好累', '西安旅行'), 0)
})

console.log('有效提及与热度公式')
await check('同一交互内的重复事件只计一次', () => {
  const r = record({
    mention_events: [
      { interaction_id: 'i1', occurred_at: new Date(NOW - HOUR).toISOString(), kind: 'substantive' },
      { interaction_id: 'i1', occurred_at: new Date(NOW - HOUR).toISOString(), kind: 'substantive' },
      { interaction_id: 'i1', occurred_at: new Date(NOW - HOUR).toISOString(), kind: 'substantive' },
    ],
  })
  assert.equal(qualifyingMentions(r, NOW, config.heat), 1)
})
await check('同一天最多计 3 次有效提及', () => {
  const sameDay = new Date(NOW - HOUR).toISOString()
  const r = record({
    mention_events: [1, 2, 3, 4, 5].map((n) => ({ interaction_id: `i${n}`, occurred_at: sameDay, kind: 'substantive' })),
  })
  assert.equal(qualifyingMentions(r, NOW, config.heat), 3)
})
await check('助手复述/检索读取等非实质性提及不计分', () => {
  const r = record({
    mention_events: [
      { interaction_id: 'i1', occurred_at: new Date(NOW - HOUR).toISOString(), kind: 'assistant_repeat' },
      { interaction_id: 'i2', occurred_at: new Date(NOW - HOUR).toISOString(), kind: 'retrieval' },
    ],
  })
  assert.equal(qualifyingMentions(r, NOW, config.heat), 0)
})
await check('heat = 0.45*F + 0.35*R + 0.20*O', () => {
  const at = new Date(NOW - DAY).toISOString()
  const r = record({
    last_user_mention_at: at,
    mention_events: [1, 2, 3].map((n) => ({ interaction_id: `i${n}`, occurred_at: at, kind: 'substantive' })),
  })
  const { heat, frequency, recency, ongoing } = computeHeat(r, NOW, config.heat)
  near(frequency, 0.5, 1e-9, 'F')
  near(recency, Math.pow(2, -1 / 7), 1e-9, 'R')
  assert.equal(ongoing, 0)
  near(heat, 0.45 * 0.5 + 0.35 * Math.pow(2, -1 / 7), 1e-9, 'heat')
})
await check('进行中事项在复核期限内加 0.20', () => {
  const at = new Date(NOW - DAY).toISOString()
  const withOngoing = record({
    last_user_mention_at: at,
    ongoing_until: new Date(NOW + 7 * DAY).toISOString(),
  })
  const expired = record({ last_user_mention_at: at, ongoing_until: new Date(NOW - DAY).toISOString() })
  near(
    computeHeat(withOngoing, NOW, config.heat).heat - computeHeat(expired, NOW, config.heat).heat,
    0.2,
    1e-9,
    'O 差值',
  )
})

console.log('渐进冷却与状态迁移')
await check('7 天候任期后低热度事件转入冷库', () => {
  const store = fakeStore([
    record({
      id: 'm-old',
      created_at: new Date(NOW - 10 * DAY).toISOString(),
      last_user_mention_at: new Date(NOW - 100 * HOUR).toISOString(),
    }),
  ])
  const report = lifecyclePass(store, config, NOW)
  assert.equal(store.records[0].tier, 'cold')
  assert.equal(store.records[0].stage, 'cold')
  assert.ok(report.changes.some((change) => change.id === 'm-old' && change.to === 'cold'))
})
await check('候任期内的事件不会被提前冷存', () => {
  const store = fakeStore([
    record({ id: 'm-new', created_at: new Date(NOW - DAY).toISOString(), last_user_mention_at: new Date(NOW - 5 * HOUR).toISOString() }),
  ])
  lifecyclePass(store, config, NOW)
  assert.equal(store.records[0].tier, 'hot')
  assert.equal(store.records[0].stage, 'detail')
})
await check('72 小时之后细节降为摘要表示', () => {
  const store = fakeStore([
    record({ id: 'm-mid', created_at: new Date(NOW - 2 * DAY).toISOString(), last_user_mention_at: new Date(NOW - 80 * HOUR).toISOString() }),
  ])
  lifecyclePass(store, config, NOW)
  assert.equal(store.records[0].stage, 'summary')
  assert.equal(store.records[0].tier, 'hot')
})
await check('recall_only 立即降为冷存', () => {
  const store = fakeStore([record({ id: 'm-ask', recall_only: true })])
  lifecyclePass(store, config, NOW)
  assert.equal(store.records[0].tier, 'cold')
})
await check('固定项不参与冷却', () => {
  const store = fakeStore([
    record({ id: 'm-pin', pinned: true, tier: 'pinned', created_at: new Date(NOW - 90 * DAY).toISOString(), last_user_mention_at: new Date(NOW - 90 * DAY).toISOString() }),
  ])
  lifecyclePass(store, config, NOW)
  assert.equal(store.records[0].tier, 'pinned')
  assert.equal(store.records[0].stage, 'detail')
})
await check('近 7 天 ≥3 次独立提及且跨 ≥2 天时冷存重新升温', () => {
  const day1 = new Date(NOW - 5 * DAY).toISOString()
  const day2 = new Date(NOW - 4 * DAY).toISOString()
  const store = fakeStore([
    record({
      id: 'm-back',
      tier: 'cold',
      stage: 'cold',
      mention_events: [
        { interaction_id: 'a', occurred_at: day1, kind: 'substantive' },
        { interaction_id: 'b', occurred_at: day1, kind: 'substantive' },
        { interaction_id: 'c', occurred_at: day2, kind: 'substantive' },
      ],
    }),
  ])
  lifecyclePass(store, config, NOW)
  assert.equal(store.records[0].tier, 'hot')
})

console.log('线索召回')
await check('没有用户线索时冷库不开闸', () => {
  const store = fakeStore([record({ id: 'm-1', tier: 'cold', stage: 'cold' })])
  assert.equal(recallByCue(store, '', config, NOW).status, 'disabled')
})
await check('地点 + 物品两个维度构成强精确命中', () => {
  const store = fakeStore([
    record({
      id: 'm-xian-camera',
      tier: 'cold',
      stage: 'cold',
      summary: '2019年10月用户在西安旅行时买了一台胶片相机。',
      topic_id: 'xian_2019',
      last_user_mention_at: new Date(NOW - 300 * DAY).toISOString(),
      facets: {
        types: ['experience', 'purchase'],
        occurred_time: { start: '2019-10-01', end: '2019-10-31', precision: 'month' },
        places: [{ name: '西安' }],
        people: [],
        objects: [{ name: '胶片相机' }],
        topics: ['travel', 'photography'],
      },
    }),
    record({
      id: 'm-hangzhou-cafe',
      tier: 'cold',
      stage: 'cold',
      summary: '2025年4月杭州旅行的雨天，用户在河岸咖啡找了能安静看书的位置。',
      topic_id: 'hangzhou_2025',
      facets: {
        types: ['experience'],
        occurred_time: { start: '2025-04-13', end: '2025-04-13', precision: 'day' },
        places: [{ name: '杭州' }],
        people: [],
        objects: [{ name: '河岸咖啡' }],
        topics: ['travel', 'reading'],
      },
    }),
  ])
  const result = recallByCue(store, '你还记得当年在西安买的那个胶片相机吗', config, NOW)
  assert.equal(result.status, 'matched')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].record.id, 'm-xian-camera')
  assert.ok(result.items[0].strong, '应当判定为强精确匹配')
  assert.deepEqual([...result.supplied].sort(), ['objects', 'places'])
  assert.ok(result.tokens <= config.budgets.recalledTokens)
})
await check('冷召回不惩罚年代：内容相同则分数相同', () => {
  const base = {
    tier: 'cold',
    stage: 'cold',
    summary: '在西安买了一台胶片相机。',
    facets: {
      types: [],
      occurred_time: { start: null, end: null, precision: 'unknown' },
      places: [{ name: '西安' }],
      people: [],
      objects: [{ name: '胶片相机' }],
      topics: [],
    },
  }
  const store = fakeStore([
    record({ ...base, id: 'm-old', created_at: new Date(NOW - 900 * DAY).toISOString(), last_user_mention_at: new Date(NOW - 900 * DAY).toISOString() }),
    record({ ...base, id: 'm-recent', created_at: new Date(NOW - DAY).toISOString(), last_user_mention_at: new Date(NOW - HOUR).toISOString() }),
  ])
  const result = recallByCue(store, '在西安买的胶片相机', config, NOW)
  const byId = Object.fromEntries(result.candidates.map((candidate) => [candidate.id, candidate.matchScore]))
  near(byId['m-old'], byId['m-recent'], 1e-12, '年代不同的同内容候选分数')
})
await check('未命中返回 not_found 而不是编造', () => {
  const store = fakeStore([record({ id: 'm-1', tier: 'cold', stage: 'cold', summary: '在杭州喝咖啡。', facets: { types: [], occurred_time: { start: null, end: null, precision: 'unknown' }, places: [{ name: '杭州' }], people: [], objects: [], topics: [] } })])
  const result = recallByCue(store, '西安的擀面皮', config, NOW)
  assert.equal(result.status, 'not_found')
  assert.equal(result.items.length, 0)
})

console.log('快照与预算')
await check('固定事实上限 4 条', () => {
  const records = [1, 2, 3, 4, 5, 6].map((n) =>
    record({ id: `m-pin-${n}`, pinned: true, tier: 'pinned', topic_id: `t${n}`, summary: `固定事实 ${n}` }),
  )
  const snapshot = buildSnapshot(fakeStore(records), config, NOW)
  assert.equal(snapshot.pinned.length, 4)
})
await check('活跃记忆每主题最多 2 条', () => {
  const records = [1, 2, 3, 4, 5].map((n) => record({ id: `m-h${n}`, topic_id: 'same-topic', summary: `同主题事件 ${n}` }))
  const snapshot = buildSnapshot(fakeStore(records), config, NOW)
  assert.ok(snapshot.hot.length <= config.selection.maxHotItemsPerTopic, `同主题应 ≤2，实际 ${snapshot.hot.length}`)
})
await check('活跃记忆上限 8 条且不超 960 tokens', () => {
  const records = Array.from({ length: 20 }, (_, index) =>
    record({ id: `m-h${index}`, topic_id: `t${index}`, summary: `事件 ${index}：${'细节'.repeat(20)}` }),
  )
  const snapshot = buildSnapshot(fakeStore(records), config, NOW)
  assert.ok(snapshot.hot.length <= config.selection.maxHotItemsPerRequest)
  assert.ok(snapshot.tokens.hot <= config.budgets.hotTokens, `hot tokens ${snapshot.tokens.hot} 超预算`)
})
await check('固定事实超额时如实报告而不静默丢弃', () => {
  const records = [1, 2, 3, 4, 5].map((n) => record({ id: `m-pin-${n}`, pinned: true, tier: 'pinned', topic_id: `t${n}` }))
  const store = fakeStore(records)
  lifecyclePass(store, config, NOW)
  const snapshot = buildSnapshot(store, config, NOW)
  assert.equal(snapshot.overflow.pinnedTotal, 5)
  assert.deepEqual(snapshot.overflow.pinned, ['m-pin-5'])
})

console.log('归档正文抽取')
await check('用户消息正文被正确抽出', () => {
  const entry = deriveTurnEntry(
    { type: 'user/message', seq: 10, time: NOW, data: { role: 'user', content: [{ type: 'text', text: '今天有点累' }] } },
    { id: 's1' },
  )
  assert.equal(entry.speaker, 'user')
  assert.equal(entry.text, '今天有点累')
  assert.equal(entry.session_id, 's1')
  assert.equal(entry.system_context, false)
})
await check('harness 注入的运行时上下文被标记，不当作人话', () => {
  const entry = deriveTurnEntry(
    {
      type: 'user/message',
      seq: 11,
      time: NOW,
      data: { role: 'user', content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
    },
    { id: 's1' },
  )
  assert.equal(entry.system_context, true)
})
await check('助手工具轮也留档，正文为空时记下工具名', () => {
  const entry = deriveTurnEntry(
    {
      type: 'assistant/message',
      seq: 12,
      time: NOW,
      data: { turn: 3, step: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] }, stream: [] },
    },
    { id: 's1' },
  )
  assert.equal(entry.speaker, 'assistant')
  assert.equal(entry.text, '')
  assert.deepEqual(entry.tool_calls, ['read'])
  assert.equal(entry.turn, 3)
})
await check('工具结果与系统消息不入档', () => {
  assert.equal(deriveTurnEntry({ type: 'tool/result', seq: 13, time: NOW, data: {} }, { id: 's1' }), null)
  assert.equal(deriveTurnEntry({ type: 'system/message', seq: 14, time: NOW, data: {} }, { id: 's1' }), null)
})

console.log('归档词法索引')

function turn(overrides) {
  return {
    kind: 'turn',
    session_id: 's1',
    seq: 1,
    at: '2026-10-01T00:00:00.000Z',
    speaker: 'user',
    text: '',
    system_context: false,
    ...overrides,
  }
}

await check('只索引对话轮次：系统注入上下文与空正文被排除', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ seq: 1, text: '今天有点累' }))
  index.addEntry(turn({ seq: 2, text: 'Current runtime context. ...', system_context: true }))
  index.addEntry(turn({ seq: 3, text: '' }))
  index.addEntry({ kind: 'memory_card', memory_id: 'm-1' })
  assert.equal(index.size, 1)
})
await check('同一条（session#seq）重复加入只算一次', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ seq: 7, text: '重复内容' }))
  index.addEntry(turn({ seq: 7, text: '重复内容' }))
  assert.equal(index.size, 1)
})
await check('稀有词压过泛词：泛词因 df 过高被忽略', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ session_id: 'rare', seq: 1, text: '我喜欢用硅基流动的接口', speaker: 'user' }))
  for (let i = 0; i < 39; i += 1) {
    index.addEntry(turn({ session_id: 'generic', seq: i + 1, text: '插件相关的一般说明' }))
  }
  const result = index.search('硅基流动 插件', 3)
  // 中文线索按设计不判定"已定位"，但排序必须把含稀有词的那条排第一、泛词条目被 df 过滤掉
  assert.equal(result.rareHit, true)
  assert.equal(result.candidates.length, 1, '含泛词的条目应当因 df 过高完全不进候选')
  assert.equal(result.candidates[0].id, 'rare#1')
})
await check('冷召回不惩罚年代：内容相同则分数相同（时间字段不参与打分）', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ session_id: 'old', seq: 1, at: '2019-01-01T00:00:00.000Z', text: '在西安买了胶片相机' }))
  index.addEntry(turn({ session_id: 'new', seq: 1, at: '2026-10-01T00:00:00.000Z', text: '在西安买了胶片相机' }))
  const result = index.search('在西安买的胶片相机', 2)
  const byId = Object.fromEntries(result.candidates.map((c) => [c.id, c.score]))
  assert.equal(byId['old#1'], byId['new#1'])
})
await check('只命中部分线索时低于阈值：返回候选而不是当成已定位', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ session_id: 'a', seq: 1, text: 'alpha' }))
  index.addEntry(turn({ session_id: 'b', seq: 1, text: 'beta' }))
  index.addEntry(turn({ session_id: 'c', seq: 1, text: 'gamma' }))
  index.addEntry(turn({ session_id: 'd', seq: 1, text: 'delta' }))
  const result = index.search('alpha beta gamma delta', 3)
  assert.equal(result.items.length, 0, '部分命中不应算已定位')
  assert.ok(result.candidates.length > 0, '但应当留下候选卡')
  assert.ok(result.bestScore < 0.32)
})
await check('中文二元组单独命中不足以判定已定位（需判别性线索）', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ session_id: 'a', seq: 1, text: '关于视频与插件的一段说明' }))
  for (let i = 0; i < 30; i += 1) index.addEntry(turn({ session_id: `f${i}`, seq: 1, text: `别的内容 ${i}` }))
  const result = index.search('视频插件', 3)
  assert.equal(result.hasLatinCue, false)
  assert.equal(result.accepted, false, '中文二元组不该单独构成已定位')
  assert.equal(result.items.length, 0)
  assert.ok(result.candidates.length > 0, '但应当留候选卡')
})
await check('含拉丁/数字的线索可以判定已定位', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ session_id: 'npm', seq: 1, text: '把 npm token 写进凭据文件' }))
  for (let i = 0; i < 30; i += 1) index.addEntry(turn({ session_id: `f${i}`, seq: 1, text: `别的内容 ${i}` }))
  const result = index.search('npm token 怎么填', 3)
  assert.equal(result.hasLatinCue, true)
  assert.equal(result.accepted, true)
  assert.ok(result.items.length >= 1)
  assert.equal(result.items[0].id, 'npm#1')
})
await check('返回条数不超过 limit', () => {
  const index = new ArchiveIndex({})
  for (let i = 0; i < 10; i += 1) {
    index.addEntry(turn({ session_id: 'x', seq: i + 1, text: '同一件事的重复描述：插件与记忆' }))
  }
  const result = index.search('插件与记忆', 2)
  assert.ok(result.items.length <= 2)
  assert.ok(result.candidates.length <= 12)
})
await check('超过条目上限时标记 degraded 而不是静默丢弃', () => {
  const index = new ArchiveIndex({ maxEntries: 2 })
  index.addEntry(turn({ session_id: 'a', seq: 1, text: '第一条' }))
  index.addEntry(turn({ session_id: 'b', seq: 1, text: '第二条' }))
  index.addEntry(turn({ session_id: 'c', seq: 1, text: '第三条' }))
  assert.equal(index.size, 2)
  assert.equal(index.stats().degraded, 'max_entries')
})
await check('索引统计可用于状态查询', () => {
  const index = new ArchiveIndex({})
  index.addEntry(turn({ seq: 1, text: '统计一下这条记录的 token' }))
  const stats = index.stats()
  assert.equal(stats.entries, 1)
  assert.ok(stats.distinctTokens > 0)
  assert.ok(stats.postings > 0)
  assert.equal(stats.degraded, null)
})

console.log('存储与清理')
const dir = await mkdtemp(path.join(tmpdir(), 'companion-memory-selfcheck-'))
try {
  const store = new MemoryStore(dir)
  await store.load()
  await store.archiveTurn({ kind: 'turn', session_id: 's1', seq: 1, at: '2026-10-01T00:00:00.000Z', speaker: 'user', text: '一', memory_id: null })
  await store.archiveTurn({ kind: 'turn', session_id: 's2', seq: 1, at: '2026-10-20T00:00:00.000Z', speaker: 'assistant', text: '二', memory_id: null })
  await store.archiveTurn({ kind: 'memory_card', memory_id: 'm-1', at: '2026-10-21T00:00:00.000Z', summary: '卡' })

  await check('归档统计按会话与说话方分布', async () => {
    const stats = await store.archiveStats()
    assert.equal(stats.entries, 3)
    assert.equal(stats.turns, 2)
    assert.equal(stats.sessions, 2)
    assert.equal(stats.bySpeaker.user, 1)
  })
  await check('按会话清理只删该会话', async () => {
    const removed = await store.purgeArchiveWhere((entry) => entry.session_id === 's1')
    assert.equal(removed, 1)
    const stats = await store.archiveStats()
    assert.equal(stats.entries, 2)
    assert.equal(stats.bySession.s1, undefined)
  })
  await check('删除记忆卡连带清理其归档副本', async () => {
    const removed = await store.purgeArchive('m-1')
    assert.equal(removed, 1)
    assert.equal((await store.archiveStats()).entries, 1)
  })
  await check('状态与记忆卡可持久化并重载', async () => {
    await store.put(record({ id: 'm-persist', topic_id: 'persist' }))
    await store.saveState()
    const reopened = new MemoryStore(dir)
    await reopened.load()
    assert.ok(reopened.get('m-persist'))
    assert.equal(reopened.size(), 1)
  })
} finally {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

console.log('')
console.log(`自检结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) {
  console.log('失败用例：')
  for (const failure of failures) console.log(` - ${failure.name}: ${failure.message}`)
  process.exit(1)
}
console.log('全部通过 ✅')