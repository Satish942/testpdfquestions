import { getAdminFirestore } from './firebase-admin.mjs'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** @param {import('http').IncomingMessage} req */
export function parseSessionKey(req) {
  const h = req.headers['x-session-key']
  const v = Array.isArray(h) ? h[0] : h
  const s = typeof v === 'string' ? v.trim() : ''
  if (s && UUID_RE.test(s)) return s
  return null
}

/**
 * @param {string} sessionKey
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function examHistoryGet(sessionKey) {
  const db = getAdminFirestore()
  if (!db) {
    return {
      status: 503,
      body: {
        error: 'Server exam history not configured',
        disabled: true,
      },
    }
  }

  const snap = await db
    .collection('devices')
    .doc(sessionKey)
    .collection('examHistory')
    .orderBy('at', 'desc')
    .limit(50)
    .get()

  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  return { status: 200, body: { items } }
}

/**
 * @param {string} sessionKey
 * @param {object} entry
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function examHistoryPost(sessionKey, entry) {
  const db = getAdminFirestore()
  if (!db) {
    return {
      status: 503,
      body: {
        error: 'Server exam history not configured',
        disabled: true,
      },
    }
  }

  const at = entry?.at
  const score = Number(entry?.score)
  const total = Number(entry?.total)
  const pct = Number(entry?.pct)
  const sourceDisplayName = String(entry?.sourceDisplayName || 'Exam').slice(
    0,
    200,
  )
  const questionCandidates = entry?.questionCandidates != null ? Number(entry.questionCandidates) : null
  const questions = Array.isArray(entry?.questions) ? entry.questions : null
  const answers = entry?.answers && typeof entry.answers === 'object' ? entry.answers : null


  if (typeof at !== 'string' || !at) {
    return { status: 400, body: { error: 'Field "at" (ISO string) is required' } }
  }
  if (!Number.isFinite(score) || !Number.isFinite(total)) {
    return {
      status: 400,
      body: { error: 'Fields "score" and "total" must be numbers' },
    }
  }

  const doc = {
    at,
    score,
    total,
    pct: Number.isFinite(pct) ? pct : 0,
    sourceDisplayName,
  }
  if (questionCandidates != null && Number.isFinite(questionCandidates)) {
    doc.questionCandidates = questionCandidates
  }
  if (questions) doc.questions = questions
  if (answers) doc.answers = answers


  const ref = await db
    .collection('devices')
    .doc(sessionKey)
    .collection('examHistory')
    .add(doc)

  return { status: 200, body: { id: ref.id } }
}
