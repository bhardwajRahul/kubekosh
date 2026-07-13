import { useState, useEffect, useCallback } from 'react'

/**
 * useExamSession
 * Owns exam-mode overlay state and the start / submit / abandon lifecycle.
 * `examSession` / `setExamSession` are passed in from App so that useProgress
 * can read the same session reference for scenario-list URL switching.
 *
 * @param {{ bundles: Array, refreshProgress: Function, examSession: object|null, setExamSession: Function }} deps
 */
export function useExamSession({ bundles, refreshProgress, examSession, setExamSession }) {
  const [examReport,       setExamReport]       = useState(null)
  const [examModalBundle,  setExamModalBundle]  = useState(null)
  const [examProgress,     setExamProgress]     = useState({})
  const [showHistory,      setShowHistory]      = useState(false)

  // ── Restore active exam session on mount ──────────────────────────────────
  useEffect(() => {
    fetch('/api/sessions/active')
      .then(r => r.json())
      .then(async s => {
        if (s) {
          setExamSession(s)
          const ep = await fetch(`/api/sessions/${s.id}/exam-progress`)
            .then(r => r.json())
            .catch(() => ({}))
          setExamProgress(ep || {})
        }
      })
      .catch(() => {})
  }, [])

  // ── Sync exam progress whenever the active session changes ────────────────
  // (called after validate/answer so the sidebar completion count updates)
  const syncExamProgress = useCallback(async (session) => {
    if (!session) return
    const updated = await fetch('/api/sessions/active').then(r => r.json()).catch(() => null)
    if (updated) {
      setExamSession(updated)
      const ep = await fetch(`/api/sessions/${updated.id}/exam-progress`)
        .then(r => r.json())
        .catch(() => ({}))
      setExamProgress(ep || {})
    }
  }, [])

  // ── Start a new exam session ───────────────────────────────────────────────
  const startExam = useCallback(async (bundleId, customMinutes, customScenarioCount) => {
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId, examMinutes: customMinutes, scenarioCount: customScenarioCount }),
    }).then(r => r.json())
    const active = await fetch('/api/sessions/active').then(r => r.json())
    setExamSession(active)
  }, [])

  // ── Submit the exam ───────────────────────────────────────────────────────
  const submitExam = useCallback(async () => {
    if (!examSession) return
    const result = await fetch(`/api/sessions/${examSession.id}/submit`, { method: 'POST' })
      .then(r => r.json())
    const bundle = bundles.find(b => b.id === examSession.bundle_id)
    setExamReport({ ...result, bundle })
    setExamSession(null)
    setExamProgress({})
    await refreshProgress()
  }, [examSession, bundles, refreshProgress])

  // ── Abandon the exam ──────────────────────────────────────────────────────
  const abandonExam = useCallback(async () => {
    if (!examSession) return
    await fetch(`/api/sessions/${examSession.id}/abandon`, { method: 'POST' }).catch(() => {})
    setExamSession(null)
    setExamProgress({})
    await refreshProgress()
  }, [examSession, refreshProgress])

  return {
    examReport,      setExamReport,
    examModalBundle, setExamModalBundle,
    examProgress,    setExamProgress,
    showHistory,     setShowHistory,
    startExam,
    submitExam,
    abandonExam,
    syncExamProgress,
  }
}
