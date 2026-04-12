import fs from 'fs'
import os from 'os'
import formidable from 'formidable'
import {
  isAllowedUpload,
  mimeForFileSearch,
  runFileSearchUpload,
} from '../lib/mock-api.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  let ai = null

  const form = formidable({
    uploadDir: os.tmpdir(),
    maxFileSize: Math.min(
      100 * 1024 * 1024,
      Number(process.env.MAX_UPLOAD_BYTES) || 100 * 1024 * 1024,
    ),
    keepExtensions: true,
  })

  let fields
  let files
  try {
    ;[fields, files] = await form.parse(req)
  } catch (e) {
    res.status(400).json({ error: e.message || 'Invalid multipart body' })
    return
  }

  const uploaded =
    files.document?.[0] || files.pdf?.[0] || Object.values(files).flat()[0]

  if (!uploaded) {
    res.status(400).json({
      error:
        'No file uploaded. Use form field "document" (or legacy "pdf") with one file.',
    })
    return
  }

  const meta = {
    originalname: uploaded.originalFilename || 'source',
    mimetype: uploaded.mimetype || 'application/octet-stream',
  }

  if (!isAllowedUpload(meta)) {
    res.status(400).json({
      error: `Unsupported file type (${meta.mimetype}). Use PDF, TXT, MD, JSON, CSV, or DOCX.`,
    })
    return
  }

  const filePath = uploaded.filepath
  const displayName = (meta.originalname || 'source').replace(
    /[^\w.\- ]+/g,
    '_',
  ).slice(0, 120)
  const storeMime = mimeForFileSearch(meta)

  try {
    const out = await runFileSearchUpload(ai, {
      filePath,
      displayName,
      storeMime,
    })
    res.status(200).json(out)
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
}
