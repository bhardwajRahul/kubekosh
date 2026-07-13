import { useState, useEffect } from 'react'

/**
 * useClusterHealth
 * Polls GET /api/health every 8 seconds and returns whether the k3s cluster
 * is reachable.
 *
 * @returns {{ clusterReady: boolean }}
 */
export function useClusterHealth() {
  const [clusterReady, setClusterReady] = useState(false)

  useEffect(() => {
    async function check() {
      try {
        const d = await fetch('/api/health').then(r => r.json())
        setClusterReady(d.cluster === 'ready')
      } catch {
        setClusterReady(false)
      }
    }
    check()
    const t = setInterval(check, 8000)
    return () => clearInterval(t)
  }, [])

  return { clusterReady }
}
