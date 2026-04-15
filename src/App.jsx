import { useEffect, useRef, useState } from 'react'
import './App.css'

const HISTORY_SESSION_KEY = 'rag-exam-history-session'

function getOrCreateSessionKey() {
  try {
    let k = localStorage.getItem(HISTORY_SESSION_KEY)
    if (k && /^[0-9a-f-]{36}$/i.test(k)) return k
    k = crypto.randomUUID()
    localStorage.setItem(HISTORY_SESSION_KEY, k)
    return k
  } catch {
    return crypto.randomUUID()
  }
}

const CLIENT_ALLOWED_EXT = new Set(['pdf', 'txt', 'md', 'markdown', 'json', 'csv', 'docx'])

function clientAllowedFile(file) {
  const ext = file.name?.split('.').pop()?.toLowerCase()
  if (ext && CLIENT_ALLOWED_EXT.has(ext)) return true
  const m = (file.type || '').split(';')[0].trim().toLowerCase()
  return (
    m === 'application/pdf' ||
    m === 'text/plain' ||
    m === 'text/markdown' ||
    m === 'application/json' ||
    m === 'text/csv' ||
    m.includes('wordprocessingml.document')
  )
}

export default function App() {
  const [tab, setTab] = useState('library')
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [documents, setDocuments] = useState([])

  const [questionCount, setQuestionCount] = useState(5)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')

  // Exam state
  const [examBusy, setExamBusy] = useState(false)
  const [examError, setExamError] = useState('')
  const [questions, setQuestions] = useState([])
  const [answers, setAnswers] = useState({})
  const [phase, setPhase] = useState('idle')
  const [scoreSummary, setScoreSummary] = useState(null)

  // Load documents on mount
  useEffect(() => {
    const sessionKey = getOrCreateSessionKey()
      ; (async () => {
        try {
          const res = await fetch('/api/documents', {
            headers: { 'X-Session-Key': sessionKey },
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) return
          setDocuments(data.items || [])
        } catch (e) {
          console.warn('Documents API:', e)
        }
      })()
  }, [])

  const onUpload = async (file) => {
    if (!file || !clientAllowedFile(file)) {
      setUploadMsg('Please choose a supported file: PDF, TXT, MD, JSON, CSV, or DOCX.')
      return
    }
    setUploadBusy(true)
    setUploadMsg('Uploading and processing your document (this can take a minute)…')
    const fd = new FormData()
    fd.append('document', file)
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)

      const label = data.sourceDisplayName || file.name
      const questionsFromData = data.questions || []

      const docRes = await fetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Key': getOrCreateSessionKey(),
        },
        body: JSON.stringify({
          sourceDisplayName: label,
          questions: questionsFromData,
          keySheetList: data.keySheetList || [],
          docType: data.docType || 'plain',
        }),
      })

      const docData = await docRes.json().catch(() => ({ error: 'Failed to parse response.' }))
      if (!docRes.ok) throw new Error(docData.error || docRes.statusText)

      setDocuments((prev) => [docData, ...prev])
      const chapCount = (docData.keySheetList || []).length
      setUploadMsg(
        `✅ Processed: ${docData.questions?.length || 0} questions across ${chapCount} chapter(s) — "${label}" added to Library.`
      )
    } catch (e) {
      setUploadMsg(e.message || 'Upload failed')
    } finally {
      setUploadBusy(false)
    }
  }

  const deleteDocument = async (docId) => {
    try {
      const res = await fetch(`/api/documents?id=${docId}`, {
        method: 'DELETE',
        headers: { 'X-Session-Key': getOrCreateSessionKey() },
      })
      if (res.ok) {
        setDocuments((prev) => prev.filter((d) => d.id !== docId))
        if (selectedDocument?.id === docId) {
          setSelectedDocument(null)
          setTab('library')
        }
      }
    } catch (e) {
      console.error('Failed to delete document', e)
    }
  }

  const startExam = () => {
    if (!selectedDocument) return
    setExamBusy(true)
    setExamError('')
    setQuestions([])
    setAnswers({})
    setPhase('idle')
    setScoreSummary(null)

    try {
      const pool = selectedDocument.questions || []
      if (pool.length === 0) throw new Error('No questions available.')

      // Sort: chapter order, then by qNum within chapter
      const sortedPool = [...pool].sort((a, b) => {
        const ca = parseInt(a.chapter?.match(/\d+/)?.[0] || 0)
        const cb = parseInt(b.chapter?.match(/\d+/)?.[0] || 0)
        if (ca !== cb) return ca - cb
        return parseInt(a.qNum || 0) - parseInt(b.qNum || 0)
      })

      let enriched
      if (selectedDocument.docType === 'chapters') {
        // ── Chapter-wise doc: build flat sequential answer array from keySheetList ──
        const flatCorrects = []
        const sortedChapters = [...(selectedDocument.keySheetList || [])].sort(
          (a, b) =>
            parseInt(a.chapter.match(/\d+/)?.[0] || 0) -
            parseInt(b.chapter.match(/\d+/)?.[0] || 0)
        )
        for (const chEntry of sortedChapters) {
          const sortedPairs = Object.entries(chEntry.answers || {}).sort(
            (a, b) =>
              parseInt(a[0].match(/\d+/)?.[0] || 0) -
              parseInt(b[0].match(/\d+/)?.[0] || 0)
          )
          for (const [, letters] of sortedPairs) {
            const indices = [...(letters || '').matchAll(/([A-Fa-f])/g)].map(m => m[1].toUpperCase().charCodeAt(0) - 65)
            flatCorrects.push(indices)
          }
        }
        enriched = sortedPool.map((q, i) => {
          const indices = flatCorrects[i] || (q.correctIndices && q.correctIndices.length > 0 ? q.correctIndices : [q.correctIndex || 0])
          return {
            ...q,
            correctIndices: indices,
            correctIndex: indices[0],
          }
        })
      } else {
        // ── Plain doc: ensure correctIndices is present ──
        enriched = sortedPool.map(q => ({
          ...q,
          correctIndices: q.correctIndices || [q.correctIndex || 0]
        }))
      }

      setQuestions(enriched.slice(0, Math.min(questionCount, enriched.length)))
      setPhase('taking')
    } catch (e) {
      setExamError(e.message || 'Could not start exam')
    } finally {
      setExamBusy(false)
    }
  }

  const submitExam = () => {
    if (!questions.length) return
    let correct = 0
    for (const q of questions) {
      const correctIndices = q.correctIndices || [q.correctIndex || 0]
      const chosen = answers[q.id]
      const chosenIndices = Array.isArray(chosen) ? chosen : (chosen !== undefined ? [chosen] : [])

      const isCorrect = correctIndices.length === chosenIndices.length &&
        correctIndices.every(idx => chosenIndices.includes(idx))

      if (isCorrect) correct += 1
    }
    const total = questions.length
    const pct = total ? Math.round((correct / total) * 1000) / 10 : 0
    setScoreSummary({ correct, total, pct })
    setPhase('results')
  }

  const resetExam = () => {
    setQuestions([])
    setAnswers({})
    setPhase('idle')
    setScoreSummary(null)
    setExamError('')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Exam Vault</h1>
        <p className="app-sub">Process and study material with automated key mapping.</p>
      </header>

      <div className="glass tabs">
        {['library', 'exam', 'keysheet'].map((t) => (
          <button
            key={t}
            type="button"
            className={`tab ${tab === t ? 'tab-active' : ''}`}
            onClick={() => setTab(t)}
            disabled={t === 'exam' && !selectedDocument}
          >
            {t === 'keysheet' ? 'Key Sheet' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ── LIBRARY ── */}
      {tab === 'library' && (
        <section className="glass panel">
          <h2>Upload study material</h2>
          <label className="dropzone">
            <input
              type="file"
              disabled={uploadBusy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) onUpload(f)
              }}
            />
            <span>{uploadBusy ? 'Processing…' : 'Click or drop a file to add to Library'}</span>
          </label>
          {uploadMsg && <p className="status">{uploadMsg}</p>}

          <div style={{ marginTop: '2rem' }}>
            <h3>Document Vault</h3>
            {documents.length === 0 ? (
              <p className="muted" style={{ marginTop: '0.5rem' }}>No documents uploaded yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                {documents.map((d) => (
                  <div key={d.id} className="glass-inset" style={{ display: 'flex', alignItems: 'center', padding: '1rem', gap: '1rem' }}>
                    <div>
                      <strong>{d.sourceDisplayName}</strong>
                      <div className="muted" style={{ fontSize: '0.82rem', marginTop: '0.2rem' }}>
                        {d.questions?.length || d.questionCandidates || 0} questions
                        {d.keySheetList?.length ? ` · ${d.keySheetList.length} chapter(s)` : ''}
                      </div>
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                      <button className="btn btn-primary" onClick={() => { setSelectedDocument(d); setTab('exam'); resetExam() }}>Select</button>
                      <button className="btn btn-ghost" onClick={() => { setSelectedDocument(d); setTab('keysheet') }}>Key Sheet</button>
                      <button className="btn btn-ghost" style={{ color: '#f87171' }} onClick={() => deleteDocument(d.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── EXAM ── */}
      {tab === 'exam' && selectedDocument && (
        <section className="glass panel">
          <h2>Exam: {selectedDocument.sourceDisplayName}</h2>
          {examError && <p style={{ color: '#f87171' }}>{examError}</p>}
          {!questions.length ? (
            <div className="field">
              <label>Questions:</label>
              <input
                type="number"
                min={1}
                value={questionCount}
                onChange={(e) => setQuestionCount(Math.max(1, parseInt(e.target.value) || 1))}
              />
              <button className="btn btn-primary" onClick={startExam} disabled={examBusy}>
                {examBusy ? 'Loading…' : 'Start'}
              </button>
            </div>
          ) : (
            <>
              {phase === 'results' && scoreSummary && (
                <div className="glass-inset result-banner">
                  <h2>{scoreSummary.pct}%</h2>
                  <p>{scoreSummary.correct}/{scoreSummary.total} Correct</p>
                </div>
              )}
              {questions.map((q, qi) => {
                return (
                  <div key={q.id} className="glass-inset question-block">
                    <div className="question-title">
                      {qi + 1}. {q.question}
                    </div>
                    {q.options.map((opt, oi) => {
                      const isCorrect = (q.correctIndices || [q.correctIndex]).includes(oi)
                      const chosen = answers[q.id]
                      const isChosen = Array.isArray(chosen) ? chosen.includes(oi) : chosen === oi

                      let className = 'option'
                      if (phase === 'results') {
                        if (isCorrect) className += ' option-correct'
                        else if (isChosen) className += ' option-wrong'
                      }

                      return (
                        <div key={oi} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          <label className={className}>
                            <input
                              type="radio"
                              name={`q-${q.id}`}
                              checked={isChosen}
                              onChange={() => {
                                setAnswers((a) => ({ ...a, [q.id]: oi }))
                              }}
                              disabled={phase === 'results'}
                            />
                            <span>{String.fromCharCode(65 + oi)}. {opt}</span>
                            {phase === 'results' && isCorrect && (
                              <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--correct)', fontWeight: 700 }}>✓ Correct</span>
                            )}
                            {phase === 'results' && isChosen && !isCorrect && (
                              <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--wrong)', fontWeight: 700 }}>✗ Wrong</span>
                            )}
                          </label>
                          {phase === 'results' && q.optionExplanations?.[String.fromCharCode(65 + oi)] && (
                            <div style={{ marginLeft: '2.5rem', marginBottom: '0.5rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: 'rgba(251, 146, 60, 0.08)', fontSize: '0.8rem', color: '#000' }}>
                              <strong style={{ color: '#fb923c' }}>{String.fromCharCode(65 + oi)}:</strong> {q.optionExplanations[String.fromCharCode(65 + oi)]}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {/* Show global explanation only after exam is submitted */}
                    {phase === 'results' && q.explanation && (
                      <div style={{
                        marginTop: '0.75rem',
                        padding: '0.75rem 1rem',
                        borderRadius: '8px',
                        background: 'rgba(251, 146, 60, 0.12)',
                        border: '1px solid rgba(251, 146, 60, 0.35)',
                        fontSize: '0.88rem',
                        color: '#000000',
                        lineHeight: 1.5,
                      }}>
                        <strong style={{ color: '#fb923c' }}>Explanation:</strong> {q.explanation}
                      </div>
                    )}
                  </div>
                )
              })}
              {phase === 'taking' && (
                <button className="btn btn-primary" onClick={submitExam}>Submit</button>
              )}
              {phase === 'results' && (
                <button className="btn btn-ghost" onClick={() => { resetExam(); setTab('library') }}>Finish</button>
              )}
            </>
          )}
        </section>
      )}

      {/* ── KEY SHEET ── */}
      {tab === 'keysheet' && (
        <section className="glass panel">
          {!selectedDocument ? (
            <div style={{ textAlign: 'center', padding: '3rem' }}>
              <p className="muted">Select a document from the Library to view its Key Sheet.</p>
              <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => setTab('library')}>
                Go to Library
              </button>
            </div>
          ) : (
            <div className="keysheet-container">
              <h2>Key Sheet: {selectedDocument.sourceDisplayName}</h2>
              <p className="muted" style={{ marginTop: '0.25rem' }}>
                {selectedDocument.questionCandidates || selectedDocument.questions?.length || 0} questions
                {selectedDocument.keySheetList?.length ? ` · ${selectedDocument.keySheetList.length} chapter(s)` : ''}
              </p>
              {(() => {
                const list = selectedDocument.keySheetList || []
                if (list.length === 0) {
                  return <p className="muted" style={{ marginTop: '1.5rem' }}>No key sheet data. Please re-upload the PDF.</p>
                }
                return (
                  <div className="keysheet-layout" style={{ marginTop: '1.5rem' }}>
                    <div className="keysheet-main-view">
                      <h3>Chapter-wise Answer Keys</h3>
                      {list.map(({ chapter, heading, answers }) => (
                        <div key={chapter} className="glass-inset" style={{ marginBottom: '1.25rem', padding: '1.25rem' }}>
                          <h4 style={{ color: 'var(--accent)', marginBottom: '0.85rem' }}>{heading}</h4>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.1rem', fontFamily: 'monospace', fontSize: '0.95rem' }}>
                            {Object.entries(answers)
                              .sort((a, b) => parseInt(a[0].match(/\d+/)?.[0] || 0) - parseInt(b[0].match(/\d+/)?.[0] || 0))
                              .map(([qKey, ans]) => (
                                <span key={qKey}>
                                  <span className="muted">{qKey.toLowerCase()}-</span>
                                  <strong style={{ color: 'var(--correct)' }}>{ans}</strong>
                                </span>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="keysheet-map-sidebar glass-inset" style={{ padding: '1.25rem' }}>
                      <h3 style={{ marginBottom: '1rem' }}>Answer Map</h3>
                      {list.map(({ chapter, heading, answers }) => (
                        <div key={chapter} style={{ marginBottom: '1.25rem' }}>
                          <div style={{ fontWeight: 700, fontSize: '0.8rem', color: 'var(--accent)', marginBottom: '0.4rem' }}>{heading}</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.15rem 0.5rem', fontSize: '0.75rem' }}>
                            {Object.entries(answers)
                              .sort((a, b) => parseInt(a[0].match(/\d+/)?.[0] || 0) - parseInt(b[0].match(/\d+/)?.[0] || 0))
                              .map(([qKey, ans]) => (
                                <div key={qKey} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.1rem 0.3rem' }}>
                                  <span className="muted">{qKey.toLowerCase()}:</span>
                                  <strong style={{ color: 'var(--correct)' }}>{ans}</strong>
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
