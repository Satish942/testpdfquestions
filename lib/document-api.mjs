import { getAdminFirestore } from './firebase-admin.mjs'
import { parseSessionKey } from './exam-history-api.mjs'

export async function documentsGet(sessionKey) {
  const db = getAdminFirestore()
  if (!db) {
    return {
      status: 503,
      body: { error: 'Server history not configured', disabled: true },
    }
  }

  const snap = await db
    .collection('devices')
    .doc(sessionKey)
    .collection('documents')
    .orderBy('uploadedAt', 'desc')
    .limit(50)
    .get()

  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  return { status: 200, body: { items } }
}

export async function documentsPost(sessionKey, entry) {
  const db = getAdminFirestore()
  if (!db) {
    return {
      status: 503,
      body: { error: 'Server history not configured', disabled: true },
    }
  }

  const uploadedAt = new Date().toISOString()
  const sourceDisplayName = String(entry?.sourceDisplayName || 'Document').slice(0, 200)
  const questionCandidates = Number.isFinite(entry?.questionCandidates) ? entry.questionCandidates : 0
  const questions = Array.isArray(entry?.questions) ? entry.questions : []

  const doc = {
    uploadedAt,
    sourceDisplayName,
    questionCandidates,
    questions,
  }

  const ref = await db
    .collection('devices')
    .doc(sessionKey)
    .collection('documents')
    .add(doc)

  return { status: 200, body: { id: ref.id, ...doc } }
}

export async function documentsDelete(sessionKey, docId) {
  const db = getAdminFirestore()
  if (!db) {
    return {
      status: 503,
      body: { error: 'Server not configured for cloud storage', disabled: true },
    }
  }

  if (!docId) return { status: 400, body: { error: 'Document ID missing' } }

  await db
    .collection('devices')
    .doc(sessionKey)
    .collection('documents')
    .doc(docId)
    .delete()

  return { status: 200, body: { success: true } }
}
