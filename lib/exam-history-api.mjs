import { getSupabase } from './supabase-client.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** @param {import('http').IncomingMessage} req */
export function parseSessionKey(req) {
  const h = req.headers['x-session-key']
  const v = Array.isArray(h) ? h[0] : h
  const s = typeof v === 'string' ? v.trim() : ''
  if (s && UUID_RE.test(s)) return s
  return null
}

export async function examHistoryGet(sessionKey) {
  const db = getSupabase()
  if (!db) {
    return { status: 503, body: { error: 'Server exam history not configured', disabled: true } }
  }

  const { data, error } = await db
    .from('exam_history')
    .select('*')
    .eq('session_key', sessionKey)
    .order('at', { ascending: false })
    .limit(50)

  if (error) return { status: 500, body: { error: error.message } }
  return { status: 200, body: { items: data || [] } }
}

export async function examHistoryPost(sessionKey, entry) {
  const db = getSupabase()
  if (!db) {
    return { status: 503, body: { error: 'Server exam history not configured', disabled: true } }
  }

  const at = entry?.at
  const score = Number(entry?.score)
  const total = Number(entry?.total)
  const pct = Number(entry?.pct)
  const sourceDisplayName = String(entry?.sourceDisplayName || 'Exam').slice(0, 200)
  const questionCandidates = entry?.questionCandidates != null ? Number(entry.questionCandidates) : null
  const questions = Array.isArray(entry?.questions) ? entry.questions : null
  const answers = entry?.answers && typeof entry.answers === 'object' ? entry.answers : null

  if (typeof at !== 'string' || !at) {
    return { status: 400, body: { error: 'Field "at" (ISO string) is required' } }
  }
  if (!Number.isFinite(score) || !Number.isFinite(total)) {
    return { status: 400, body: { error: 'Fields "score" and "total" must be numbers' } }
  }

  const row = {
    session_key: sessionKey,
    at,
    score,
    total,
    pct: Number.isFinite(pct) ? pct : 0,
    source_display_name: sourceDisplayName,
    question_candidates: questionCandidates,
    questions,
    answers,
  }

  const { data, error } = await db.from('exam_history').insert(row).select('id').single()
  if (error) return { status: 500, body: { error: error.message } }
  return { status: 200, body: { id: data.id } }
}
