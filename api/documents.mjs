import {
  documentsGet,
  documentsPost,
  documentsDelete,
} from '../lib/document-api.mjs'
import { parseSessionKey } from '../lib/exam-history-api.mjs'

export default async function handler(req, res) {
  const sessionKey = parseSessionKey(req)
  if (!sessionKey) {
    res.status(400).json({ error: 'Missing or invalid X-Session-Key header' })
    return
  }

  if (req.method === 'GET') {
    const out = await documentsGet(sessionKey)
    res.status(out.status).json(out.body)
  } else if (req.method === 'POST') {
    const out = await documentsPost(sessionKey, req.body || {})
    res.status(out.status).json(out.body)
  } else if (req.method === 'DELETE') {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const id = url.searchParams.get('id')
    const out = await documentsDelete(sessionKey, id)
    res.status(out.status).json(out.body)
  } else {
    res.status(405).json({ error: 'Method not allowed' })
  }
}
