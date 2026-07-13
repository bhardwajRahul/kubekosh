import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * useProgress
 * Owns all data-fetching for bundles, tracks, scenarios, and per-scenario
 * progress. Exposes a `refreshProgress` function that other hooks / handlers
 * can call after a mutation (validate, answer, submit, abandon).
 *
 * @param {{ activeBundleId: string|null, activeId: string|null, examSession: object|null }} deps
 * @returns {{
 *   bundles: Array,
 *   setBundles: Function,
 *   tracks: Array,
 *   setTracks: Function,
 *   scenarios: Array,
 *   setScenarios: Function,
 *   progress: Object,
 *   setProgress: Function,
 *   scenario: object|null,
 *   setScenario: Function,
 *   loading: boolean,
 *   activeTrackId: string|null,
 *   setActiveTrackId: Function,
 *   refreshProgress: Function,
 * }}
 */
export function useProgress({ activeBundleId, activeId, examSession, onBundlesLoaded }) {
  const [bundles,  setBundles]  = useState([])
  const [tracks,   setTracks]   = useState([])
  const [scenarios, setScenarios] = useState([])
  const [progress, setProgress] = useState({})
  const [scenario, setScenario] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [activeTrackId, setActiveTrackId] = useState(null)

  // Track previous scenario id to teardown on switch
  const prevActiveIdRef = useRef(null)

  // ── Load tracks (once) ────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/tracks')
      .then(r => r.json())
      .then(data => {
        setTracks(data)
        if (data.length > 0) setActiveTrackId(data[0].id)
      })
      .catch(console.error)
  }, [])

  // ── Load bundles (once) ───────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/bundles')
      .then(r => r.json())
      .then(data => {
        setBundles(data)
        onBundlesLoaded?.(data)   // lets App auto-select the first bundle on load
      })
      .catch(console.error)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load scenarios for active bundle ─────────────────────────────────────
  useEffect(() => {
    if (!activeBundleId) return
    setLoading(true)
    setScenario(null)
    const url = examSession?.id
      ? `/api/scenarios?session=${examSession.id}`
      : `/api/scenarios?bundle=${activeBundleId}`
    fetch(url)
      .then(r => r.json())
      .then(data => {
        setScenarios(data)
        setProgress(Object.fromEntries(data.map(s => [s.id, s.progress])))
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [activeBundleId, examSession?.id])

  // ── Load full scenario when selected — teardown previous ─────────────────
  useEffect(() => {
    if (!activeId) return
    const prevId = prevActiveIdRef.current
    if (prevId && prevId !== activeId) {
      fetch(`/api/scenarios/${prevId}/teardown`, { method: 'POST' }).catch(() => {})
    }
    prevActiveIdRef.current = activeId

    setScenario(null)
    fetch(`/api/scenarios/${activeId}`)
      .then(r => r.json())
      .then(s => {
        setScenario(s)
        fetch(`/api/scenarios/${activeId}/context`, { method: 'POST' }).catch(() => {})
      })
      .catch(console.error)
  }, [activeId])

  // ── Refresh all progress + scenario data ──────────────────────────────────
  const refreshProgress = useCallback(async () => {
    const scenarioUrl = examSession?.id
      ? `/api/scenarios?session=${examSession.id}`
      : `/api/scenarios?bundle=${activeBundleId}`
    const [bundleData, trackData, scenarioData] = await Promise.all([
      fetch('/api/bundles').then(r => r.json()),
      fetch('/api/tracks').then(r => r.json()),
      fetch(scenarioUrl).then(r => r.json()),
    ])
    setBundles(bundleData)
    setTracks(trackData)
    setScenarios(scenarioData)
    setProgress(Object.fromEntries(scenarioData.map(s => [s.id, s.progress])))
    if (activeId) {
      const d2 = await fetch(`/api/scenarios/${activeId}`).then(r => r.json())
      setScenario(d2)
    }
  }, [activeBundleId, activeId, examSession?.id])

  return {
    bundles, setBundles,
    tracks,  setTracks,
    scenarios, setScenarios,
    progress, setProgress,
    scenario, setScenario,
    loading,
    activeTrackId, setActiveTrackId,
    refreshProgress,
  }
}
