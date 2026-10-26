import { useEffect, useMemo, useRef, useState } from "react"
import ePub, { EpubCFI, type Book, type NavItem, type Rendition } from "epubjs"
import { disposeEpubWhenReady } from "./epubLifecycle"
import { ReaderIcon, useReaderTools } from "./useReaderTools"
import type { Bookmark } from "./storage"

/**
 * Lector EPUB resistente a fallos construido sobre epub.js.
 *
 * Responsabilidades principales:
 * - abrir un EPUB desde memoria sin exponer rutas locales;
 * - ofrecer navegación por botones, teclado, rueda, toque e índice;
 * - aplicar preferencias tipográficas dentro de los iframes de epub.js;
 * - restaurar una posición CFI y emitir progreso comparable entre sesiones;
 * - desmontar de forma segura aun cuando epub.js siga resolviendo recursos.
 */

/** Libro listo para abrir; `data` contiene el ZIP EPUB completo. */
export type ImportedBook = {
  id: string
  title: string
  author: string
  data: ArrayBuffer
}

/** Preferencias persistibles de una sesión de lectura. */
export type ReaderSettings = {
  fontScale?: number
  fontSize: "small" | "medium" | "large"
  animation: "slide" | "ripple" | "fade" | "continuous"
  theme: "light" | "dark"
  columns: "1" | "2" | "auto"
  justify: boolean
}
type Settings = ReaderSettings

/** Posición normalizada que la aplicación puede guardar fuera del lector. */
export type ReaderProgress = {
  cfi: string
  section: number
  page: number
  pages: number
  location: number | null
  totalLocations: number | null
  percentage: number
}

/** Contrato público del componente lector. */
export type EpubReaderProps = {
  book: ImportedBook
  onClose: () => void
  initialSettings?: Partial<ReaderSettings>
  onSettingsChange?: (settings: ReaderSettings) => void
  initialPosition?: string | null
  onProgress?: (progress: ReaderProgress) => void
  initialBookmarks?: Bookmark[]
  onBookmarksChange?: (marks: Bookmark[]) => void
  coverUrl?: string | null
}
type Location = {
  cfi: string
  section: number
  page: number
  pages: number
  atStart: boolean
  atEnd: boolean
}
type Actions = {
  next: () => void
  prev: () => void
  jump: (href: string) => void
}
type ChapterEntry = {
  id: string
  label: string
  target: string | null
  subitems: ChapterEntry[]
}

// Claves heredadas: permiten que el lector siga funcionando de forma autónoma
// cuando no recibe callbacks de persistencia desde la aplicación contenedora.
const defaultSettings: Settings = {
  fontSize: "medium",
  animation: "slide",
  theme: "light",
  columns: "auto",
  justify: false,
}
const positionKey = (id: string) => `nubooks:position:${id}`
const locationsKey = (id: string) => `nubooks:locations:${id}`

/** Valida preferencias parciales y sustituye valores desconocidos por defaults. */
function restoreSettings(value?: Partial<ReaderSettings>): Settings {
  return {
    fontScale: typeof value?.fontScale === "number" ? Math.max(70, Math.min(200, value.fontScale)) : undefined,
    fontSize:
      value?.fontSize === "small" || value?.fontSize === "large"
        ? value.fontSize
        : "medium",
    animation:
      value?.animation === "ripple" ||
      value?.animation === "fade" ||
      value?.animation === "continuous"
        ? value.animation
        : "slide",
    theme: value?.theme === "dark" ? "dark" : "light",
    columns:
      value?.columns === "1" || value?.columns === "2" ? value.columns : "auto",
    justify: value?.justify === true,
  }
}

/** Lee localStorage sin convertir una restricción del navegador en un fallo fatal. */
function savedValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Añade un límite temporal para que una promesa bloqueada no congele el lector. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("Tiempo de espera agotado")),
          ms,
        )
      }),
    ])
  } finally {
    window.clearTimeout(timer)
  }
}

/** Normaliza una URL interna del EPUB a una ruta comparable. */
function pathOf(value: string): string {
  try {
    return decodeURI(new URL(value, "https://epub.local/").pathname.slice(1))
  } catch {
    return value.split("#")[0].replace(/^\.\//, "")
  }
}

/**
 * Resuelve un enlace del índice contra el documento de navegación y el spine.
 * Devuelve `null` para enlaces externos o capítulos que no formen parte de la
 * secuencia de lectura, evitando pedir a epub.js destinos inválidos.
 */
function resolveChapter(book: Book, href: string): string | null {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null
  try {
    const navPath = book.packaging.navPath || book.packaging.ncxPath || ""
    const destination = new URL(href, new URL(navPath, "https://epub.local/"))
    const fromNav = pathOf(destination.pathname)
    const fromOpf = pathOf(href)
    const sections = Array.from(
      { length: book.packaging.spine.length },
      (_, index) => book.spine.get(index),
    )
    const section =
      sections.find((item) => pathOf(item.href) === fromNav) ||
      sections.find((item) => pathOf(item.href) === fromOpf)
    if (!section) return null
    let fragment = destination.hash.slice(1)
    try {
      fragment = decodeURIComponent(fragment)
    } catch {
      /* Keep the original fragment. */
    }
    return section.href + (fragment ? `#${fragment}` : "")
  } catch {
    return null
  }
}

/** Convierte recursivamente el TOC de epub.js al modelo renderizable del panel. */
function prepareContents(book: Book, items: NavItem[]): ChapterEntry[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    target: resolveChapter(book, item.href),
    subitems: prepareContents(book, item.subitems || []),
  }))
}

/**
 * Estima el peso relativo de cada sección a partir de su tamaño descomprimido.
 * Se usa cuando el EPUB no trae una lista exacta de ubicaciones; no pretende
 * representar páginas impresas, solo producir un progreso visual estable.
 */
function estimateSectionWeights(book: Book): number[] {
  const zip = (book.archive as unknown as {
    zip?: { files?: Record<string, { _data?: { uncompressedSize?: number } }> }
  })?.zip
  return Array.from({ length: book.packaging.spine.length }, (_, index) => {
    const section = book.spine.get(index)
    if (!section) return 1
    let path = section.url || ""
    try {
      path = decodeURIComponent(
        new URL(path, "https://epub.local/").pathname.slice(1),
      )
    } catch {
      path = path.replace(/^\//, "")
    }
    const bytes = zip?.files?.[path]?._data?.uncompressedSize
    return Math.max(
      1,
      Math.ceil((bytes && Number.isFinite(bytes) ? bytes : 2400) / 1600),
    )
  })
}

function applyLiveTypography(viewer: Rendition, settings: Settings, extraDocument?: Document) {
  const scale = settings.fontScale ?? {small:90,medium:110,large:135}[settings.fontSize]
  const pixels = 16 * scale / 100
  viewer.themes.override("font-size", pixels + "px", true)
  const liveContents = viewer.getContents() as unknown as { document: Document }[]
  const documents = liveContents.map(content => content.document)
  if (extraDocument) documents.push(extraDocument)
  for (const doc of new Set(documents)) {
    let style = doc.getElementById("nubooks-live-type")
    if (!style) { style = doc.createElement("style"); style.id = "nubooks-live-type"; doc.head.appendChild(style) }
    style.textContent = 'html,body{font-size:' + pixels + 'px!important}p,li,td,blockquote{font-size:1em!important}p *,li *,td *,blockquote *{font-size:inherit!important}'
    doc.body?.style.setProperty("font-size", pixels + "px", "important")
  }

}

/** Aplica tema, tipografía y columnas al contenido aislado de la rendition. */
function styleRendition(viewer: Rendition, settings: Settings, width: number) {
  const dark = settings.theme === "dark"
  viewer.themes.default({
    "html, body": {
      background: `${dark ? "#171817" : "#f3eee4"} !important`,
      color: `${dark ? "#e7e3db" : "#302e29"} !important`,
    },
    body: {
      "font-family": "'Newsreader', Georgia, serif !important",
      "line-height": "1.55 !important",
      "text-align": `${settings.justify ? "justify" : "left"} !important`,
    },
  })
  applyLiveTypography(viewer, settings)
  if (settings.animation !== "continuous") {
    const spread =
      settings.columns === "2" || (settings.columns === "auto" && width >= 1000)
    viewer.spread(spread ? "auto" : "none", spread ? 700 : undefined)
  }
}

/**
 * Adaptador imperativo entre React y epub.js.
 *
 * epub.js posee su propio ciclo de vida y crea iframes fuera del árbol de
 * React. Este componente concentra sus listeners, navegación, recuperación y
 * limpieza; el resto de la UI solo recibe eventos declarativos.
 */
function EpubCanvas({
  book,
  settings,
  actions,
  lastCfi,
  onLocation,
  onReady,
  onFailure,
  onContents,
  onStructure,
  persistLegacyPosition,
  connectTools,
}: {
  book: ImportedBook
  settings: Settings
  actions: React.RefObject<Actions | null>
  lastCfi: React.RefObject<string | null>
  onLocation: (location: Location) => void
  onReady: () => void
  onFailure: (message: string) => void
  onContents: (engine: Book, items: NavItem[]) => void
  onStructure: (engine: Book) => void
  persistLegacyPosition: boolean
  connectTools: (engine: Book, viewer: Rendition) => () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Rendition | null>(null)
  const callbacks = useRef({
    onLocation,
    onReady,
    onFailure,
    onContents,
    onStructure,
    connectTools,
  })
  const currentSettings = useRef(settings)
  const legacyPosition = useRef(persistLegacyPosition)
  callbacks.current = {
    onLocation,
    onReady,
    onFailure,
    onContents,
    onStructure,
    connectTools,
  }
  currentSettings.current = settings
  legacyPosition.current = persistLegacyPosition
  const mode = settings.animation === "continuous" ? "continuous" : "paginated"

  // Cambios puramente visuales se aplican sin reconstruir el motor EPUB.
  useEffect(() => {
    const viewer = viewerRef.current
    if (viewer && container.current)
      styleRendition(viewer, settings, container.current.clientWidth)
  }, [
    settings.fontSize,
    settings.fontScale,
    settings.theme,
    settings.columns,
    settings.justify,
    mode,
  ])

  // Abrir el libro o cambiar entre flujo paginado/continuo sí requiere una rendition nueva.
  useEffect(() => {
    const element = container.current!
    if (!element) return
    let disposed = false
    let recovering = false
    let navigating = false
    let engine: Book | null = null
    let toolsCleanup: (() => void) | undefined
    let queueFallbackTimer: number | undefined
    let lastWheel = 0
    let touchStart: {
      x: number
      y: number
      scrollTop: number
    } | null = null
    const iframeDocuments = new Map<Document, (event: WheelEvent) => void>()

    /** Notifica un error una sola vez durante cada intento de recuperación. */
    const fail = (message: string) => {
      if (disposed || recovering) return
      recovering = true
      callbacks.current.onFailure(message)
    }
    /** Reinicia la clase CSS que representa la animación del cambio de página. */
    const animate = () => {
      if (mode === "continuous") return
      element.classList.remove(
        "epub-turn-slide",
        "epub-turn-ripple",
        "epub-turn-fade",
      )
      void element.offsetWidth
      element.classList.add(`epub-turn-${currentSettings.current.animation}`)
    }
    /** Desplaza el contenedor continuo e informa si realmente pudo moverse. */
    const scrollBy = (delta: number) => {
      const scroller = element.querySelector<HTMLElement>(".epub-container")
      if (!scroller) return false
      const before = scroller.scrollTop
      const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      scroller.scrollTop = Math.max(0, Math.min(maximum, before + delta))
      return Math.abs(scroller.scrollTop - before) > 1
    }
    /** Ejecuta navegación exclusiva para impedir carreras entre gestos rápidos. */
    const navigate = async (
      action: "next" | "prev" | "jump",
      href?: string,
    ) => {
      const viewer = viewerRef.current
      if (!viewer || !engine || disposed || recovering || navigating) return
      navigating = true
      try {
        if (action === "jump") {
          if (!href) return
          await withTimeout(viewer.display(href), 12000)
        } else {
          const index = viewer.location?.start?.index
          const section =
            typeof index === "number" ? engine.spine.get(index) : null
          if (section && !section.linear) {
            const direction = action === "next" ? 1 : -1
            let nextIndex = index + direction
            let nextSection = engine.spine.get(nextIndex)
            while (nextSection && !nextSection.linear) {
              nextIndex += direction
              nextSection = engine.spine.get(nextIndex)
            }
            if (nextSection) await withTimeout(viewer.display(nextIndex), 12000)
          } else {
            await withTimeout(
              action === "next" ? viewer.next() : viewer.prev(),
              12000,
            )
          }
        }
      } catch {
        fail(
          "No se pudo mostrar esa página. Restaurando la última posición legible…",
        )
      } finally {
        navigating = false
      }
    }

    // Traduce teclado, rueda y gestos táctiles al mismo conjunto de acciones.
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          "input, textarea, select, [contenteditable], .reader-settings",
        )
      )
        return
      if (mode === "continuous") {
        const height =
          element.querySelector<HTMLElement>(".epub-container")?.clientHeight ||
          element.clientHeight
        if (["ArrowDown", "PageDown", " "].includes(event.key)) {
          event.preventDefault()
          if (!scrollBy(height * 0.8)) void navigate("next")
        }
        if (["ArrowUp", "PageUp"].includes(event.key)) {
          event.preventDefault()
          if (!scrollBy(-height * 0.8)) void navigate("prev")
        }
        if (event.key === "ArrowRight") {
          event.preventDefault()
          void navigate("next")
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault()
          void navigate("prev")
        }
        return
      }
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault()
        void navigate("next")
      }
      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault()
        void navigate("prev")
      }
    }
    const onWheel = (event: WheelEvent, insideFrame = false) => {
      if (
        !insideFrame &&
        (!(event.target instanceof Element) ||
          !event.target.closest(".epub-stage") ||
          event.target.closest(".reader-settings"))
      )
        return
      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX
      if (Math.abs(delta) < 12) return
      event.preventDefault()
      if (mode === "continuous") {
        window.setTimeout(() => {
          if (disposed || scrollBy(delta)) return
          const now = Date.now()
          if (now - lastWheel < 550) return
          lastWheel = now
          void navigate(delta > 0 ? "next" : "prev")
        }, 0)
        return
      }
      const now = Date.now()
      if (now - lastWheel < 550) return
      lastWheel = now
      void navigate(delta > 0 ? "next" : "prev")
    }
    const onWindowWheel = (event: WheelEvent) => onWheel(event)
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0]
      if (touch)
        touchStart = {
          x: touch.clientX,
          y: touch.clientY,
          scrollTop:
            element.querySelector<HTMLElement>(".epub-container")?.scrollTop ||
            0,
        }
    }
    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0]
      const start = touchStart
      touchStart = null
      if (!start || !touch) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      if (mode === "continuous") {
        if (Math.abs(dy) >= 30 && Math.abs(dy) > Math.abs(dx) * 1.2) {
          const current =
            element.querySelector<HTMLElement>(".epub-container")?.scrollTop ||
            0
          if (Math.abs(current - start.scrollTop) <= 2 && !scrollBy(-dy))
            void navigate(dy < 0 ? "next" : "prev")
        }
        return
      }
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.3)
        void navigate(dx < 0 ? "next" : "prev")
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("wheel", onWindowWheel, { passive: false })
    element.addEventListener("touchstart", onTouchStart, { passive: true })
    element.addEventListener("touchend", onTouchEnd, { passive: true })
    actions.current = {
      next: () => void navigate("next"),
      prev: () => void navigate("prev"),
      jump: (href) => void navigate("jump", href),
    }

    /** Inicializa el ZIP, la rendition, sus eventos y la posición de entrada. */
    async function start() {
      try {
        engine = ePub(book.data.slice(0))
        await withTimeout(engine.opened, 20000)
        if (disposed) return
        callbacks.current.onStructure(engine)
        const viewer = engine.renderTo(element!, {
          width: "100%",
          height: "100%",
          manager: "default",
          flow: mode === "continuous" ? "scrolled-doc" : "paginated",
          spread: "none",
          allowScriptedContent: false,
        })
        // epub.js schedules its rendition queue exclusively with requestAnimationFrame.
        // Some embedded/headless browsers throttle frames while remounting the reader;
        // a bounded timer fallback prevents the queue from staying unopened forever.
        const queue = viewer.q as typeof viewer.q & {
          tick: (callback: FrameRequestCallback) => number
        }
        queue.tick = (callback) =>
          window.setTimeout(() => callback(performance.now()), 0)
        queueFallbackTimer = window.setTimeout(() => {
          if (!disposed && !element.querySelector(".epub-container"))
            void queue.run()
        }, 500)
        viewerRef.current = viewer
        toolsCleanup = callbacks.current.connectTools(engine, viewer)
        viewer.hooks.content.register((content: {document: Document}) => { if (!disposed) applyLiveTypography(viewer, currentSettings.current, content.document) })
        styleRendition(viewer, currentSettings.current, element!.clientWidth)
        void withTimeout(engine.loaded.navigation, 8000)
          .then((navigation) => {
            if (!disposed) callbacks.current.onContents(engine!, navigation.toc)
          })
          .catch(() => {
            if (!disposed) callbacks.current.onContents(engine!, [])
          })
        viewer.on(
          "relocated",
          (current: {
            start?: {
              cfi?: string
              index?: number
              displayed?: { page: number; total: number }
            }
            atStart?: boolean
            atEnd?: boolean
          }) => {
            if (disposed || !current.start?.cfi) return
            lastCfi.current = current.start.cfi
            if (legacyPosition.current) {
              try {
                localStorage.setItem(positionKey(book.id), current.start.cfi)
              } catch {
                /* Optional storage. */
              }
            }
            callbacks.current.onLocation({
              cfi: current.start.cfi,
              section: current.start.index ?? 0,
              page: current.start.displayed?.page ?? 1,
              pages: current.start.displayed?.total ?? 1,
              atStart: !!current.atStart,
              atEnd: !!current.atEnd,
            })
            animate()
          },
        )
        viewer.on("displayError", () =>
          fail(
            "No se pudo cargar ese capítulo. Restaurando la última posición legible…",
          ),
        )
        viewer.on("keydown", onKey)
        viewer.on("touchstart", onTouchStart)
        viewer.on("touchend", onTouchEnd)
        viewer.on(
          "rendered",
          (_section: unknown, view: { contents?: { document?: Document } }) => {
            const document = view.contents?.document
            if (document && !iframeDocuments.has(document)) {
              const listener = (event: WheelEvent) => onWheel(event, true)
              document.addEventListener("wheel", listener, { passive: false })
              iframeDocuments.set(document, listener)
            }
          },
        )
        let target: string | undefined
        if (lastCfi.current) {
          try {
            if (engine.spine.get(lastCfi.current)) target = lastCfi.current
          } catch {
            /* Invalid saved position. */
          }
        }
        try {
          await withTimeout(viewer.display(target), 12000)
        } catch {
          if (disposed || recovering) return
          lastCfi.current = null
          if (legacyPosition.current) {
            try {
              localStorage.removeItem(positionKey(book.id))
            } catch {
              /* Optional storage. */
            }
          }
          fail("No se pudo recuperar la posición. Volviendo al inicio…")
          return
        }
        if (!disposed && !recovering) callbacks.current.onReady()
      } catch {
        fail(
          "No pudimos abrir este EPUB. Comprueba que el archivo no esté dañado o protegido.",
        )
      }
    }
    // React Strict Mode mounts and immediately cleans up effects in development.
    // Give that first cleanup a chance to cancel before epub.js starts opening a ZIP.
    const startTimer = window.setTimeout(() => {
      void start()
    }, 0)

    // Retira todos los listeners creados fuera de React y difiere la destrucción
    // del motor hasta que epub.js haya terminado sus promesas internas.
    return () => {
      disposed = true
      toolsCleanup?.()
      window.clearTimeout(startTimer)
      window.clearTimeout(queueFallbackTimer)
      actions.current = null
      viewerRef.current = null
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("wheel", onWindowWheel)
      element.removeEventListener("touchstart", onTouchStart)
      element.removeEventListener("touchend", onTouchEnd)
      iframeDocuments.forEach((listener, document) =>
        document.removeEventListener("wheel", listener),
      )
      if (engine) disposeEpubWhenReady(engine)
    }
  }, [book, mode, actions, lastCfi])

  return <div ref={container} className="epub-viewport" />
}

/**
 * UI y estado de una sesión de lectura.
 * Separa paneles y cálculo de progreso del adaptador imperativo `EpubCanvas`.
 */
function ReaderSession({
  book,
  onClose,
  initialSettings,
  onSettingsChange,
  initialPosition,
  onProgress,
  initialBookmarks = [],
  onBookmarksChange,
  coverUrl,
}: EpubReaderProps) {
  const [settings, setSettings] = useState<Settings>(() =>
    restoreSettings(initialSettings),
  )
  const [openingPhase, setOpeningPhase] = useState<"waiting" | "expanding" | "closing" | "done">("waiting")
  const [progressTooltip, setProgressTooltip] = useState<{x: number; text: string} | null>(null)
  const closing = useRef(false)
  const closeTimer = useRef<number | undefined>(undefined)
  const [scrub, setScrub] = useState<number | null>(null)
  const seekTimer = useRef<number | undefined>(undefined)
  const [showSettings, setShowSettings] = useState(false)
  const [showContents, setShowContents] = useState(false)
  const [contents, setContents] = useState<ChapterEntry[]>([])
  const [sectionCount, setSectionCount] = useState(1)
  const [sectionWeights, setSectionWeights] = useState<number[]>([])
  const [location, setLocation] = useState<Location | null>(null)
  const [positions] = useState<string | null>(() =>
    savedValue(locationsKey(book.id)),
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [recovery, setRecovery] = useState(0)
  const actions = useRef<Actions | null>(null)
  const lastCfi = useRef<string | null>(
    initialPosition === undefined
      ? savedValue(positionKey(book.id))
      : initialPosition,
  )
  const tools = useReaderTools(book, initialBookmarks, onBookmarksChange, (cfi) => actions.current?.jump(cfi))
  const recoveryAttempts = useRef(0)
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress

  /** Cambia una preferencia y remonta el canvas solo al cambiar de tipo de flujo. */
  const updateSetting = <K extends keyof Settings,>(
    key: K,
    value: Settings[K],
  ) => {
    if (
      key === "animation" &&
      (value === "continuous") !== (settings.animation === "continuous")
    )
      setLoading(true)
    const next = { ...settings, [key]: value }
    setSettings(next)
    onSettingsChange?.(next)
  }
  const onReady = () => {
    recoveryAttempts.current = 0
    setLoading(false)
    setOpeningPhase(current => current === "waiting" ? "expanding" : current)
  }
  useEffect(() => {
    if (openingPhase !== "expanding") return
    const timer = window.setTimeout(() => setOpeningPhase("done"), 850)
    return () => window.clearTimeout(timer)
  }, [openingPhase])
  useEffect(() => () => { window.clearTimeout(seekTimer.current); window.clearTimeout(closeTimer.current) }, [])
  const closeAnimated = () => {
    if (closing.current) return
    closing.current = true
    setShowSettings(false); setShowContents(false); tools.setPanel(null)
    setOpeningPhase("closing")
    closeTimer.current = window.setTimeout(onClose, 850)
  }
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (event.type === "nubooks-reader-outside" || !target?.closest(".reader-settings, .reader-nav button, .reader-selection-menu")) { setShowSettings(false); setShowContents(false) }
    }
    window.addEventListener("pointerdown", outside)
    window.addEventListener("nubooks-reader-outside", outside)
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("nubooks-reader-outside", outside) }
  }, [])

  /** Reintenta automáticamente dos veces antes de ofrecer recuperación manual. */
  const onFailure = (message: string) => {
    setError(message)
    if (recoveryAttempts.current >= 2) {
      setLoading(false)
      return
    }
    recoveryAttempts.current++
    setLoading(true)
    setRecovery((current) => current + 1)
  }
  const onLocation = (value: Location) => {
    setLocation(value)
    setError("")
  }
  const jumpTo = (href: string) => {
    setShowContents(false)
    actions.current?.jump(href)
  }

  /** Renderiza un índice jerárquico respetando la profundidad de cada entrada. */
  const renderContents = (items: ChapterEntry[], depth = 0): React.ReactNode =>
    items.map((item) => {
      const available = !!item.target
      return (
        <div key={`${depth}-${item.target}-${item.id}`}>
          {available ? (
            <button
              className="toc-entry"
              style={{ paddingLeft: 12 + depth * 16 }}
              onClick={() => jumpTo(item.target!)}
            >
              {item.label}
            </button>
          ) : (
            <div
              className="toc-heading"
              style={{ paddingLeft: 12 + depth * 16 }}
            >
              {item.label}
            </div>
          )}
          {item.subitems && renderContents(item.subitems, depth + 1)}
        </div>
      )
    })

  // Algunos EPUB incluyen ubicaciones CFI precalculadas. Cuando existen se usa
  // búsqueda binaria; de lo contrario se recurre al peso estimado por sección.
  const locationList = useMemo(() => {
    try {
      const values = JSON.parse(positions || "[]")
      return Array.isArray(values)
        ? values.filter((value): value is string => typeof value === "string")
        : []
    } catch {
      return []
    }
  }, [positions])
  const exactPositions = locationList.length > 0
  const totalPositions = exactPositions
    ? locationList.length
    : sectionWeights.reduce((sum, weight) => sum + weight, 0)
  let currentPosition = 1
  if (location?.cfi && exactPositions) {
    try {
      const comparator = new EpubCFI()
      let lower = 0
      let upper = totalPositions
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2)
        if (comparator.compare(locationList[middle], location.cfi) < 0)
          lower = middle + 1
        else upper = middle
      }
      currentPosition = Math.max(1, Math.min(totalPositions, lower + 1))
    } catch {
      /* Keep the last known visual fallback. */
    }
  } else if (location && sectionWeights.length) {
    const section = Math.max(
      0,
      Math.min(sectionWeights.length - 1, location.section),
    )
    const before = sectionWeights
      .slice(0, section)
      .reduce((sum, weight) => sum + weight, 0)
    const offset =
      (Math.max(1, location.page) - 1) / Math.max(location.pages, 1)
    currentPosition = Math.max(
      1,
      Math.min(
        totalPositions,
        before + Math.floor(offset * sectionWeights[section]) + 1,
      ),
    )
  }
  const fallback = location
    ? (location.section + (location.page - 1) / Math.max(location.pages, 1)) /
      sectionCount
    : 0
  const progress = totalPositions
    ? (currentPosition - 1) / Math.max(totalPositions - 1, 1)
    : fallback
  const mode = settings.animation === "continuous" ? "continuous" : "paginated"

  // Informa a la aplicación únicamente después de obtener una ubicación válida.
  useEffect(() => {
    if (!location) return
    onProgressRef.current?.({
      cfi: location.cfi,
      section: location.section,
      page: location.page,
      pages: location.pages,
      location: totalPositions ? currentPosition : null,
      totalLocations: totalPositions || null,
      percentage: Math.max(0, Math.min(100, progress * 100)),
    })
  }, [location, totalPositions, currentPosition, progress])

  return (
    <main className={`reader-shell epub-reader theme-${settings.theme}`}>
      <nav className="reader-nav">
        <div className="reader-left-actions"><button
          className="icon-button back-button"
          onClick={closeAnimated}
          aria-label="Volver a la biblioteca"
        >
          ←
        </button><button className={"icon-button reader-add-bookmark" + (tools.bookmarkFeedback ? " bookmark-added" : "")} aria-label="Agregar marcador" disabled={loading} onClick={() => { void tools.addBookmark(lastCfi.current, progress * 100); tools.setPanel("marks"); setShowContents(false); setShowSettings(false) }}><ReaderIcon name="bookmark" /></button><button className="icon-button" aria-label="Marcadores y resaltados" onClick={() => { tools.setPanel(tools.panel === "marks" ? null : "marks"); setShowContents(false); setShowSettings(false) }}><ReaderIcon name="marks" /></button></div>
        <span className="reader-book-title">{book.title}</span>
        <div className="reader-actions"><button className="icon-button" aria-label="Buscar en el libro" onClick={() => { tools.setPanel(tools.panel === "search" ? null : "search"); setShowContents(false); setShowSettings(false) }}><ReaderIcon name="search" /></button>
          <button
            className={`icon-button ${showContents ? "active" : ""}`}
            onClick={() => {
              setShowContents((visible) => !visible)
              setShowSettings(false)
              tools.setPanel(null)
            }}
            aria-label="Índice de capítulos"
            title="Índice"
          >
            ☷
          </button>
          <button
            className={`icon-button text-control ${
              showSettings ? "active" : ""
            }`}
            onClick={() => {
              setShowSettings((visible) => !visible)
              setShowContents(false)
              tools.setPanel(null)
            }}
            aria-label="Temas y configuraciones"
          >
            Aa
          </button>
        </div>
      </nav>

      {tools.panels}
      {showContents && (
        <aside
          className="reader-settings toc-panel"
          aria-label="Índice de capítulos"
        >
          <div className="settings-title">
            <div>
              <span>EPUB</span>
              <h2>Índice</h2>
            </div>
            <button
              onClick={() => setShowContents(false)}
              aria-label="Cerrar índice"
            >
              ×
            </button>
          </div>
          <div className="toc-list">
            {contents.length ? (
              renderContents(contents)
            ) : (
              <p>Este libro no contiene un índice disponible.</p>
            )}
          </div>
        </aside>
      )}

      {showSettings && (
        <aside className="reader-settings" aria-label="Temas y configuraciones">
          <div className="settings-title">
            <div>
              <span>LECTURA</span>
              <h2>Temas y configuraciones</h2>
            </div>
            <button
              onClick={() => setShowSettings(false)}
              aria-label="Cerrar configuraciones"
            >
              ×
            </button>
          </div>
          <div className="setting-row">
            <span>Tamaño del texto</span>
            <label className="reader-font-slider"><input type="range" min="70" max="200" step="5" value={settings.fontScale ?? ({small:90,medium:110,large:135}[settings.fontSize])} aria-label="Tamaño del texto" onChange={event => updateSetting("fontScale", Number(event.target.value))} /><output>{settings.fontScale ?? ({small:90,medium:110,large:135}[settings.fontSize])}%</output></label>
          </div>
          <div className="setting-group">
            <span>Animación de página</span>
            <div className="option-grid">
              {([
                ["slide", "Deslizamiento"],
                ["ripple", "Ondulación"],
                ["fade", "Fundido rápido"],
                ["continuous", "Desplazamiento continuo"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={settings.animation === value ? "active" : ""}
                  onClick={() => updateSetting("animation", value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-group">
            <span>Fondo</span>
            <div className="segmented">
              <button
                className={settings.theme === "light" ? "active" : ""}
                onClick={() => updateSetting("theme", "light")}
              >
                Claro
              </button>
              <button
                className={settings.theme === "dark" ? "active" : ""}
                onClick={() => updateSetting("theme", "dark")}
              >
                Oscuro
              </button>
            </div>
          </div>
          <div className="setting-group">
            <span>Columnas</span>
            <div className="segmented three">
              {(["1", "2", "auto"] as const).map((value) => (
                <button
                  key={value}
                  className={settings.columns === value ? "active" : ""}
                  onClick={() => updateSetting("columns", value)}
                  disabled={mode === "continuous"}
                >
                  {value === "auto" ? "Automático" : value}
                </button>
              ))}
            </div>
            {mode === "continuous" && (
              <small className="setting-hint">
                Las columnas se aplican en lectura por páginas.
              </small>
            )}
          </div>
          <div className="setting-row last">
            <span>Justificar texto</span>
            <button
              className={`switch ${settings.justify ? "on" : ""}`}
              onClick={() => updateSetting("justify", !settings.justify)}
              aria-pressed={settings.justify}
            >
              <i />
            </button>
          </div>
        </aside>
      )}

      <section
        className={`reader-stage epub-stage ${
          mode === "continuous" ? "epub-stage-continuous" : ""
        }`}
        aria-label={`Contenido de ${book.title}`}
      >
        <EpubCanvas
          key={`${book.id}:${mode}:${recovery}`}
          book={book}
          settings={settings}
          actions={actions}
          lastCfi={lastCfi}
          onLocation={onLocation}
          onReady={onReady}
          onFailure={onFailure}
          onStructure={(engine) => {
            setSectionCount(engine.packaging.spine.length || 1)
            setSectionWeights(estimateSectionWeights(engine))
          }}
          onContents={(engine, items) => {
            setContents(prepareContents(engine, items))
          }}
          connectTools={tools.connect}
          persistLegacyPosition={!onProgress}
        />
        {loading && <div className="epub-message" aria-label="Cargando contenido" />}
        {error && !loading && (
          <div className="epub-reader-alert" role="alert">
            {error}{" "}
            <button
              onClick={() => {
                lastCfi.current = null
                recoveryAttempts.current = 0
                setLoading(true)
                setRecovery((value) => value + 1)
              }}
            >
              Reintentar desde el inicio
            </button>
          </div>
        )}
        {mode === "paginated" && (
          <>
            <button
              className="page-control previous"
              onClick={() => actions.current?.prev()}
              aria-label="Página anterior"
              disabled={loading || !!location?.atStart}
            >
              ›
            </button>
            <button
              className="page-control next"
              onClick={() => actions.current?.next()}
              aria-label="Página siguiente"
              disabled={loading || !!location?.atEnd}
            >
              ›
            </button>
          </>
        )}
      </section>
      {progressTooltip && <div className="reader-progress-tooltip" role="tooltip" style={{left: progressTooltip.x}}>{progressTooltip.text}</div>}
      <footer
        className="reader-footer epub-progress-footer"
        aria-label={
          totalPositions
            ? `Ubicación ${
                exactPositions ? "" : "aproximada "
              }${currentPosition} de ${totalPositions}`
            : "Calculando progreso del libro"
        }
      >
        <span>{totalPositions ? currentPosition : "—"}</span>
        <input className="reader-progress-slider" type="range" min="0" max="1000" step="1" aria-label="Posición en el libro" onPointerMove={event => {
          setProgressTooltip({x: Math.max(140, Math.min(window.innerWidth - 140, event.clientX)), text: tools.chapterForProgress(location?.section ?? 0, location?.cfi ?? null)})
        }} onPointerLeave={() => setProgressTooltip(null)} onFocus={() => setProgressTooltip({x: window.innerWidth / 2, text: tools.chapterForProgress(location?.section ?? 0, location?.cfi ?? null)})} onBlur={() => setProgressTooltip(null)} aria-valuetext={Math.round((scrub ?? progress) * 100) + "%"} value={Math.round((scrub ?? progress) * 1000)} disabled={loading} onChange={event => { const value = Number(event.target.value) / 1000; setScrub(value); window.clearTimeout(seekTimer.current); seekTimer.current = window.setTimeout(() => { void tools.seek(value, sectionWeights).finally(() => setScrub(null)) }, 220) }} />
        <span>{totalPositions || "—"}</span>
      </footer>
      {openingPhase !== "done" && (!error || openingPhase === "closing") && <div className={"reader-book-opening " + openingPhase} aria-label="Abriendo libro"><div className="reader-opening-cover">{coverUrl ? <img src={coverUrl} alt="" /> : <span>{book.title}</span>}</div></div>}
    </main>
  )
}

/** Reinicia toda la sesión al cambiar de libro para evitar estado cruzado. */
export default function ReliableEpubReader(props: EpubReaderProps) {
  return <ReaderSession key={props.book.id} {...props} />
}
