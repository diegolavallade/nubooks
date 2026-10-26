import { useCallback, useEffect, useRef, useState } from 'react'
import ePub, { EpubCFI, type Book, type Rendition, type NavItem } from 'epubjs'
import type Contents from 'epubjs/types/contents'
import type { Bookmark } from './storage'
import type { ImportedBook } from './ReliableEpubReader'
import { disposeEpubWhenReady } from './epubLifecycle'

export function ReaderIcon({ name }: { name: 'search' | 'bookmark' | 'marks' }) {
  return <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{name === 'search' ? <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></> : name === 'bookmark' ? <><path d="M6 3h12v18l-6-4-6 4z" /><path d="M12 6v6M9 9h6" /></> : <><path d="M8 3h11v18l-5.5-4L8 21z" /><path d="M4 5v15" /></>}</svg>
}

export function useReaderTools(book: ImportedBook, initial: Bookmark[], onChange: ((marks: Bookmark[]) => void) | undefined, jump: (cfi: string) => void) {
  const [marks, setMarks] = useState(initial)
  const marksRef = useRef(marks)
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const engineRef = useRef<Book | null>(null)
  const viewerRef = useRef<Rendition | null>(null)
  const [revision, setRevision] = useState(0)
  const [panel, setPanel] = useState<'search' | 'marks' | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ cfi: string; excerpt: string; chapter: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [notice, setNotice] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; cfi: string; text: string; copyText: string } | null>(null)
  const [bookmarkFeedback, setBookmarkFeedback] = useState(false)
  const feedbackTimer = useRef<number | undefined>(undefined)
  const [newMarkId, setNewMarkId] = useState<string | null>(null)
  const searchGeneration = useRef(0)
  const seekGeneration = useRef(0)
  const persist = (next: Bookmark[]) => {
    marksRef.current = next
    setMarks(next)
    changeRef.current?.(next)
  }
  const connect = useCallback((engine: Book, viewer: Rendition) => {
    engineRef.current = engine
    viewerRef.current = viewer
    setRevision(value => value + 1)
    const cleanups: (() => void)[] = []
    const attach = (contents: Contents) => {
      const doc = contents.document
      const listener = (event: MouseEvent) => {
        const selection = doc.getSelection()
        const text = selection?.toString().trim()
        if (!text || !selection?.rangeCount) return
        event.preventDefault()
        const cfi = contents.cfiFromRange(selection.getRangeAt(0))
        const frame = contents.window.frameElement?.getBoundingClientRect()
        setMenu({ x: Math.min(window.innerWidth - 210, (frame?.left || 0) + event.clientX), y: Math.min(window.innerHeight - 110, (frame?.top || 0) + event.clientY), cfi, text: text.slice(0, 180), copyText: text })
      }
      doc.addEventListener('contextmenu', listener)
      const dismiss = () => { setMenu(null); setPanel(null); window.dispatchEvent(new Event('nubooks-reader-outside')) }
      doc.addEventListener('pointerdown', dismiss)
      cleanups.push(() => { doc.removeEventListener('contextmenu', listener); doc.removeEventListener('pointerdown', dismiss) })
    }
    viewer.hooks.content.register(attach)
    return () => {
      viewer.hooks.content.deregister(attach)
      cleanups.forEach(cleanup => cleanup())
      if (viewerRef.current === viewer) { viewerRef.current = null; engineRef.current = null }
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const highlighted = marks.filter(mark => mark.kind === 'highlight')
    highlighted.forEach(mark => {
      try { viewer.annotations.highlight(mark.cfi, {}, undefined, 'reader-highlight', { fill: '#edc54e', 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply' }) } catch { /* Invalid legacy annotation. */ }
    })
    return () => { highlighted.forEach(mark => { try { viewer.annotations.remove(mark.cfi, 'highlight') } catch { /* Viewer is closing. */ } }) }
  }, [marks, revision])

  useEffect(() => {
    const dismiss = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('.reader-selection-menu')) setMenu(null)
      if (!target?.closest('.reader-settings, .reader-nav button, .reader-selection-menu')) setPanel(null)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(null); setPanel(null) } }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', key); searchGeneration.current++; window.clearTimeout(feedbackTimer.current) }
  }, [])

  const chapterForProgress = (sectionIndex: number, currentCfi: string | null) => {
    const engine = engineRef.current
    if (!engine) return 'Lectura'
    const section = engine.spine.get(sectionIndex)
    if (!section) return 'Lectura'
    const normalize = (path: string) => { try { return decodeURI(new URL(path, 'https://epub.local/').pathname).slice(1) } catch { return path.split('#')[0] } }
    const navPath = engine.packaging.navPath || engine.packaging.ncxPath || ''
    let best: {labels: string[]; cfi: string | null} | null = null
    const visit = (items: NavItem[], parents: string[]) => {
      for (const item of items) {
        const labels = [...parents, item.label.trim()]
        try {
          const url = new URL(item.href, new URL(navPath, 'https://epub.local/'))
          if (normalize(section.href) === normalize(url.pathname) || normalize(section.href) === normalize(item.href)) {
            let anchorCfi: string | null = null
            let eligible = !url.hash
            if (url.hash && currentCfi) {
              const anchor = section.document?.getElementById(decodeURIComponent(url.hash.slice(1)))
              if (anchor) { anchorCfi = section.cfiFromElement(anchor); eligible = new EpubCFI().compare(anchorCfi, currentCfi) <= 0 }
            }
            if (eligible && (!best || (anchorCfi && (!best.cfi || new EpubCFI().compare(anchorCfi, best.cfi) >= 0)) || (!anchorCfi && !best.cfi && labels.length > best.labels.length))) best = {labels, cfi: anchorCfi}
          }
        } catch { /* Fall back to the surrounding chapter. */ }
        visit(item.subitems || [], labels)
      }
    }
    visit(engine.navigation?.toc || [], [])
    return best ? (best as {labels: string[]}).labels.join(' › ') : 'Sección ' + (sectionIndex + 1)
  }
  const chapterAt = (cfi: string) => {
    const engine = engineRef.current
    try {
      const section = engine?.spine.get(cfi)
      if (!section) return ''
      const flatten = (items: NavItem[]): NavItem[] => items.flatMap(item => [item, ...flatten(item.subitems || [])])
      return flatten(engine!.navigation.toc).find(item => item.href.split('#')[0].endsWith(section.href) || section.href.endsWith(item.href.split('#')[0]))?.label || 'Sección ' + (section.index + 1)
    } catch { return '' }
  }
  const addBookmark = async (cfi: string | null, percent: number) => {
    if (!cfi || !engineRef.current) return
    if (marksRef.current.some(mark => mark.kind !== 'highlight' && mark.cfi === cfi)) { setNotice('Esta posición ya tiene un marcador.'); setPanel('marks'); return }
    let label = 'Posición de lectura'
    try { const range = await engineRef.current.getRange(cfi); label = range.startContainer.parentElement?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 180) || label } catch { /* Keep position label. */ }
    const id = crypto.randomUUID()
    persist([...marksRef.current, { id, cfi, label, kind: 'bookmark', chapter: chapterAt(cfi), percent, createdAt: new Date().toISOString() }])
    setNewMarkId(id); setBookmarkFeedback(true)
    window.clearTimeout(feedbackTimer.current)
    feedbackTimer.current = window.setTimeout(() => { setBookmarkFeedback(false); setNewMarkId(null) }, 2400)
    setNotice('Marcador guardado.')
  }
  const seek = async (percent: number, weights: number[]) => {
    const engine = engineRef.current
    if (!engine) return
    const generation = ++seekGeneration.current
    try {
      const total = weights.reduce((sum, weight) => sum + weight, 0) || engine.packaging.spine.length
      let remaining = Math.min(.999999, Math.max(0, percent)) * total
      let index = 0
      while (index < engine.packaging.spine.length - 1 && remaining >= (weights[index] || 1)) { remaining -= weights[index] || 1; index++ }
      const section = engine.spine.get(index)
      await section.load(engine.load.bind(engine))
      if (generation !== seekGeneration.current || engine !== engineRef.current) return
      const root = section.document.body || section.document.documentElement
      const walker = section.document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.textContent?.trim() && !node.parentElement?.closest('script,style') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
      const nodes: Node[] = []
      while (walker.nextNode()) nodes.push(walker.currentNode)
      let offset = Math.floor(nodes.reduce((sum, node) => sum + (node.textContent?.length || 0), 0) * remaining / (weights[index] || 1))
      for (const node of nodes) {
        const length = node.textContent?.length || 0
        if (offset < length) { const range = section.document.createRange(); range.setStart(node, offset); range.collapse(true); jump(section.cfiFromRange(range)); return }
        offset -= length
      }
      jump(section.href)
    } catch { setNotice('No se pudo saltar a esa posición.') }
  }
  const search = async (event: React.FormEvent) => {
    event.preventDefault()
    const term = query.trim()
    if (term.length < 2) { setNotice('Escribe al menos dos caracteres.'); return }
    const generation = ++searchGeneration.current
    setResults([]); setSearching(true); setNotice('')
    const engine = ePub(book.data.slice(0))
    try {
      await engine.opened
      const found: { cfi: string; excerpt: string; chapter: string }[] = []
      for (let index = 0; index < engine.packaging.spine.length && found.length < 300; index++) {
        if (generation !== searchGeneration.current) break
        const section = engine.spine.get(index)
        try {
          await section.load(engine.load.bind(engine))
          const matches = section.find(term) as unknown as { cfi: string; excerpt: string }[]
          found.push(...matches.slice(0, 300 - found.length).map(match => ({ ...match, chapter: chapterAt(match.cfi) })))
          if (generation === searchGeneration.current) setResults([...found])
        } catch { /* Continue searching readable sections. */ }
        finally { section.unload() }
      }
      if (generation === searchGeneration.current) setNotice(found.length ? (found.length >= 300 ? 'Primeros 300 resultados' : found.length + ' resultados') : 'No se encontraron coincidencias.')
    } catch { if (generation === searchGeneration.current) setNotice('No se pudo completar la búsqueda.') }
    finally { disposeEpubWhenReady(engine); if (generation === searchGeneration.current) setSearching(false) }
  }
  const copySelection = async () => {
    if (!menu) return
    const text = menu.copyText
    try { await navigator.clipboard.writeText(text) }
    catch {
      const input = document.createElement('textarea')
      input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'
      document.body.appendChild(input); input.select()
      const copied = document.execCommand('copy'); input.remove()
      if (!copied) { setNotice('No se pudo copiar el texto.'); return }
    }
    setMenu(null)
  }
  const panels = <>
    {bookmarkFeedback && <div className="reader-bookmark-toast" role="status"><ReaderIcon name="bookmark" /><span>Marcador guardado</span><strong>✓</strong></div>}
    {panel && <aside className={"reader-settings reader-tools-panel" + (panel === 'marks' ? ' reader-marks-panel' : '')} aria-label={panel === 'search' ? 'Buscar en el libro' : 'Marcadores y resaltados'}>
      <div className="settings-title"><h2>{panel === 'search' ? 'Buscar en el libro' : 'Marcadores y resaltados'}</h2><button onClick={() => { searchGeneration.current++; setSearching(false); setPanel(null) }} aria-label="Cerrar panel">×</button></div>
      {panel === 'search' ? <><form className="reader-search-form" onSubmit={search}><input autoFocus aria-label="Texto a buscar" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar palabras…" minLength={2} /><button type="submit" disabled={searching}>{searching ? 'Buscando…' : 'Buscar'}</button></form><p className="setting-hint" role="status">{notice}</p>{results.map((result, index) => <button className="reader-saved-entry" key={result.cfi + index} onClick={() => { jump(result.cfi); setPanel(null) }}><small>{result.chapter}</small><span>{result.excerpt}</span></button>)}</> : <>{notice && <p className="setting-hint">{notice}</p>}{!marks.length && <p className="setting-hint">Marca una posición o selecciona texto y haz clic derecho para resaltarlo.</p>}{marks.map(mark => <div className={"reader-saved-row" + (mark.id === newMarkId ? " just-added" : "")} key={mark.id}><button className="reader-saved-entry" onClick={() => { jump(mark.cfi); setPanel(null) }}><small>{mark.kind === 'highlight' ? 'Resaltado' : 'Marcador'} · {mark.chapter || 'Lectura'}{mark.percent !== undefined ? ' · ' + Math.round(mark.percent) + '%' : ''}</small><span>{mark.label}</span><time>{new Date(mark.createdAt).toLocaleDateString()}</time></button><button className="icon-button" aria-label="Eliminar marcador o resaltado" onClick={() => persist(marksRef.current.filter(item => item.id !== mark.id))}>×</button></div>)}</>}
    </aside>}
    {menu && <div className="reader-selection-menu" role="menu" style={{ left: menu.x, top: menu.y }}><button role="menuitem" onClick={() => { void copySelection() }}>Copiar texto</button><button role="menuitem" onClick={() => { if (!marksRef.current.some(mark => mark.kind === 'highlight' && mark.cfi === menu.cfi)) persist([...marksRef.current, { id: crypto.randomUUID(), cfi: menu.cfi, label: menu.text, kind: 'highlight', chapter: chapterAt(menu.cfi), createdAt: new Date().toISOString() }]); setMenu(null) }}>Resaltar texto</button></div>}
  </>
  return { connect, panel, setPanel, panels, addBookmark, seek, bookmarkFeedback, chapterForProgress }
}
