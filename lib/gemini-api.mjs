import { GoogleGenAI } from '@google/genai'

/** Extension → MIME for File Search upload. */
export const EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const ALLOWED_MIMES = new Set(Object.values(EXT_TO_MIME))

export function extOf(filename) {
  const m = String(filename || '')
    .toLowerCase()
    .match(/\.[^.]+$/)
  return m ? m[0] : ''
}

export function normalizedMime(mimetype) {
  return String(mimetype || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
}

/** @param {{ originalname?: string, originalFilename?: string, mimetype?: string }} file */
export function isAllowedUpload(file) {
  const name = file.originalname || file.originalFilename || ''
  const ext = extOf(name)
  const mt = normalizedMime(file.mimetype)
  if (ALLOWED_MIMES.has(mt)) return true
  if (!ext || !EXT_TO_MIME[ext]) return false
  if (
    !mt ||
    mt === 'application/octet-stream' ||
    mt === 'binary/octet-stream'
  ) {
    return true
  }
  if (
    ext === '.docx' &&
    (mt === 'application/zip' || mt === 'application/x-zip-compressed')
  ) {
    return true
  }
  return mt === EXT_TO_MIME[ext]
}

/** @param {{ originalname?: string, originalFilename?: string, mimetype?: string }} file */
export function mimeForFileSearch(file) {
  const name = file.originalname || file.originalFilename || ''
  const mt = normalizedMime(file.mimetype)
  if (ALLOWED_MIMES.has(mt)) return mt
  const ext = extOf(name)
  return EXT_TO_MIME[ext] || 'text/plain'
}

export function getModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.5-flash'
}

export function createAi() {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY')
  }
  return new GoogleGenAI({ apiKey })
}

export async function waitForUploadOperation(ai, operation, label) {
  let op = operation
  const maxAttempts = 120
  for (let i = 0; i < maxAttempts; i++) {
    if (op.done) {
      if (op.error) {
        throw new Error(`${label} failed: ${JSON.stringify(op.error)}`)
      }
      return op
    }
    await new Promise((r) => setTimeout(r, 2000))
    op = await ai.operations.get({ operation: op })
  }
  throw new Error(`${label} timed out`)
}

export function parseQuestionsJson(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function normalizeQuestions(parsed, expectedCount) {
  if (!parsed?.questions || !Array.isArray(parsed.questions)) return null
  const out = []
  for (const q of parsed.questions) {
    if (out.length >= expectedCount) break
    const opts = Array.isArray(q.options) ? q.options.map(String) : []
    const ci = Number(q.correctIndex)
    if (
      typeof q.question !== 'string' ||
      opts.length !== 4 ||
      !Number.isInteger(ci) ||
      ci < 0 ||
      ci > 3
    ) {
      continue
    }
    out.push({
      id: `q-${out.length}`,
      question: q.question.trim(),
      options: opts,
      correctIndex: ci,
    })
  }
  return out.length >= expectedCount ? out.slice(0, expectedCount) : null
}

export const examJsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 4,
            maxItems: 4,
          },
          correctIndex: { type: 'integer', minimum: 0, maximum: 3 },
        },
        required: ['question', 'options', 'correctIndex'],
      },
    },
  },
  required: ['questions'],
}

/**
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {{ filePath: string, displayName: string, storeMime: string }} input
 */
export async function runFileSearchUpload(ai, input) {
  const { filePath, displayName, storeMime } = input
  const fileSearchStore = await ai.fileSearchStores.create({
    config: { displayName: `exam-${Date.now()}-${displayName}` },
  })

  let operation = await ai.fileSearchStores.uploadToFileSearchStore({
    file: filePath,
    fileSearchStoreName: fileSearchStore.name,
    config: {
      displayName,
      mimeType: storeMime,
    },
  })

  await waitForUploadOperation(ai, operation, 'File indexing')

  const questionCandidates = await runEstimateQuestionCandidates(
    ai,
    fileSearchStore.name,
  )

  return {
    fileSearchStoreName: fileSearchStore.name,
    sourceDisplayName: displayName,
    sourceMimeType: storeMime,
    pdfDisplayName: displayName,
    questionCandidates,
  }
}

const questionEstimateSchema = {
  type: 'object',
  properties: {
    questionCandidates: { type: 'integer', minimum: 0, maximum: 500 },
  },
  required: ['questionCandidates'],
}

function parseEstimateJson(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim()
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/im)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  s = s.slice(start, end + 1)
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Rough count of exam-suitable question opportunities in indexed material (model estimate).
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {string} fileSearchStoreName
 * @returns {Promise<number|null>}
 */
export async function runEstimateQuestionCandidates(ai, fileSearchStoreName) {
  const model = getModel()
  const prompt = `Using file search on the indexed material only, estimate how many distinct multiple-choice exam questions the content could reasonably support.

Count: explicit questions in the source, clear Q&A pairs, and distinct facts that could each become one MCQ with four options.

Respond with JSON only in this shape: {"questionCandidates": N} where N is an integer from 0 to 200. Be conservative when uncertain.`

  try {
    const r = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [fileSearchStoreName],
            },
          },
        ],
        responseMimeType: 'application/json',
        responseJsonSchema: questionEstimateSchema,
        temperature: 0.15,
        maxOutputTokens: 256,
      },
    })
    let parsed = parseEstimateJson(r.text || '')
    if (!parsed?.questionCandidates && typeof r.text === 'string') {
      try {
        parsed = JSON.parse(r.text.trim())
      } catch {
        parsed = null
      }
    }
    const n = Number(parsed?.questionCandidates)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.min(500, Math.round(n))
  } catch (e) {
    console.warn('Question candidate estimate failed:', e)
    try {
      const r2 = await ai.models.generateContent({
        model,
        contents: `${prompt}\n\nReply with only: {"questionCandidates": <number>}`,
        config: {
          tools: [
            {
              fileSearch: {
                fileSearchStoreNames: [fileSearchStoreName],
              },
            },
          ],
          responseMimeType: 'text/plain',
          temperature: 0.15,
          maxOutputTokens: 256,
        },
      })
      const parsed = parseEstimateJson(r2.text || '')
      const n = Number(parsed?.questionCandidates)
      if (!Number.isFinite(n) || n < 0) return null
      return Math.min(500, Math.round(n))
    } catch (e2) {
      console.warn('Question candidate estimate fallback failed:', e2)
      return null
    }
  }
}

/**
 * @param {import('@google/genai').GoogleGenAI} ai
 * @param {{ fileSearchStoreName: string, questionCount: number }} input
 */
export async function runGenerateExam(ai, input) {
  const model = getModel()
  const { fileSearchStoreName, questionCount: n } = input

  const retrievalPrompt = `Use file search on the user's indexed material. Write dense study notes in plain text only (paragraphs and bullets).

Include concrete facts, definitions, numbers, relationships, and anything suitable for multiple-choice tests.
The source may be prose, Q&A, or existing MCQs — capture it faithfully without inventing facts beyond the retrieved content.
Do not output JSON. Aim for enough detail to support about ${n} exam questions.`

  const examPrompt = `You will create exactly ${n} multiple-choice questions using ONLY the study notes below (treat them as the sole source of truth).

Rules:
- Each question: exactly 4 option strings (order A–D) and correctIndex 0–3.
- Self-contained wording (never say "the notes", "the document", or "the file").
- For Q&A style facts, add three plausible wrong answers consistent with the topic.
- If notes include existing MCQs, normalize to 4 options and preserve the intended correct answer.

STUDY NOTES:
---
`

  const r1 = await ai.models.generateContent({
    model,
    contents: retrievalPrompt,
    config: {
      tools: [
        {
          fileSearch: {
            fileSearchStoreNames: [fileSearchStoreName],
          },
        },
      ],
      responseMimeType: 'text/plain',
      temperature: 0.25,
      maxOutputTokens: 8192,
    },
  })

  const outline = (r1.text || '').trim()
  if (!outline) {
    throw Object.assign(new Error('Empty retrieval from file search'), {
      statusCode: 502,
    })
  }

  let parsed

  try {
    const r2 = await ai.models.generateContent({
      model,
      contents: `${examPrompt}${outline}\n---`,
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: examJsonSchema,
        temperature: 0.25,
        maxOutputTokens: 8192,
      },
    })
    const raw = (r2.text || '').trim()
    parsed = parseQuestionsJson(raw)
    if (!parsed?.questions) {
      try {
        parsed = raw ? JSON.parse(raw) : null
      } catch {
        parsed = null
      }
    }
  } catch (step2Err) {
    console.warn('Structured JSON step failed, falling back to text JSON:', step2Err)
    const r2b = await ai.models.generateContent({
      model,
      contents: `${examPrompt}${outline}\n---

Respond with ONLY one JSON object (no markdown) in this exact shape:
{"questions":[{"question":"string","options":["A","B","C","D"],"correctIndex":0}]}`,
      config: {
        responseMimeType: 'text/plain',
        temperature: 0.25,
        maxOutputTokens: 8192,
      },
    })
    parsed = parseQuestionsJson(r2b.text || '')
  }

  const questions = normalizeQuestions(parsed, n)
  if (!questions) {
    throw Object.assign(
      new Error(
        'Could not build a valid exam from the model output. Try again, use fewer questions, or upload richer material.',
      ),
      { statusCode: 502 },
    )
  }

  return { questions }
}
