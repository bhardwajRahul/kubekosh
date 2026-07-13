import { useState, useCallback, useRef } from 'react'

const MIN_SIDEBAR_W     = 180
const MAX_SIDEBAR_W     = 560
const DEFAULT_SIDEBAR_W = 280
const SIDEBAR_COLLAPSE_PX = 100
const SIDEBAR_COLLAPSED_W = 40

const MIN_TERM_H     = 36
const MAX_TERM_H     = 600
const TERM_COLLAPSE_PX = 60

/**
 * useResizable
 * Manages sidebar and terminal panel drag-resize / collapse state.
 *
 * @returns {{
 *   sidebarW: number,
 *   sidebarCollapsed: boolean,
 *   setSidebarCollapsed: Function,
 *   currentSidebarW: number,
 *   onSidebarDragDown: Function,
 *   termH: number,
 *   termCollapsed: boolean,
 *   setTermCollapsed: Function,
 *   currentTermH: number,
 *   onTermDragDown: Function,
 *   bundlesCollapsed: boolean,
 *   setBundlesCollapsed: Function,
 * }}
 */
export function useResizable() {
  const [sidebarW, setSidebarW]           = useState(DEFAULT_SIDEBAR_W)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const sbDragging = useRef(false)
  const sbDragX0   = useRef(0)
  const sbDragW0   = useRef(0)

  const [termH, setTermH]               = useState(300)
  const [termCollapsed, setTermCollapsed] = useState(false)
  const tmDragging = useRef(false)
  const tmDragY0   = useRef(0)
  const tmDragH0   = useRef(0)

  const [bundlesCollapsed, setBundlesCollapsed] = useState(false)

  const onSidebarDragDown = useCallback((e) => {
    e.preventDefault()
    sbDragging.current = true
    sbDragX0.current   = e.clientX
    sbDragW0.current   = sidebarCollapsed ? SIDEBAR_COLLAPSED_W : sidebarW

    function onMove(ev) {
      if (!sbDragging.current) return
      const newW = sbDragW0.current + (ev.clientX - sbDragX0.current)
      if (newW < SIDEBAR_COLLAPSE_PX) {
        setSidebarCollapsed(true)
      } else {
        setSidebarCollapsed(false)
        setSidebarW(Math.min(MAX_SIDEBAR_W, Math.max(MIN_SIDEBAR_W, newW)))
      }
    }
    function onUp() {
      sbDragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarCollapsed, sidebarW])

  const onTermDragDown = useCallback((e) => {
    e.preventDefault()
    tmDragging.current = true
    tmDragY0.current   = e.clientY
    tmDragH0.current   = termCollapsed ? MIN_TERM_H : termH

    function onMove(ev) {
      if (!tmDragging.current) return
      const newH = tmDragH0.current + (tmDragY0.current - ev.clientY)
      if (newH < TERM_COLLAPSE_PX) {
        setTermCollapsed(true)
      } else {
        setTermCollapsed(false)
        setTermH(Math.min(MAX_TERM_H, Math.max(MIN_TERM_H + 40, newH)))
      }
    }
    function onUp() {
      tmDragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [termCollapsed, termH])

  return {
    sidebarW,
    sidebarCollapsed,
    setSidebarCollapsed,
    currentSidebarW: sidebarCollapsed ? SIDEBAR_COLLAPSED_W : sidebarW,
    onSidebarDragDown,
    termH,
    termCollapsed,
    setTermCollapsed,
    currentTermH: termCollapsed ? MIN_TERM_H : termH,
    onTermDragDown,
    bundlesCollapsed,
    setBundlesCollapsed,
  }
}
