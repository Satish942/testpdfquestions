import { runGenerateExam } from '../lib/mock-api.mjs'

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON body')
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  let ai = null

  let body
  try {
    body = await readJsonBody(req)
  } catch (e) {
    res.status(400).json({ error: e.message })
    return
  }

  const { fileSearchStoreName, questionCount } = body || {}
  const n = Number(questionCount)
  if (!fileSearchStoreName || typeof fileSearchStoreName !== 'string') {
    res.status(400).json({ error: 'fileSearchStoreName is required' })
    return
  }
  if (!Number.isFinite(n) || n < 1 || n > 500) {
    res.status(400).json({ error: 'questionCount must be between 1 and 500' })
    return
  }

  try {
    const out = await runGenerateExam(ai, {
      fileSearchStoreName,
      questionCount: n,
    })
    res.status(200).json(out)
  } catch (e) {
    console.error(e)
    const code = e.statusCode || 500
    res.status(code).json({ error: e.message || 'Exam generation failed' })
  }
}
