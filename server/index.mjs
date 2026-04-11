import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createAi,
  isAllowedUpload,
  mimeForFileSearch,
  runFileSearchUpload,
  runGenerateExam,
} from '../lib/gemini-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('Missing GEMINI_API_KEY in .env')
  process.exit(1)
}

const ai = createAi()

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isAllowedUpload(file)) {
      cb(null, true)
      return
    }
    cb(
      new Error(
        `Unsupported file type (${file.mimetype}). Use PDF, TXT, MD, JSON, CSV, or DOCX.`,
      ),
    )
  },
})

const uploadSource = upload.fields([
  { name: 'document', maxCount: 1 },
  { name: 'pdf', maxCount: 1 },
])

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.post('/api/upload', uploadSource, async (req, res) => {
  const f =
    req.files?.document?.[0] || req.files?.pdf?.[0] || req.file || null
  if (!f) {
    res.status(400).json({
      error:
        'No file uploaded. Use form field "document" (or legacy "pdf") with one file.',
    })
    return
  }

  const filePath = f.path
  const displayName = (f.originalname || 'source').replace(
    /[^\w.\- ]+/g,
    '_',
  ).slice(0, 120)
  const storeMime = mimeForFileSearch(f)

  try {
    const out = await runFileSearchUpload(ai, {
      filePath,
      displayName,
      storeMime,
    })
    res.json(out)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message || 'Upload failed' })
  } finally {
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* ignore */
    }
  }
})

app.post('/api/generate-exam', async (req, res) => {
  const { fileSearchStoreName, questionCount } = req.body || {}
  const n = Number(questionCount)
  if (!fileSearchStoreName || typeof fileSearchStoreName !== 'string') {
    res.status(400).json({ error: 'fileSearchStoreName is required' })
    return
  }
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    res.status(400).json({ error: 'questionCount must be between 1 and 50' })
    return
  }

  try {
    const out = await runGenerateExam(ai, {
      fileSearchStoreName,
      questionCount: n,
    })
    res.json(out)
  } catch (e) {
    console.error(e)
    const code = e.statusCode || 500
    res.status(code).json({ error: e.message || 'Exam generation failed' })
  }
})

const PORT = Number(process.env.PORT) || 8787
app.listen(PORT, () => {
  console.log(`API server http://localhost:${PORT}`)
})
