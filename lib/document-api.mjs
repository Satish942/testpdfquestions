import { getSupabase } from './supabase-client.mjs'
import { parseSessionKey } from './exam-history-api.mjs'
import fs from 'fs'
import path from 'path'
import os from 'os'

const STORE_DIR = path.join(os.tmpdir(), 'mock-stores')
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true })

function loadLocalStore(storeId) {
  if (!storeId) return null
  const fPath = path.join(STORE_DIR, `${storeId}.json`)
  if (!fs.existsSync(fPath)) return null
  try { return JSON.parse(fs.readFileSync(fPath, 'utf8')) } catch { return null }
}

export async function documentsGet(sessionKey) {
  const db = getSupabase()
  if (!db) return { status: 503, body: { error: 'Server not configured', disabled: true } }

  const { data, error } = await db
    .from('documents')
    .select('*')
    .eq('session_key', sessionKey)
    .order('uploaded_at', { ascending: false })
    .limit(50)

  if (error) return { status: 500, body: { error: error.message } }

  const items = (data || []).map(row => {
    const doc = {
      id: row.id,
      sourceDisplayName: row.source_display_name,
      questionCandidates: row.question_candidates,
      uploadedAt: row.uploaded_at,
      storeId: row.store_id,
      keySheetList: row.key_sheet_list || [],
      docType: row.doc_type || 'plain',
    }
    const local = loadLocalStore(row.store_id)
    if (local) {
      doc.questions = local.questions || []
      doc.keySheetList = local.keySheetList || doc.keySheetList
      doc.docType = local.docType || doc.docType
    }
    return doc
  })

  return { status: 200, body: { items } }
}

export async function documentsPost(sessionKey, entry) {
  const db = getSupabase()
  if (!db) return { status: 503, body: { error: 'Server not configured', disabled: true } }

  const sourceDisplayName = String(entry?.sourceDisplayName || 'Document').slice(0, 200)
  const questions = Array.isArray(entry?.questions) ? entry.questions : []
  const questionCandidates = questions.length
  const keySheetList = Array.isArray(entry?.keySheetList) ? entry.keySheetList : []
  const docType = entry?.docType || 'plain'

  const storeId = `doc-store-${Date.now()}`
  fs.writeFileSync(
    path.join(STORE_DIR, `${storeId}.json`),
    JSON.stringify({ questions, keySheetList, docType })
  )

  const row = {
    session_key: sessionKey,
    source_display_name: sourceDisplayName,
    question_candidates: questionCandidates,
    store_id: storeId,
    key_sheet_list: keySheetList,
    doc_type: docType,
  }

  const { data, error } = await db.from('documents').insert(row).select('*').single()
  if (error) return { status: 500, body: { error: error.message } }

  return {
    status: 200,
    body: {
      id: data.id,
      sourceDisplayName: data.source_display_name,
      questionCandidates: data.question_candidates,
      uploadedAt: data.uploaded_at,
      storeId: data.store_id,
      keySheetList,
      questions,
      docType,
    }
  }
}

export async function documentsDelete(sessionKey, docId) {
  const db = getSupabase()
  if (!db) return { status: 503, body: { error: 'Server not configured', disabled: true } }
  if (!docId) return { status: 400, body: { error: 'Document ID missing' } }

  // Get storeId before deleting to clean up local file
  const { data } = await db
    .from('documents')
    .select('store_id')
    .eq('id', docId)
    .eq('session_key', sessionKey)
    .single()

  if (data?.store_id) {
    const fPath = path.join(STORE_DIR, `${data.store_id}.json`)
    if (fs.existsSync(fPath)) fs.unlinkSync(fPath)
  }

  const { error } = await db
    .from('documents')
    .delete()
    .eq('id', docId)
    .eq('session_key', sessionKey)

  if (error) return { status: 500, body: { error: error.message } }
  return { status: 200, body: { success: true } }
}
