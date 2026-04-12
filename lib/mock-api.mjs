import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

// Polyfills for pdfjs-dist in Node.js environments (Must be defined before pdf-parse is imported)
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() {
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    }
  };
}
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    addPath() {}
    closePath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_DIR = path.join(os.tmpdir(), 'mock-stores')

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true })

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

export function mimeForFileSearch(file) {
  const name = file.originalname || file.originalFilename || ''
  const mt = normalizedMime(file.mimetype)
  if (ALLOWED_MIMES.has(mt)) return mt
  const ext = extOf(name)
  return EXT_TO_MIME[ext] || 'text/plain'
}

export async function runFileSearchUpload(ai, input) {
  const { filePath, displayName, storeMime } = input
  
  let rawText = ''
  try {
    if (storeMime === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
       // Use dynamic import to ensure polyfills above are applied BEFORE pdf-parse initializes
       const [{ PDFParse }, pdfjs] = await Promise.all([
          import('pdf-parse'),
          import('pdfjs-dist/legacy/build/pdf.mjs')
       ])
       
       // Vercel path for the nested worker found in the error logs
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
    console.error('Failed to parse file text locally:', e)
  }

  console.log(`[Parser] Raw text extracted: ${rawText.length} characters.`);

  // More universal splitter: handles \r\n and \n correctly across Windows/Vercel
  let rawBlocks = rawText.split(/(?:\r?\n|^)\s*((?:Question\s*)?\d+[\.\):]|Q\d+[\.\):]|\d+\s*[\)\:])(?:\s+|$)/gi)
  
  // Emergency fallback: if primary splitter found nothing but we have text, try splitting by just the numbers
  if (rawBlocks.length <= 2 && rawText.length > 500) {
     console.log("[Parser] Primary split failed, attempting aggressive split...");
     rawBlocks = rawText.split(/\s*((?:Question\s*)?\d+[\.\):]|Q\d+[\.\):]|\d+\s*[\)\:])\s+/gi);
  }

  console.log(`[Parser] Split into ${rawBlocks.length} blocks.`);

  let parsedQuestions = []
  
  for (let i = 0; i < rawBlocks.length; i++) {
     const part = rawBlocks[i];
     if (!part || part.trim().length === 0) continue;

     const isMarker = /^((?:Question\s*)?\d+[\.\):]|Q\d+[\.\):]|\d+\s*[\)\:])$/i.test(part.trim());
     
     if (isMarker && i + 1 < rawBlocks.length) {
        const marker = part;
        const content = rawBlocks[i + 1];
        i++; 
        
        const fullContent = (marker + content).trim();
        
        // Symbols from the PDF:  (empty/wrong),  (checked/correct)
        const HAS_SYMBOLS = /|/.test(fullContent);

        // 1. Extract Answer Key
        let extractedCorrectIndex = -1;
        
        // If we have symbols, the one with  is correct
        if (HAS_SYMBOLS) {
           const symbolLines = fullContent.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
           const correctLineIdx = symbolLines.findIndex(l => l.includes(''));
           if (correctLineIdx !== -1) {
              // Usually the question is line 0, so options start at 1
              extractedCorrectIndex = Math.max(0, correctLineIdx - 1);
           }
        }

        if (extractedCorrectIndex === -1) {
           const answerRegex = /(?:Answer|Correct|Key|Ans)\s*[:\-]?\s*[\(\[]?([A-Fa-f1-6])[\)\]\.]?/i;
           const answerMatch = fullContent.match(answerRegex);
           if (answerMatch) {
              const val = answerMatch[1].toUpperCase();
              if (/[A-F]/.test(val)) extractedCorrectIndex = val.charCodeAt(0) - 65;
              else if (/[1-6]/.test(val)) extractedCorrectIndex = parseInt(val) - 1;
           }
        }

        // 2. Extract Options using symbols or markers
        let options = [];
        let firstOptPos = -1;

        if (HAS_SYMBOLS) {
           // Split by the symbol characters
           const parts = fullContent.split(/[]/).map(p => p.trim()).filter(p => p.length > 0);
           if (parts.length >= 3) {
              // parts[0] is question, rest are options
              options = parts.slice(1, 5);
              firstOptPos = fullContent.indexOf(parts[1]);
           }
        }

        if (options.length === 0) {
           const potentialMarkers = [];
           const markerScanner = /(?:\n|\s|^)[\[\(]?([A-Fa-f1-6])[\]\.\)\:\-](?:\s+|$)/g;
           let m;
           while ((m = markerScanner.exec(fullContent)) !== null) {
              potentialMarkers.push({ 
                 val: m[1].toUpperCase(), 
                 index: m.index, 
                 length: m[0].length 
              });
           }

           // Verify sequence
           let optMarkers = [];
           if (potentialMarkers.length >= 2) {
              let currentSeq = [potentialMarkers[0]];
              for (let j = 1; j < potentialMarkers.length; j++) {
                 const prev = currentSeq[currentSeq.length - 1].val;
                 const curr = potentialMarkers[j].val;
                 const isNextLetter = curr.charCodeAt(0) === prev.charCodeAt(0) + 1;
                 const isNextNum = !isNaN(curr) && parseInt(curr) === parseInt(prev) + 1;
                 if (isNextLetter || isNextNum) currentSeq.push(potentialMarkers[j]);
                 else if (currentSeq.length < 2) currentSeq = [potentialMarkers[j]];
                 else break;
              }
              if (currentSeq.length >= 2) optMarkers = currentSeq;
           }

           if (optMarkers.length >= 2) {
              firstOptPos = optMarkers[0].index;
              for (let idx = 0; idx < optMarkers.length; idx++) {
                 const start = optMarkers[idx].index + optMarkers[idx].length;
                 const end = (idx + 1 < optMarkers.length) ? optMarkers[idx + 1].index : fullContent.length;
                 let optText = fullContent.substring(start, end).trim();
                 optText = optText.replace(/(?:Answer|Correct|Key|Ans|Explanation).*/is, '').trim();
                 if (optText) options.push(optText);
              }
           }
        }

        // Advanced Fallback: Check if the last option has sub-choices
        if (options.length > 0) {
           const lastOptText = options[options.length - 1];
           const subChoices = lastOptText.split(/\n+/).map(l => l.trim()).filter(l => l.length > 1);
           if (subChoices.length >= 3 && subChoices.length <= 6) {
              options = subChoices;
           }
        }

        // 3. Extract Question Text
        let qText = firstOptPos > -1 ? fullContent.substring(0, firstOptPos).trim() : fullContent.trim();
        
        // Line-based fallback (very conservative)
        if (options.length === 0) {
           const lines = fullContent.split('\n').map(l => l.trim()).filter(l => l.length > 1);
           if (lines.length >= 5) {
              qText = lines[0];
              options = lines.slice(1, 5);
           }
        }

        qText = qText.replace(/(?:Answer|Correct|Key|Ans|Explanation).*/is, '').replace(/\s+/g, ' ').trim();

        if (qText && qText.length > 3) {
          parsedQuestions.push({
            id: `q-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            question: qText,
            options: options.length >= 2 ? options.slice(0, 4) : ['Option A', 'Option B', 'Option C', 'Option D'],
            correctIndex: extractedCorrectIndex >= 0 && extractedCorrectIndex < 4 
               ? extractedCorrectIndex 
               : Math.floor(Math.random() * (options.length >= 2 ? Math.min(options.length, 4) : 4))
          })
        }
     }
  }

  console.log(`[Parser] Successfully parsed ${parsedQuestions.length} questions.`);

  // Fallback chunker if text format was utterly unrecognizable
  if (parsedQuestions.length === 0) {
     const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean)
     for (let i = 0; i < lines.length; i += 5) {
       const chunk = lines.slice(i, i + 5)
       if (chunk.length >= 2) {
          parsedQuestions.push({
             id: `q-${i}`,
             question: chunk[0],
             options: [
               chunk[1] || 'Extracted Option A',
               chunk[2] || 'Extracted Option B',
               chunk[3] || 'Extracted Option C',
               chunk[4] || 'Extracted Option D'
             ],
             correctIndex: Math.floor(Math.random() * 4)
          })
       }
     }
  }
  
  if (parsedQuestions.length === 0) {
      parsedQuestions.push({
         id: 'fb-1',
         question: 'Fallback template (no questions detected in document)',
         options: ['A', 'B', 'C', 'D'],
         correctIndex: 0
      })
  }

  const storeId = `mock-store-${Date.now()}-${Math.random().toString(36).substr(2,5)}`
  fs.writeFileSync(path.join(STORE_DIR, `${storeId}.json`), JSON.stringify(parsedQuestions))

  return {
    fileSearchStoreName: storeId,
    sourceDisplayName: displayName,
    sourceMimeType: storeMime,
    pdfDisplayName: displayName,
    questionCandidates: parsedQuestions.length,
    questions: parsedQuestions
  }
}

export async function runGenerateExam(ai, input) {
  const { fileSearchStoreName, questionCount } = input
  const n = questionCount || 20
  
  const fPath = path.join(STORE_DIR, `${fileSearchStoreName}.json`)
  let questions = []
  if (fs.existsSync(fPath)) {
      questions = JSON.parse(fs.readFileSync(fPath, 'utf8'))
  } else {
      questions = [
        {
          id: 'error-q',
          question: 'Document cache missing. Please re-upload.',
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 0
        }
      ]
  }
  
  return { questions: questions.slice(0, n) }
}
