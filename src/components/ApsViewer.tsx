import { useEffect, useRef, useState, type ReactElement } from 'react'

/**
 * Autodesk Platform Services Viewer (v7): AutoCAD's own rendering of the DWG in the browser.
 * The DWG is translated once by Model Derivative (SVF2); the app only hands the viewer a
 * short-lived viewables:read token and the translated urn.
 *
 * Selection is bridged both ways through AutoCAD entity handles: the viewer's externalId for
 * a DWG entity is its handle, which is also what the detection candidates reference.
 */
declare global { interface Window { Autodesk?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any

const VIEWER_JS = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js'
const VIEWER_CSS = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css'

let loading: Promise<void> | null = null
function loadViewerLibrary(): Promise<void> {
  if (window.Autodesk?.Viewing) return Promise.resolve()
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = VIEWER_CSS; document.head.appendChild(css)
    const js = document.createElement('script'); js.src = VIEWER_JS; js.async = true
    js.onload = () => resolve(); js.onerror = () => reject(new Error('Could not load the Autodesk Viewer script.'))
    document.head.appendChild(js)
  })
  return loading
}

export type ViewerHandle = {
  /** Select and frame the entities with these AutoCAD handles. */
  focusHandles: (handles: string[]) => void
  /** Frame (without selecting) the entities with these handles, e.g. one floor plan. */
  fitHandles: (handles: string[]) => void
  fitAll: () => void
}

export function ApsViewer({ urn, getToken, onSelectHandles, onReady }: {
  urn: string
  getToken: () => Promise<{ access_token: string; expires_in: number }>
  /** Called with the AutoCAD handles of whatever the person selects in the viewer. */
  onSelectHandles?: (handles: string[]) => void
  onReady?: (h: ViewerHandle) => void
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<any>(null) // eslint-disable-line @typescript-eslint/no-explicit-any
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('Loading AutoCAD view…')

  useEffect(() => {
    let cancelled = false
    let viewer: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
    ;(async () => {
      try {
        await loadViewerLibrary()
        if (cancelled || !host.current) return
        const AV = window.Autodesk.Viewing
        await new Promise<void>((resolve) => AV.Initializer({
          env: 'AutodeskProduction2', api: 'streamingV2',
          getAccessToken: (cb: (t: string, e: number) => void) => { getToken().then((t) => cb(t.access_token, t.expires_in)).catch(() => cb('', 0)) },
        }, resolve))
        if (cancelled || !host.current) return
        viewer = new AV.GuiViewer3D(host.current, { extensions: ['Autodesk.DocumentBrowser'] })
        viewer.start()
        viewer.setTheme('light-theme')
        viewerRef.current = viewer
        AV.Document.load(`urn:${urn}`, (doc: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          // A DWG translates to 2D sheets: prefer the model-space view, else whatever is the default.
          const root = doc.getRoot()
          const sheets = root.search({ type: 'geometry', role: '2d' })
          const modelSpace = sheets.find((n: any) => /^model$/i.test(n.name?.() ?? n.data?.name ?? '')) // eslint-disable-line @typescript-eslint/no-explicit-any
          const node = modelSpace ?? sheets[0] ?? root.getDefaultGeometry()
          viewer.loadDocumentNode(doc, node).then(() => {
            setStatus('ready')
            viewer.addEventListener(AV.SELECTION_CHANGED_EVENT, () => {
              const ids: number[] = viewer.getSelection()
              if (!ids.length || !onSelectHandles) return
              viewer.model.getExternalIdMapping((map: Record<string, number>) => {
                const byId = new Map(Object.entries(map).map(([ext, id]) => [id, ext]))
                onSelectHandles(ids.map((i) => byId.get(i)).filter((x): x is string => !!x).map((x) => x.toUpperCase()))
              })
            })
            onReady?.({
              focusHandles: (handles) => {
                viewer.model.getExternalIdMapping((map: Record<string, number>) => {
                  const want = new Set(handles.map((h) => h.toUpperCase()))
                  const ids = Object.entries(map).filter(([ext]) => want.has(ext.toUpperCase())).map(([, id]) => id)
                  if (!ids.length) return
                  viewer.select(ids); viewer.fitToView(ids)
                })
              },
              fitHandles: (handles) => {
                viewer.model.getExternalIdMapping((map: Record<string, number>) => {
                  const want = new Set(handles.map((h) => h.toUpperCase()))
                  const ids = Object.entries(map).filter(([ext]) => want.has(ext.toUpperCase())).map(([, id]) => id)
                  viewer.clearSelection()
                  if (ids.length) viewer.fitToView(ids); else viewer.fitToView()
                })
              },
              fitAll: () => viewer.fitToView(),
            })
          })
        }, (code: number, msg: string) => { setStatus('error'); setMessage(`Viewer could not load the drawing (${code}): ${msg}`) })
      } catch (e) { if (!cancelled) { setStatus('error'); setMessage((e as Error).message) } }
    })()
    return () => { cancelled = true; if (viewer) { try { viewer.finish() } catch { /* already gone */ } } viewerRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urn])

  return (
    <div className="relative w-full h-full">
      <div ref={host} className="absolute inset-0" />
      {status !== 'ready' && <div className={`absolute inset-0 grid place-items-center text-sm ${status === 'error' ? 'text-bad' : 'text-muted'} bg-white/70`}>{message}</div>}
    </div>
  )
}
