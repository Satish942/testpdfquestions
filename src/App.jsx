import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const SESSION_KEY = 'rag-gemini-session'
const HISTORY_KEY = 'rag-gemini-score-history'
const HISTORY_SESSION_KEY = 'rag-exam-history-session'

function getOrCreateHistorySessionKey() {
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
  const [tab, setTab] = useState('library')
  const [selectedDocument, setSelectedDocument] = useState(null)
  
  const [documents, setDocuments] = useState([])
  const [history, setHistory] = useState(() => loadHistory())
  const [serverHistoryEnabled, setServerHistoryEnabled] = useState(null)
  const [historySaveError, setHistorySaveError] = useState('')
  const serverHistorySeeded = useRef(false)
  const serverDocsSeeded = useRef(false)

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
  const [selectedHistory, setSelectedHistory] = useState(null)

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }, [history])

  useEffect(() => {
    const sessionKey = getOrCreateHistorySessionKey()
    ;(async () => {
      try {
        const res = await fetch('/api/exam-history', {
          headers: { 'X-Session-Key': sessionKey },
        })
        const data = await res.json().catch(() => ({}))
        if (res.status === 503 && data.disabled) {
          setServerHistoryEnabled(false)
          return
        }
        if (!res.ok) {
          setServerHistoryEnabled(false)
          return
        }
        setServerHistoryEnabled(true)
        const rows = (data.items || []).map((x) => ({
          id: x.id,
          at: x.at,
          score: x.score,
          total: x.total,
          pct: x.pct,
          sourceDisplayName: x.sourceDisplayName || 'Exam',
          questionCandidates: x.questionCandidates,
          questions: x.questions,
          answers: x.answers,
        }))
        setHistory((prev) => {
          if (!serverHistorySeeded.current && rows.length === 0 && prev.length > 0) {
            serverHistorySeeded.current = true
            return prev
          }
          serverHistorySeeded.current = true
          return rows
        })
      } catch (e) {
        console.warn('Exam history API:', e)
        setServerHistoryEnabled(false)
      }
    })()
  }, [])

  useEffect(() => {
    const sessionKey = getOrCreateHistorySessionKey()
    ;(async () => {
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
      setUploadMsg(
        'Please choose a supported file: PDF, TXT, MD, JSON, CSV, or DOCX.',
      )
      return
    }
    setUploadBusy(true)
    setUploadMsg('Uploading and processing your document (this can take a minute)…')
    const fd = new FormData()
    fd.append('document', file)
    try {
      // 1. Upload file and store
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || res.statusText)
      
      const label = data.sourceDisplayName || file.name
      const questions = data.questions || []

      const docRes = await fetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Key': getOrCreateHistorySessionKey(),
        },
        body: JSON.stringify({
          sourceDisplayName: label,
          questionCandidates: questions.length,
          questions: questions
        })
      })
      
      const docData = await docRes.json().catch(() => ({ 
        error: 'Failed to parse server response. Please make sure you have restarted your server terminal.' 
      }))
      
      if (!docRes.ok) throw new Error(docData.error || docRes.statusText)

      setDocuments(prev => [docData, ...prev])
      setUploadMsg(`Ready: ${label} has been added to your Library with ${docData.questions?.length} questions available.`)
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
        headers: { 'X-Session-Key': getOrCreateHistorySessionKey() },
      })
      if (res.ok) {
        setDocuments(prev => prev.filter(d => d.id !== docId))
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
       if (pool.length === 0) {
           throw new Error('No questions available in this document pool.')
       }
       // Randomly select questionCount questions from pool
       const shuffled = [...pool].sort(() => 0.5 - Math.random())
       const selected = shuffled.slice(0, Math.min(questionCount, pool.length))
       
       setQuestions(selected)
       setPhase('taking')
    } catch (e) {
       setExamError(e.message || 'Could not start exam')
    } finally {
       setExamBusy(false)
    }
  }

  const submitExam = async () => {
    if (!questions.length) return
    let correct = 0
    for (const q of questions) {
      if (answers[q.id] === q.correctIndex) correct += 1
    }
    const total = questions.length
    const pct = total ? Math.round((correct / total) * 1000) / 10 : 0
    setScoreSummary({ correct, total, pct })
    setPhase('results')
    setHistorySaveError('')
    
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      score: correct,
      total,
      sourceDisplayName: selectedDocument?.sourceDisplayName || 'Exam',
      pct,
      questionCandidates: selectedDocument?.questionCandidates || 0,
      questions,
      answers,
    }
    
    if (serverHistoryEnabled === true) {
      try {
        const res = await fetch('/api/exam-history', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Key': getOrCreateHistorySessionKey(),
          },
          body: JSON.stringify({
            at: entry.at,
            score: entry.score,
            total: entry.total,
            pct: entry.pct,
            sourceDisplayName: entry.sourceDisplayName,
            questionCandidates: entry.questionCandidates,
            questions: entry.questions,
            answers: entry.answers,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data.error || 'Could not save exam history')
        }
        const saved = { ...entry, id: data.id || entry.id }
        setHistory((h) => [saved, ...h].slice(0, 50))
      } catch (e) {
        setHistorySaveError(e.message || 'Could not save to Firestore')
        setHistory((h) => [entry, ...h].slice(0, 50))
      }
    } else {
      setHistory((h) => [entry, ...h].slice(0, 50))
    }
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
        <h1>Local Exam Vault</h1>
        <p className="app-sub">
          Upload study material to process and store a persistent question pool. Select a document from your library anytime to take an exam.
        </p>
      </header>

      <div className="glass tabs">
        <button
          type="button"
          className={`tab ${tab === 'library' ? 'tab-active' : ''}`}
          onClick={() => setTab('library')}
        >
          1 · Library
        </button>
        <button
          type="button"
          className={`tab ${tab === 'exam' ? 'tab-active' : ''}`}
          onClick={() => setTab('exam')}
          disabled={!selectedDocument}
        >
          2 · Exam
        </button>
        <button
          type="button"
          className={`tab ${tab === 'history' ? 'tab-active' : ''}`}
          onClick={() => setTab('history')}
        >
          3 · History
        </button>
      </div>

      {tab === 'library' && (
        <section className="glass panel">
          <h2>Upload study material</h2>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            PDF, DOCX, TXT, Markdown, JSON, or CSV. API calls simulate generation but produce local mocks.
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
                Processing…
              </span>
            ) : (
              <span>Click or drop a file here to process and add to Library</span>
            )}
          </label>

          {uploadMsg && (
            <p className={`status ${uploadMsg.includes('fail') || uploadMsg.includes('Please') ? 'status-error' : ''}`}>
              {uploadMsg}
            </p>
          )}

          <div style={{ marginTop: '2rem' }}>
            <h3>Your Document Vault</h3>
            {documents.length === 0 ? (
               <p className="muted" style={{ marginTop: '0.5rem' }}>No documents uploaded yet.</p>
            ) : (
               <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                  {documents.map(d => (
                     <div key={d.id} className="glass-inset" style={{ display: 'flex', alignItems: 'center', padding: '1rem' }}>
                        <div>
                           <strong>{d.sourceDisplayName}</strong>
                           <div className="muted" style={{ fontSize: '0.85em', marginTop: '0.2rem' }}>
                              {d.questions?.length || 0} questions available
                           </div>
                        </div>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                           <button 
                              type="button" 
                              className="btn btn-primary" 
                              onClick={() => {
                                 setSelectedDocument(d)
                                 setTab('exam')
                                 resetExam()
                              }}
                           >
                              Select &amp; Test
                           </button>
                           <button 
                              type="button" 
                              className="btn btn-ghost"
                              style={{ color: '#f87171', border: '1px solid rgba(248, 113, 113, 0.3)' }}
                              onClick={() => deleteDocument(d.id)}
                           >
                              Remove
                           </button>
                        </div>
                     </div>
                  ))}
               </div>
            )}
          </div>
        </section>
      )}

      {tab === 'exam' && selectedDocument && (
        <section className="glass panel">
          <h2>Exam Mode</h2>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Document: <strong>{selectedDocument.sourceDisplayName}</strong>
          </p>

          {!questions.length && (
            <div style={{ marginTop: '1.5rem' }}>
              <div className="row" style={{ alignItems: 'flex-end', marginBottom: '1rem' }}>
                <div className="field">
                  <label htmlFor="qc">Number of questions to take:</label>
                  <input
                    id="qc"
                    type="number"
                    min={1}
                    max={selectedDocument.questions?.length || 50}
                    value={questionCount}
                    onChange={(e) =>
                      setQuestionCount(
                        Math.min(selectedDocument.questions?.length || 50, Math.max(1, Number(e.target.value) || 1)),
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={examBusy}
                  onClick={startExam}
                >
                  Start Exam
                </button>
              </div>
              <p className="muted stat-box-hint">
                You have {selectedDocument.questions?.length || 0} questions available in this document's pool.
              </p>
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
            <button type="button" className="btn btn-primary" onClick={submitExam} style={{ marginTop: '1rem' }}>
              Submit answers
            </button>
          )}

          {questions.length > 0 && phase === 'results' && (
            <button type="button" className="btn btn-ghost" style={{ marginTop: '1rem' }} onClick={() => {
                resetExam()
                setTab('library')
            }}>
              Try another exam
            </button>
          )}
        </section>
      )}

      {tab === 'history' && (
         <section className="glass panel history">
           <h2>Score history</h2>
           <p className="muted" style={{ marginTop: '0.35rem' }}>
             {serverHistoryEnabled === true
               ? 'Your historical exam performance.'
               : serverHistoryEnabled === false
                 ? 'Stored locally only. Set FIREBASE_SERVICE_ACCOUNT_B64 on the server to enable cloud history.'
                 : 'Loading history…'}
           </p>
           {historySaveError && (
             <p className="status status-error">{historySaveError}</p>
           )}
           {history.length === 0 ? (
             <p className="muted" style={{ marginTop: '1.5rem' }}>
               No attempts yet.
             </p>
           ) : (
             <ul style={{ marginTop: '1.5rem' }}>
               {history.map((h) => (
                 <li key={h.id}>
                   <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                     <span>
                       {new Date(h.at).toLocaleString()} —{' '}
                       {h.sourceDisplayName || h.pdfDisplayName || 'Exam'}
                       {h.questionCandidates != null && (
                         <span style={{ color: 'orange', marginLeft: '0.5rem' }}>
                           ({h.total} questions taken)
                         </span>
                       )}
                     </span>
                     <strong style={{ marginLeft: 'auto' }}>
                       {h.score}/{h.total} ({h.pct}%)
                     </strong>
                     {h.questions && h.answers && (
                       <button
                         type="button"
                         className="btn btn-ghost"
                         style={{ marginLeft: '1rem', padding: '2px 8px', fontSize: '0.8rem' }}
                         onClick={() => setSelectedHistory(selectedHistory?.id === h.id ? null : h)}
                       >
                         {selectedHistory?.id === h.id ? 'Hide details' : 'View details'}
                       </button>
                     )}
                   </div>
                   {selectedHistory?.id === h.id && selectedHistory.questions && selectedHistory.answers && (
                     <div className="history-details" style={{ marginTop: '1rem', paddingLeft: '1rem', borderLeft: '2px solid rgba(255,255,255,0.2)' }}>
                       {selectedHistory.questions.map((q, qi) => (
                         <div key={q.id} className="history-question-block" style={{ marginBottom: '1rem' }}>
                           <div className="question-title" style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                             {qi + 1}. {q.question}
                           </div>
                           {q.options.map((opt, oi) => {
                             const selected = selectedHistory.answers[q.id] === oi
                             const isCorrect = oi === q.correctIndex
                             let color = 'inherit'
                             let label = ''

                             if (selected && isCorrect) {
                               color = '#4ade80'
                               label = '✓ (Your Answer - Correct)'
                             } else if (selected && !isCorrect) {
                               color = '#f87171'
                               label = '✗ (Your Answer - Incorrect)'
                             } else if (!selected && isCorrect) {
                               color = '#4ade80'
                               label = '✓ (Correct Answer)'
                             }

                             return (
                               <div key={oi} style={{ fontSize: '0.85rem', color, marginLeft: '1rem', opacity: isCorrect || selected ? 1 : 0.6 }}>
                                 {String.fromCharCode(65 + oi)}. {opt} <strong style={{ marginLeft: '0.5rem' }}>{label}</strong>
                               </div>
                             )
                           })}
                         </div>
                       ))}
                     </div>
                   )}
                 </li>
               ))}
             </ul>
           )}
         </section>
      )}
    </div>
  )
}
