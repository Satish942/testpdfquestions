import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const SESSION_KEY = 'rag-gemini-session'
const HISTORY_KEY = 'rag-gemini-score-history'

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    const label = s?.sourceDisplayName || s?.pdfDisplayName
    if (s?.fileSearchStoreName && label) {
      return { fileSearchStoreName: s.fileSearchStoreName, sourceDisplayName: label }
    }
  } catch {
    /* ignore */
  }
  return null
}

const CLIENT_ALLOWED_EXT = new Set([
  'pdf',
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'docx',
])

function clientAllowedFile(file) {
  const ext = file.name?.split('.').pop()?.toLowerCase()
  if (ext && CLIENT_ALLOWED_EXT.has(ext)) return true
  const m = (file.type || '').split(';')[0].trim().toLowerCase()
  const ok =
    m === 'application/pdf' ||
    m === 'text/plain' ||
    m === 'text/markdown' ||
    m === 'application/json' ||
    m === 'text/csv' ||
    m.includes('wordprocessingml.document')
  return ok
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const h = JSON.parse(raw)
    return Array.isArray(h) ? h : []
  } catch {
    return []
  }
}

export default function App() {
  const [tab, setTab] = useState('upload')
  const [session, setSession] = useState(() => loadSession())
  const [history, setHistory] = useState(() => loadHistory())
  const [questionCount, setQuestionCount] = useState(5)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [examBusy, setExamBusy] = useState(false)
  const [examError, setExamError] = useState('')
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [phase, setPhase] = useState('idle')
  const [scoreSummary, setScoreSummary] = useState(null)

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }, [history])

  const persistSession = useCallback((s) => {
    setSession(s)
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  }, [])

  const onUpload = async (file) => {
    if (!file || !clientAllowedFile(file)) {
      setUploadMsg(
        'Please choose a supported file: PDF, TXT, MD, JSON, CSV, or DOCX.',
      )
      return
    }
    setUploadBusy(true)
    setUploadMsg('Uploading and indexing your file (this can take a minute)…')
    const fd = new FormData()
    fd.append('document', file)
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)
      const label = data.sourceDisplayName || data.pdfDisplayName || file.name
      persistSession({
        fileSearchStoreName: data.fileSearchStoreName,
        sourceDisplayName: label,
      })
      setUploadMsg(`Ready: ${label} is indexed for exams.`)
    } catch (e) {
      setUploadMsg(e.message || 'Upload failed')
    } finally {
      setUploadBusy(false)
    }
  }

  const startExam = async () => {
    if (!session) return
    setExamBusy(true)
    setExamError('')
    setQuestions([])
    setAnswers({})
    setPhase('idle')
    setScoreSummary(null)
    try {
      const res = await fetch('/api/generate-exam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileSearchStoreName: session.fileSearchStoreName,
          questionCount,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)
      setQuestions(data.questions || [])
      setPhase('taking')
      setTab('exam')
    } catch (e) {
      setExamError(e.message || 'Could not generate exam')
    } finally {
      setExamBusy(false)
    }
  }

  const submitExam = () => {
    if (!questions.length) return
    let correct = 0
    for (const q of questions) {
      if (answers[q.id] === q.correctIndex) correct += 1
    }
    const total = questions.length
    const pct = total ? Math.round((correct / total) * 1000) / 10 : 0
    setScoreSummary({ correct, total, pct })
    setPhase('results')
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      score: correct,
      total,
      sourceDisplayName:
        session?.sourceDisplayName || session?.pdfDisplayName || 'Exam',
      pct,
    }
    setHistory((h) => [entry, ...h].slice(0, 50))
  }

  const resetExam = () => {
    setQuestions([])
    setAnswers({})
    setPhase('idle')
    setScoreSummary(null)
    setExamError('')
  }

  const sessionBadge = useMemo(() => {
    if (!session) return null
    return (
      <span className="badge">
        Indexed: {session.sourceDisplayName}
      </span>
    )
  }, [session])

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Gemini RAG exam</h1>
        <p className="app-sub">
          Upload study material (PDF, Word, or text: notes, Q&amp;A, or existing multiple-choice).
          It is indexed with Gemini File Search, then you generate a 4-option exam. Scores stay in this browser only.
        </p>
      </header>

      <div className="glass tabs">
        <button
          type="button"
          className={`tab ${tab === 'upload' ? 'tab-active' : ''}`}
          onClick={() => setTab('upload')}
        >
          1 · Upload material
        </button>
        <button
          type="button"
          className={`tab ${tab === 'exam' ? 'tab-active' : ''}`}
          onClick={() => setTab('exam')}
          disabled={!session}
        >
          2 · Exam
        </button>
      </div>

      {tab === 'upload' && (
        <section className="glass panel">
          <h2>Upload study material</h2>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            PDF, DOCX, TXT, Markdown, JSON, or CSV (max 100 MB). Plain Q&amp;A lists and
            existing MCQ banks both work—the model adapts from what it retrieves.
            API key stays on the dev server (<code>.env</code>), not in the bundle.
          </p>

          <label className="dropzone" style={{ marginTop: '1rem' }}>
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown,.json,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/json,text/csv"
              disabled={uploadBusy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) onUpload(f)
              }}
            />
            {uploadBusy ? (
              <span>
                <span className="spinner" aria-hidden />
                Indexing…
              </span>
            ) : (
              <span>Click or drop a file here</span>
            )}
          </label>

          <div className="row">
            <div className="field">
              <label htmlFor="qc">Questions per exam</label>
              <input
                id="qc"
                type="number"
                min={1}
                max={50}
                value={questionCount}
                onChange={(e) =>
                  setQuestionCount(
                    Math.min(50, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!session || examBusy}
              onClick={startExam}
            >
              {examBusy ? 'Generating…' : 'Generate & open exam'}
            </button>
          </div>

          {sessionBadge}
          {uploadMsg && (
            <p className={`status ${uploadMsg.includes('fail') || uploadMsg.includes('Please') ? 'status-error' : ''}`}>
              {uploadMsg}
            </p>
          )}
          {examError && <p className="status status-error">{examError}</p>}

          <div style={{ marginTop: '1.25rem' }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!session}
              onClick={() => {
                persistSession(null)
                resetExam()
                setUploadMsg('Cleared indexed material from this browser.')
              }}
            >
              Clear indexed file
            </button>
          </div>
        </section>
      )}

      {tab === 'exam' && session && (
        <section className="glass panel">
          <h2>Exam</h2>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            {session.sourceDisplayName} · {questions.length || questionCount} question
            {(questions.length || questionCount) !== 1 ? 's' : ''}
          </p>

          {!questions.length && (
            <div style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={examBusy}
                onClick={startExam}
              >
                {examBusy ? 'Generating…' : `Generate ${questionCount} questions`}
              </button>
              {examError && <p className="status status-error">{examError}</p>}
            </div>
          )}

          {phase === 'results' && scoreSummary && (
            <div className="glass-inset result-banner" style={{ marginTop: '1rem' }}>
              <h2>Result</h2>
              <p className="result-pct">{scoreSummary.pct}%</p>
              <p className="muted">
                {scoreSummary.correct} correct out of {scoreSummary.total}
              </p>
            </div>
          )}

          {questions.map((q, qi) => (
            <div key={q.id} className="glass-inset question-block">
              <div className="question-title">
                {qi + 1}. {q.question}
              </div>
              {q.options.map((opt, oi) => {
                const selected = answers[q.id] === oi
                const show = phase === 'results'
                const isCorrect = oi === q.correctIndex
                let cls = 'option'
                if (show) {
                  if (isCorrect) cls += ' option-correct'
                  else if (selected && !isCorrect) cls += ' option-wrong'
                }
                return (
                  <label key={oi} className={cls}>
                    <input
                      type="radio"
                      name={q.id}
                      checked={selected}
                      disabled={phase === 'results'}
                      onChange={() =>
                        setAnswers((a) => ({ ...a, [q.id]: oi }))
                      }
                    />
                    <span>{String.fromCharCode(65 + oi)}. {opt}</span>
                  </label>
                )
              })}
            </div>
          ))}

          {questions.length > 0 && phase === 'taking' && (
            <button type="button" className="btn btn-primary" onClick={submitExam}>
              Submit answers
            </button>
          )}

          {questions.length > 0 && phase === 'results' && (
            <button type="button" className="btn btn-ghost" style={{ marginLeft: '0.5rem' }} onClick={resetExam}>
              Clear exam (keep indexed file)
            </button>
          )}
        </section>
      )}

      <section className="glass history">
        <h2>Score history</h2>
        <p className="muted">Stored locally in your browser (last 50 runs).</p>
        {history.length === 0 ? (
          <p className="muted" style={{ marginTop: '0.5rem' }}>
            No attempts yet.
          </p>
        ) : (
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <span>
                  {new Date(h.at).toLocaleString()} —{' '}
                  {h.sourceDisplayName || h.pdfDisplayName || 'Exam'}
                </span>
                <strong>
                  {h.score}/{h.total} ({h.pct}%)
                </strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
