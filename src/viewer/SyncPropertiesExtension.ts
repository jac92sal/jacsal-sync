/**
 * SyncPropertiesExtension: mirrors autodesk-platform-services/aps-db-sample
 * (wwwroot/Extensions/DBPropertiesExtension.js). A ViewerPropertyPanel subclass injects an
 * "Engineering Sync" category into the viewer's own property panel with editable inputs bound
 * to the app database instead of MongoDB:
 *
 *   select entity → look up the detected element by AutoCAD handle (externalId)
 *                 → show Label / Type inputs + Confirm / Not an object
 *   edit + confirm → POST /api/candidates/:id (or tag a fresh entity via /api/files/:id/candidates)
 *
 * The React page supplies a `bridge` so the extension never holds stale state.
 */
export type SyncBridge = {
  /** Resolve the selected entities to the element the app knows about (by handle). */
  lookup: (handles: string[]) => { candidateId: string | null; handle: string | null; kind: string; label: string; tag: string | null; status: string; detectedAs: string; kinds: string[] }
  confirm: (candidateId: string | null, handle: string | null, label: string, kind: string) => Promise<void>
  ignore: (candidateId: string) => Promise<void>
  notify: (text: string, ok: boolean) => void
}

const CATEGORY = 'Engineering Sync'

export function registerSyncPropertiesExtension(): void {
  const AV = window.Autodesk?.Viewing
  if (!AV || AV.theExtensionManager.getExtension?.('SyncPropertiesExtension') || (window as unknown as { __syncExtRegistered?: boolean }).__syncExtRegistered) return
  ;(window as unknown as { __syncExtRegistered?: boolean }).__syncExtRegistered = true

  class SyncPropertyPanel extends AV.Extensions.ViewerPropertyPanel {
    bridge: SyncBridge
    handles: string[] = []
    draft: { label: string; kind: string } | null = null
    constructor(viewer: any, bridge: SyncBridge) { // eslint-disable-line @typescript-eslint/no-explicit-any
      super(viewer)
      this.bridge = bridge
      viewer.addEventListener(AV.SELECTION_CHANGED_EVENT, () => {
        const ids: number[] = viewer.getSelection()
        if (!ids.length) { this.handles = []; this.draft = null; return }
        viewer.model.getExternalIdMapping((map: Record<string, number>) => {
          const byId = new Map(Object.entries(map).map(([ext, id]) => [id, ext]))
          this.handles = ids.map((i) => byId.get(i)).filter((x): x is string => !!x).map((x) => x.toUpperCase())
          this.draft = null
          if (this.isVisible()) this.requestProperties()
        })
      })
    }
    // Same hook the sample overrides: add our category after the viewer's own properties.
    setAggregatedProperties(propertySet: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
      super.setAggregatedProperties(propertySet)
      this.addSyncProperties()
    }
    setProperties(properties: any, options?: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
      super.setProperties(properties, options)
      this.addSyncProperties()
    }
    private valueCell(el: HTMLElement | null | undefined): HTMLElement | null {
      if (!el) return null
      return (el.querySelector('.property-value') as HTMLElement | null) ?? (el.lastElementChild as HTMLElement | null)
    }
    private addSyncProperties(): void {
      if (!this.handles.length) return
      const info = this.bridge.lookup(this.handles)
      if (!this.draft) this.draft = { label: info.label, kind: info.kind }
      const draft = this.draft
      this.addProperty('Handle', this.handles[0], CATEGORY)
      this.addProperty('Detected as', info.detectedAs, CATEGORY)
      this.addProperty('Status', info.status, CATEGORY)
      if (info.tag) this.addProperty('Tag', info.tag, CATEGORY)

      // Type: a select in the value cell (the sample uses text inputs; a select keeps kinds valid).
      const kindRow = this.addProperty('Type', draft.kind, CATEGORY) as HTMLElement | undefined
      const kindCell = this.valueCell(kindRow)
      if (kindCell) {
        const select = document.createElement('select')
        select.style.width = '100%'
        for (const k of info.kinds) { const o = document.createElement('option'); o.value = k; o.textContent = k.replace('_', ' '); if (k === draft.kind) o.selected = true; select.appendChild(o) }
        select.addEventListener('change', () => { draft.kind = select.value })
        select.addEventListener('mousedown', (e) => e.stopPropagation())
        kindCell.innerHTML = ''; kindCell.appendChild(select)
      }
      // Label: editable text input, committed on Enter or Confirm (sample commits on focusout; here confirm is explicit).
      const labelRow = this.addProperty('Label', draft.label, CATEGORY) as HTMLElement | undefined
      const labelCell = this.valueCell(labelRow)
      if (labelCell) {
        const input = document.createElement('input')
        input.type = 'text'; input.value = draft.label; input.placeholder = 'e.g. Kitchen north wall'; input.style.width = '100%'
        input.addEventListener('input', () => { draft.label = input.value })
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') void this.commit(info) })
        input.addEventListener('mousedown', (e) => e.stopPropagation())
        labelCell.innerHTML = ''; labelCell.appendChild(input)
        setTimeout(() => input.focus(), 0)
      }
      // Actions
      const actRow = this.addProperty('Action', '', CATEGORY) as HTMLElement | undefined
      const actCell = this.valueCell(actRow)
      if (actCell) {
        actCell.innerHTML = ''
        const confirm = document.createElement('button'); confirm.textContent = info.status === 'PENDING' || info.status === 'NOT DETECTED' ? 'Confirm' : 'Update'; confirm.style.marginRight = '6px'
        confirm.addEventListener('click', (e) => { e.stopPropagation(); void this.commit(info) })
        actCell.appendChild(confirm)
        if (info.candidateId && info.status === 'PENDING') {
          const ignore = document.createElement('button'); ignore.textContent = 'Not an object'
          ignore.addEventListener('click', async (e) => { e.stopPropagation(); try { await this.bridge.ignore(info.candidateId!); this.bridge.notify('Marked as not an object', true); this.requestProperties() } catch (err) { this.bridge.notify(String((err as Error).message ?? err), false) } })
          actCell.appendChild(ignore)
        }
      }
      this.resizeToContent?.()
    }
    private async commit(info: ReturnType<SyncBridge['lookup']>): Promise<void> {
      const d = this.draft; if (!d) return
      if (!d.label.trim()) { this.bridge.notify('Enter a label first', false); return }
      try {
        await this.bridge.confirm(info.candidateId, info.handle ?? this.handles[0], d.label.trim(), d.kind)
        this.bridge.notify(`Saved "${d.label.trim()}"`, true)
        this.draft = null
        this.requestProperties()
      } catch (err) { this.bridge.notify(String((err as Error).message ?? err), false) }
    }
  }

  class SyncPropertiesExtension extends AV.Extension {
    panel: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
    load(): boolean {
      const bridge = (this.options as { bridge?: SyncBridge }).bridge
      if (!bridge) return false
      this.panel = new SyncPropertyPanel(this.viewer, bridge)
      this.viewer.setPropertyPanel(this.panel)
      return true
    }
    unload(): boolean {
      if (this.panel) { this.viewer.setPropertyPanel(null); this.panel = null }
      return true
    }
  }
  AV.theExtensionManager.registerExtension('SyncPropertiesExtension', SyncPropertiesExtension)
}
