import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix { constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; } };
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D { addPath() { } closePath() { } moveTo() { } lineTo() { } bezierCurveTo() { } quadraticCurveTo() { } arc() { } arcTo() { } ellipse() { } rect() { } };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_DIR = path.join(os.tmpdir(), 'mock-stores')
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true })

export const EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function isAllowedUpload(file) {
  const mt = String(file.mimetype || '').split(';')[0].trim().toLowerCase()
  return Object.values(EXT_TO_MIME).includes(mt) ||
    Object.keys(EXT_TO_MIME).some(ext => (file.originalname || '').toLowerCase().endsWith(ext))
}

export function mimeForFileSearch(file) {
  const ext = (file.originalname || '').toLowerCase().match(/\.[^.]+$/)?.[0];
  return EXT_TO_MIME[ext] || 'text/plain';
}

export async function runFileSearchUpload(ai, input) {
  const { filePath, displayName, storeMime } = input

  let rawText = ''
  try {
    if (storeMime === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
      const [{ PDFParse }, pdfjs] = await Promise.all([
        import('pdf-parse'),
        import('pdfjs-dist/legacy/build/pdf.mjs')
      ])
      const internalWorkerPath = '/var/task/node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
      pdfjs.GlobalWorkerOptions.workerSrc = process.env.VERCEL ? internalWorkerPath : 'pdfjs-dist/legacy/build/pdf.worker.mjs';
      const dataBuffer = fs.readFileSync(filePath)
      const parser = new PDFParse({ data: dataBuffer })
      const textResult = await parser.getText()
      rawText = textResult.text
    } else {
      rawText = fs.readFileSync(filePath, 'utf8')
    }
  } catch (e) {
    console.error('Extraction error:', e)
  }

  // 1. Sanitize
  rawText = rawText
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, ' ')
    .replace(/--\s*\d+\s*--/gi, ' ')
    .replace(/---+/g, ' ')
    .replace(/(?:Page|Pg\.?)\s*\d+/gi, ' ')

  // 2. CHAPTER DETECTION — Pattern-agnostic heuristic
  //    Works for ANY numbered heading format:
  //    "Chapter 1", "PMP Practice Test 1", "Unit 1", "Module 1", etc.
  //
  //    Algorithm:
  //    a) Scan every line. Keep short (≤ 120 chars) lines that contain a number 1-20
  //       and are NOT answer-key lines.
  //    b) Normalize each to a (stem, number) pair by stripping the number.
  //    c) Group by stem. The stem whose instances span 2+ DISTINCT sequential numbers
  //       AND appear spread across the document is the chapter header pattern.
  //    d) Use the FIRST occurrence of each chapter number from the winning stem as boundaries.
  //    e) If no stem wins, fall back to question-number-reset detection (done later).

  const rawLines = rawText.split('\n')
  const lineIndex = []  // char offset of each line start
  let _pos = 0
  for (const l of rawLines) { lineIndex.push(_pos); _pos += l.length + 1 }

  // Candidate short heading lines, excluding obvious answer-key or TOC lines
  const candidateLines = []
  for (let li = 0; li < rawLines.length; li++) {
    const t = rawLines[li].trim()
    if (t.length < 3 || t.length > 120) continue
    const numMatch = t.match(/\b([1-9]|1\d|20)\b/)
    if (!numMatch) continue
    // Skip answer-key lines
    if (/answer\s*key|answer\s*sheet|^\s*key\s*$/i.test(t)) continue
    // Skip pure number lines or lines that look like Q→A pairs
    if (/^\d+[\.\-\)\s]*[A-Da-d]\s*$/.test(t)) continue
    const num = parseInt(numMatch[1], 10)
    // Stem = line with the number stripped, lowercased for grouping
    const stem = t.replace(numMatch[1], '__N__').toLowerCase().trim()
    candidateLines.push({ line: t, num, stem, charIdx: lineIndex[li] })
  }

  // Group by stem
  const stemMap = {}
  for (const c of candidateLines) {
    if (!stemMap[c.stem]) stemMap[c.stem] = []
    stemMap[c.stem].push(c)
  }

  // Find the best stem: most distinct sequential numbers, spread across the doc
  let chapterBoundaries = []
  const chapterHeadings = {}
  let bestStemScore = 0

  for (const [stem, hits] of Object.entries(stemMap)) {
    // Deduplicate by number — keep first occurrence
    const byNum = {}
    for (const h of hits) {
      if (byNum[h.num] === undefined) byNum[h.num] = h
    }
    const nums = Object.keys(byNum).map(Number).sort((a, b) => a - b)
    if (nums.length < 2) continue

    // Check sequential (e.g. 1,2,3,4)
    let seqCount = 1
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === nums[i - 1] + 1) seqCount++
    }
    if (seqCount < 2) continue

    // Score: sequential length × doc-spread bonus
    const spread = byNum[nums[nums.length - 1]].charIdx - byNum[nums[0]].charIdx
    const score = seqCount * 1000 + spread
    if (score > bestStemScore) {
      bestStemScore = score
      chapterBoundaries = nums.map((n, i) => ({
        index: byNum[n].charIdx,
        raw: byNum[n].line,
        num: n,
        key: `chapter${i + 1}`,
        label: byNum[n].line.trim()
      }))
    }
  }

  // Assign headings from discovered boundaries
  chapterBoundaries.forEach((b, i) => {
    b.key = `chapter${i + 1}`
    chapterHeadings[b.key] = b.label
  })

  // --- Fallback A: classic keyword-based detection ---
  if (chapterBoundaries.length === 0) {
    const kwRe = /(?:^|\n)\s*(?:chapter|unit|section|part|module|lecture|topic|ch\.?)\s*[-–:.]?\s*(\d+)[^\n]*/gi
    let bm
    while ((bm = kwRe.exec(rawText)) !== null) {
      const num = parseInt(bm[1], 10)
      const raw = bm[0].replace(/^\n/, '').trim()
      if (num >= 1 && num <= 25 && raw.length <= 120) {
        chapterBoundaries.push({ index: bm.index, raw, num })
      }
    }
    chapterBoundaries.sort((a, b) => a.index - b.index)
    chapterBoundaries.forEach((b, i) => {
      b.key = `chapter${i + 1}`
      b.label = b.raw
      chapterHeadings[b.key] = b.raw
    })
  }

  // --- Fallback B: bare minimum ---
  if (chapterBoundaries.length === 0) {
    chapterBoundaries.push({ index: 0, key: 'chapter1', label: 'Chapter 1' })
    chapterHeadings['chapter1'] = 'Chapter 1'
  }

  console.log('[parser] chapters detected:', chapterBoundaries.map(b => `${b.key}: "${b.label}" @${b.index}`))

  // Helper: find which chapter a text position belongs to
  function getChapterKey(pos) {
    let result = chapterBoundaries[0]
    for (let i = 0; i < chapterBoundaries.length; i++) {
      if (pos >= chapterBoundaries[i].index) result = chapterBoundaries[i]
      else break
    }
    return result.key
  }

  // 3. Parse question block positions (split by numbered markers at start of line)
  const qBlockRegex = /(?:^|\n)\s*(?:Question\s*)?[Qq]?\s*(\d+)[\.\)\s:-]+/g
  const parts = []
  let lastIdx = 0
  let qm
  while ((qm = qBlockRegex.exec(rawText)) !== null) {
    const num = qm[1]
    const startIdx = qm.index
    if (lastIdx > 0) {
      parts[parts.length - 1].content = rawText.slice(parts[parts.length - 1].contentStart, startIdx)
    }
    parts.push({ num, startIdx, contentStart: startIdx + qm[0].length })
    lastIdx = startIdx
  }
  if (parts.length > 0) {
    parts[parts.length - 1].content = rawText.slice(parts[parts.length - 1].contentStart)
  }

  // Fallback C: infer chapter splits from question-number resets (e.g. Q1→Q165 resets to Q1)
  if (chapterBoundaries.length <= 1 && parts.length > 0) {
    let prevNum = 0, chapIdx = 1
    const synth = [{ index: 0, key: 'chapter1', label: 'Chapter 1' }]
    chapterHeadings['chapter1'] = 'Chapter 1'
    for (const part of parts) {
      const n = parseInt(part.num, 10)
      if (prevNum > 5 && n <= Math.max(1, Math.floor(prevNum * 0.3))) {
        chapIdx++
        const key = `chapter${chapIdx}`
        synth.push({ index: part.startIdx, key, label: `Chapter ${chapIdx}` })
        chapterHeadings[key] = `Chapter ${chapIdx}`
      }
      prevNum = n
    }
    if (synth.length > 1) {
      chapterBoundaries = synth
      console.log('[parser] used question-reset fallback, chapters:', chapIdx)
    }
  }

  // 4. Answer Key Scanner — 2-pass approach
  //
  //    PDF pattern:
  //      "PMP Practice Test 1"   ← chapter 1 questions
  //      "Test 1 Answer Key"     ← answers for chapter 1
  //      "PMP Practice Test 2"   ← chapter 2 questions
  //      "Test 2 Answer Key"     ← answers for chapter 2  ...
  //
  //    Pass 1: Find every line that contains "Answer Key" (or "Answer Sheet").
  //            Extract the number N from that line.
  //            Resolve it to the matching chapter key (chapter whose boundary num === N).
  //            Record: { lineIndex, chapterKey }
  //
  //    Pass 2: For each answer key section (from its line to the next section boundary),
  //            extract all Q→answer pairs and store in chapterAnswers[chapterKey].

  const chapterAnswers = {}   // { chapterKey: { q1: 'A', q2: 'B', ... } }

  // Helper: given a chapter sequential number N, return the chapterKey
  function resolveChapterKeyByNum(n) {
    const nStr = String(n)
    // Match by b.num (the physical number from the boundary heading, e.g. 1 from "Test 1")
    for (const b of chapterBoundaries) {
      if (String(b.num) === nStr) return b.key
    }
    // Fallback: match by sequential index
    const idx = n - 1
    if (chapterBoundaries[idx]) return chapterBoundaries[idx].key
    return null
  }

  // Pass 1: locate all "Answer Key" section start line indices
  const ansKeySections = []  // [{ lineIdx, chapterKey }]
  for (let li = 0; li < rawLines.length; li++) {
    const t = rawLines[li].trim()
    // Match any line ending in "Answer Key" or "Answer Sheet" (case-insensitive)
    // e.g.: "Test 1 Answer Key", "PMP Practice Test 2 Answer Key", "Answer Key"
    if (!/answer\s+(?:key|sheet)/i.test(t)) continue

    // Extract a number from the line (e.g. 1 from "Test 1 Answer Key")
    const numMatch = t.match(/\b([1-9]|1\d|20)\b/)
    let chapterKey = null
    if (numMatch) {
      chapterKey = resolveChapterKeyByNum(parseInt(numMatch[1], 10))
    }
    // If no number, or number didn't resolve, fall back to doc position
    if (!chapterKey) {
      chapterKey = getChapterKey(lineIndex[li])
    }

    ansKeySections.push({ lineIdx: li, chapterKey })
    console.log(`[parser] answer key section found: line ${li} → "${t}" → ${chapterKey}`)
  }

  // Pass 2: extract Q→answer pairs from each answer key section
  // Two-step: match question number, then grab ALL letters after it
  // Handles: "180. A, C"  "181. A, B, C"  "182. ABCD"  "Q183. B and D"
  const qNumRe = /(?:^|[\s,;|])(?:Q\.?\s*)?(\d+)\s*[\.\-\)\(:]+\s*/g

  for (let si = 0; si < ansKeySections.length; si++) {
    const { lineIdx, chapterKey } = ansKeySections[si]
    const endLine = ansKeySections[si + 1]?.lineIdx ?? rawLines.length
    if (!chapterAnswers[chapterKey]) chapterAnswers[chapterKey] = {}

    // Scan lines in this answer key section
    for (let li = lineIdx + 1; li < endLine; li++) {
      const t = rawLines[li].trim()
      if (!t) continue

      // Stop if we hit a new major heading that looks like a question section
      // (a chapter heading that is NOT an answer key)
      const isNewChapter = chapterBoundaries.some(b => b.index === lineIndex[li])
      if (isNewChapter) break

      // Extract all Q→A pairs from this line
      // Strategy: find each question number, then extract ALL A-D letters that follow
      //           until the next question number or end of line
      const qMatches = [...t.matchAll(new RegExp(qNumRe.source, qNumRe.flags))]
      for (let qi = 0; qi < qMatches.length; qi++) {
        const qm = qMatches[qi]
        const qn = qm[1]
        const afterQ = qm.index + qm[0].length
        const nextQ = qMatches[qi + 1]?.index ?? t.length
        const answerPart = t.slice(afterQ, nextQ)
        const letters = [...answerPart.matchAll(/([A-Da-d])/g)].map(m => m[1].toUpperCase())
        if (letters.length > 0) {
          chapterAnswers[chapterKey][`q${qn}`] = letters[0] // Strictly 1 answer
        }
      }
    }

    console.log(`[parser] ${chapterKey}: captured ${Object.keys(chapterAnswers[chapterKey]).length} answers`)
  }


  // 5. Parse questions and assign correct answers
  //    For "plain" docs (no chapters, inline answers):
  //    - Options marked with ●, ✓, ★, or (Correct) → that option is the answer
  //    - Lines after "Explanation:" / "Rationale:" → stored as explanation text
  //    - correctIndex set from inline marker
  //    For "chapter" docs:
  //    - correctIndex comes from chapterAnswers (answer key sections)
  const keySheet = {}
  const parsedQuestions = []
  let bidx = 0
  const isChapterDoc = chapterBoundaries.length > 1 || ansKeySections.length > 0

  let autoQNum = 1
  for (const part of parts) {
    let qNum = parseInt(part.num, 10)
    // Fix: Ensure question numbering starts at 1, even if 0 is parsed
    if (isNaN(qNum) || qNum === 0) {
      qNum = autoQNum
    }
    autoQNum = qNum + 1

    const content = (part.content || '').trim()
    if (content.length < 5) continue

    const chKey = getChapterKey(part.startIdx)

    // Skip pure answer-key entries
    const ansOnlyPattern = /^[\-\.\)\(]?\s*\(?[A-Da-d]\)?(?:\s+\d+[\.\-\)\(]+\s*\(?[A-Da-d]\)?)*\s*$/
    if (ansOnlyPattern.test(content) && chapterAnswers[chKey]?.[`q${qNum}`]) continue

    const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
    let qLines = [], options = [], optionExplanations = [], correctIndices = [], mode = 'question'
    let explanationLines = []

    // Helper: check if a line looks like explanation prose (URL, reference, long prose, etc.)
    function looksLikeExplanationContinuation(l) {
      // Lines that are clearly part of an explanation
      if (/^(?:Refer|See|Source|https?:|www\.)/i.test(l)) return true
      if (/^(?:Explanation|Rationale|Reason|Note|Solution)\s*[:\-]/i.test(l)) return true
      // Lines containing URLs mid-text
      if (/https?:\/\/\S{10,}/.test(l)) return true
      // Lines that start with a number followed by a period (numbered explanation steps like "1. ...")
      if (/^[0-9]+\.\s/.test(l) && mode === 'explanation') return true
      return false
    }

    for (const line of lines) {
      // ── Detect explanation anywhere in the block ──
      // "Explanation:", "Explanation:-", "Rationale:", etc.
      const explMatch = line.match(/^(?:Explanation|Rationale|Reason|Note|Solution)\s*[:\-]+\s*(.*)/i)
      if (explMatch) {
        mode = 'explanation'
        if (explMatch[1].trim()) explanationLines.push(explMatch[1].trim())
        continue
      }

      // ── In explanation mode: check if the line is still explanation or a new option ──
      if (mode === 'explanation') {
        // If line looks like explanation continuation, keep collecting
        if (looksLikeExplanationContinuation(line)) {
          explanationLines.push(line)
          continue
        }
        // If the line is short enough to be a bare option AND doesn't look like prose,
        // treat it as a new option (explanation is over, resume option capture)
        // Explanation prose tends to be longer sentences with lowercase starts
        const isProse = line.length > 80 && /^[a-z]/.test(line)
        if (isProse) {
          explanationLines.push(line)
          continue
        }
        // Check if this line is part of a multi-line explanation paragraph
        // (if last explanation line didn't end with period/etc, this could be continuation)
        const lastExpl = explanationLines[explanationLines.length - 1] || ''
        const lastEndsClean = /[.!?\)]$/.test(lastExpl.trim()) || lastExpl.trim().length === 0
        if (!lastEndsClean && line.length > 40 && /^[a-z]/.test(line)) {
          explanationLines.push(line)
          continue
        }
        // Otherwise, this line is likely a new bare option — switch back to options mode
        mode = 'options'
        // Fall through to option handling below
      }

      // ── Detect "Answer: X" or "Correct: X, Y" lines ──
      const ansMatch = line.match(/^(?:Answer|Ans|Key|Correct)\s*[:\-]?\s*(.*)/i)
      if (ansMatch) {
        const potentialLetters = ansMatch[1]
        const found = [...potentialLetters.matchAll(/([A-Da-d])/g)].map(m => m[1].toUpperCase().charCodeAt(0) - 65)
        if (found.length > 0) {
          correctIndices = found
          mode = 'done'
          continue
        }
      }

      // ── Detect option lines with explicit letter prefix ──
      // PREFIX_CHARS: generic bullets used for any option
      const PREFIX_CHARS = '●•◦○▪▫➡→▶►'
      // CORRECT_CHARS: specific markers that mean "this is the answer"
      const CORRECT_CHARS = '✓✔✅★☑🟢'
      const ALL_MARKERS = PREFIX_CHARS + CORRECT_CHARS

      const MARKER_RE = new RegExp('[' + CORRECT_CHARS + ']')
      const PREFIX_RE = new RegExp('^((?:[' + ALL_MARKERS + ']\\s*)?)\\s*[\\(\\[○]?\\s*([A-F])[\\)\\]\\.\\:\\-]\\s+(.+)$', 'i')

      const optMatch = line.match(PREFIX_RE)

      if (optMatch && mode !== 'done') {
        let optText = optMatch[3].trim()
        let optExplanation = ''

        // If option text contains "Explanation:" mid-way, split it out
        const explInOpt = optText.match(/\s*(?:Explanation|Rationale)\s*[:\-]+\s*(.*)/i)
        if (explInOpt) {
          optExplanation = explInOpt[1].trim()
          optText = optText.slice(0, explInOpt.index).trim()
          if (optExplanation) optionExplanations.push(optExplanation)
          mode = 'explanation'
        }

        const cleanText = optText
          .replace(/\s*\(?\s*(?:correct|answer|right)\s*\)?\s*$/i, '')
          .replace(new RegExp('[' + ALL_MARKERS + ']\\s*$'), '')
          .trim()

        if (cleanText) {
          options.push(cleanText)
          if (!optExplanation) optionExplanations.push('')
        }

        // Mark as correct if there's a leading marker OR trailing marker/word
        const hasLeadingMarker = optMatch[1] && MARKER_RE.test(optMatch[1])
        const hasTrailingCorrect = /\(?\s*(?:correct|answer|right)\s*\)?\s*$/i.test(optText) || MARKER_RE.test(optText.slice(-3))
        if (hasLeadingMarker || hasTrailingCorrect) {
          correctIndices.push(options.length - 1)
          console.log(`[parser] q${qNum}: option ${String.fromCharCode(64 + options.length)} marked correct via marker "${(optMatch[1] || '').trim()}"`)
        }

        // Also mark correct if this option has an inline explanation (only correct answers get explanations)
        if (optExplanation && !hasLeadingMarker && !hasTrailingCorrect) {
          correctIndices.push(options.length - 1)
          console.log(`[parser] q${qNum}: option ${String.fromCharCode(64 + options.length)} marked correct via inline explanation`)
        }

        if (mode !== 'explanation') mode = 'options'
        continue
      }

      // ── Question text capture ──
      if (mode === 'question') {
        qLines.push(line)
        // If the line contains '?', question text is complete — switch to awaiting options
        if (line.includes('?')) {
          mode = 'options'
        }
      } else if (mode === 'options') {
        // Check for embedded explanation
        const explInCont = line.match(/^(?:Explanation|Rationale)\s*[:\-]+\s*(.*)/i)
        if (explInCont) {
          mode = 'explanation'
          if (explInCont[1].trim()) explanationLines.push(explInCont[1].trim())
          // If we're in explanation mode after an option, that option is likely correct
          // Track this option as correct (last added option)
          if (options.length > 0 && !correctIndices.includes(options.length - 1)) {
            correctIndices.push(options.length - 1)
            console.log(`[parser] q${qNum}: option ${String.fromCharCode(64 + options.length)} marked correct via following Explanation block`)
          }
        } else {
          // Treat each standalone line as a NEW bare option (no letter prefix format)
          // This handles PDFs where options are just plain text lines without A/B/C/D
          options.push(line)
          optionExplanations.push('')
        }
        }
    }

    let qText = qLines.join(' ').replace(/\s+/g, ' ').trim()
    qText = qText.replace(/\s*\(?\s*(?:choose|select|pick)\s*(?:all|multiple|\d+|two|three|four)\s*\)?/gi, '')

    // Merge scanned answer key with inline markers — never discard inline-found answers
    const scanned = chapterAnswers[chKey]?.[`q${qNum}`]
    if (scanned) {
      const found = [...scanned.matchAll(/([A-Da-d])/g)].map(m => m[1].toUpperCase().charCodeAt(0) - 65)
      if (found.length > 0) {
        if (found.length >= correctIndices.length) {
          correctIndices = found
        } else {
          correctIndices = [...new Set([...correctIndices, ...found])].sort((a, b) => a - b)
        }
      }
    }

    const explanation = explanationLines.join(' ').replace(/\s+/g, ' ').trim()

    // Build per‑option explanation map (A, B, C, D …)
    const optionExplanationMap = {}
    options.forEach((_, i) => {
      const letter = String.fromCharCode(65 + i)
      if (optionExplanations[i]) optionExplanationMap[letter] = optionExplanations[i]
    })

    const finalOptions = options.length >= 2 ? options.slice(0, 4) : ['A', 'B', 'C', 'D']
    let finalCorrects = [...new Set(correctIndices)].sort((a, b) => a - b)
    if (finalCorrects.length === 0) finalCorrects = [0]
    
    // STRICT CAP: Force only 1 answer ever. All questions are converted to single-choice.
    finalCorrects = finalCorrects.slice(0, 1)

    const question = {
      id: `q-${Date.now()}-${bidx++}`,
      question: qText || `Question ${qNum}`,
      options: finalOptions,
      correctIndices: finalCorrects,
      chapter: chKey,
      chapterHeading: chapterHeadings[chKey],
      qNum,
      optionExplanations: optionExplanationMap,
    }
    question.indicesText = question.correctIndices.map(i => String.fromCharCode(65 + i)).join(', ')

    if (explanation) question.explanation = explanation
    question.correctIndex = question.correctIndices[0]

    parsedQuestions.push(question)

    if (!keySheet[chKey]) keySheet[chKey] = {}
    keySheet[chKey][`q${qNum}`] = question.indicesText
  }

// Build keySheetList from the union of parsed questions and scanned answer keys
const allChapterKeys = new Set([
  ...Object.keys(keySheet),
  ...Object.keys(chapterAnswers).filter(k => chapterHeadings[k])
])
const keySheetList = [...allChapterKeys]
  .sort((a, b) => parseInt(a.match(/\d+/)?.[0] || 0) - parseInt(b.match(/\d+/)?.[0] || 0))
  .map(chKey => ({
    chapter: chKey,
    heading: chapterHeadings[chKey] || chKey,
    answers: { ...(chapterAnswers[chKey] || {}), ...(keySheet[chKey] || {}) }
  }))
  .filter(entry => Object.keys(entry.answers).length > 0)

// docType: 'chapters' if multi-chapter with answer keys, 'plain' otherwise
const docType = isChapterDoc ? 'chapters' : 'plain'
console.log(`[parser] docType: ${docType}, chapters: ${chapterBoundaries.length}, questions: ${parsedQuestions.length}`)

const storeId = `mock-store-${Date.now()}`
fs.writeFileSync(
  path.join(STORE_DIR, `${storeId}.json`),
  JSON.stringify({ questions: parsedQuestions, keySheetList, docType })
)
return {
  fileSearchStoreName: storeId,
  sourceDisplayName: displayName,
  questions: parsedQuestions,
  keySheetList,
  docType,
}
}

export async function runGenerateExam(ai, input) {
  const { fileSearchStoreName } = input
  const fPath = path.join(STORE_DIR, `${fileSearchStoreName}.json`)
  const data = fs.existsSync(fPath)
    ? JSON.parse(fs.readFileSync(fPath, 'utf8'))
    : { questions: [], keySheetList: [] }
  return data
}
