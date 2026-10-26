import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import "./library-ui.css"

/**
 * Componentes visuales de la biblioteca.
 *
 * Este módulo no conoce IndexedDB ni Tauri: recibe datos ya preparados y
 * comunica intenciones mediante callbacks. Así se puede reutilizar y probar la
 * interfaz sin acoplarla a una implementación de persistencia concreta.
 */

/** Información mínima necesaria para representar un libro en la biblioteca. */
export interface LibraryBookItem {
  id: string
  title: string
  author: string
  coverUrl?: string | null
  progress?: number | null
  chapter?: string | null
}

/** Colección visible y referencias a los libros que contiene. */
export interface LibraryCollectionItem {
  id: string
  name: string
  bookIds: string[]
}

/** Conjunto pequeño de iconos SVG accesibles como elementos decorativos. */
function Icon({
  name,
  size = 18,
}: {
  name: "spark" | "chevron" | "more" | "plus" | "folder"
  size?: number
}) {
  const paths = {
    spark: (
      <path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z" />
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
        <circle cx="19" cy="12" r="1" fill="currentColor" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    folder: (
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z" />
    ),
  }
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  )
}

/** Convierte valores ausentes, infinitos o fuera de rango a un porcentaje válido. */
function clampProgress(progress?: number | null) {
  return Math.max(
    0,
    Math.min(100, Number.isFinite(progress) ? Number(progress) : 0),
  )
}

/**
 * Cabecera contextual con saludo y fecha locales.
 * El reloj se actualiza cada minuto para cambiar el saludo sin recargar la app.
 */
export function LibraryHero({
  userName,
  hasBooks = false,
}: {
  userName?: string | null
  hasBooks?: boolean
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const hour = now.getHours()
  const greeting =
    hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches"
  const name = userName?.trim()
  const weekday = new Intl.DateTimeFormat("es-MX", { weekday: "long" })
    .format(now)
    .toLocaleUpperCase("es-MX")
  const month = new Intl.DateTimeFormat("es-MX", { month: "long" })
    .format(now)
    .toLocaleUpperCase("es-MX")

  return (
    <section className="hero">
      <div>
        <span className="eyebrow">
          <Icon name="spark" size={15} /> TU BIBLIOTECA
        </span>
        <h1>
          {greeting}
          {name ? `, ${name}` : ""}.
        </h1>
        <p>
          {hasBooks
            ? "Continúa donde lo dejaste o descubre algo nuevo."
            : "Un buen libro puede empezar aquí."}
        </p>
      </div>
      <div
        className="hero-date"
        aria-label={new Intl.DateTimeFormat("es-MX", {
          dateStyle: "full",
        }).format(now)}
      >
        <span>{weekday}</span>
        <strong>{now.getDate()}</strong>
        <small>{month}</small>
      </div>
    </section>
  )
}

/** Muestra la portada persistida o una cubierta tipográfica de respaldo. */
function BookCover({
  book,
  className = "",
}: {
  book: LibraryBookItem
  className?: string
}) {
  return (
    <div
      className={`library-ui-cover ${
        book.coverUrl ? "has-image" : "is-placeholder"
      } ${className}`}
    >
      {book.coverUrl ? (
        <img src={book.coverUrl} alt="" loading="lazy" />
      ) : (
        <>
          <span>{book.title}</span>
          <small>{book.author}</small>
          <em>EPUB</em>
        </>
      )}
    </div>
  )
}

/** Tarjeta destacada para retomar el libro abierto más recientemente. */
export function ContinueReadingCard({
  book,
  onOpen,
  onImport,
}: {
  book: LibraryBookItem | null
  onOpen: (id: string) => void
  onImport?: () => void
}) {
  const progress = clampProgress(book?.progress)
  return (
    <section className="continue-section">
      <div className="section-heading">
        <div>
          <span className="section-kicker">LEYENDO AHORA</span>
          <h2>Continúa leyendo</h2>
        </div>
      </div>
      {book ? (
        <button
          type="button"
          className="continue-card library-ui-continue"
          onClick={() => onOpen(book.id)}
        >
          <BookCover book={book} className="library-ui-continue-cover" />
          <div className="continue-copy">
            <span className="book-label">TU ÚLTIMA LECTURA</span>
            <h3>{book.title}</h3>
            <p>{book.author}</p>
            <div className="library-ui-progress-copy">
              {book.chapter ||
                (progress > 0 ? "Retoma tu lectura" : "Comienza este libro")}
            </div>
            <div className="progress-meta">
              <span>Progreso de lectura</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="progress-track">
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
          <span className="resume">
            Continuar <Icon name="chevron" size={16} />
          </span>
        </button>
      ) : (
        <div className="library-ui-empty-continue">
          <div className="library-ui-empty-icon">
            <Icon name="folder" size={22} />
          </div>
          <div>
            <h3>Aún no hay una lectura reciente</h3>
            <p>
              Abre un EPUB para guardar aquí tu avance y volver a él cuando
              quieras.
            </p>
          </div>
          {onImport && (
            <button type="button" onClick={onImport}>
              Abrir EPUB <Icon name="chevron" size={15} />
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Modal reutilizado por acciones que requieren confirmación.
 * `initialValue` distingue una acción con campo de texto de una confirmación
 * simple; `danger` cambia únicamente la presentación del botón destructivo.
 */
function ActionDialog({
  title,
  description,
  confirmLabel,
  initialValue,
  danger = false,
  onClose,
  onConfirm,
}: {
  title: string
  description: string
  confirmLabel: string
  initialValue?: string
  danger?: boolean
  onClose: () => void
  onConfirm: (value: string) => void | Promise<void>
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState(initialValue ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  /** Ejecuta la acción asíncrona sin permitir envíos duplicados. */
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (initialValue !== undefined && !value.trim()) {
      setError("Escribe un nombre para continuar.")
      return
    }
    setBusy(true)
    setError("")
    try {
      await onConfirm(value.trim())
      onClose()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo completar la acción.",
      )
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="library-ui-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          void submit(event)
        }}
      >
        <span className="section-kicker">TU BIBLIOTECA</span>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {initialValue !== undefined && (
          <input
            autoFocus
            maxLength={160}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Nombre del libro"
          />
        )}
        {error && (
          <div className="library-ui-form-error" role="alert">
            {error}
          </div>
        )}
        <div className="library-ui-dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            type="submit"
            className={danger ? "danger" : "primary"}
            disabled={busy}
          >
            {busy ? "Guardando…" : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/**
 * Tarjeta interactiva de un libro con menú accesible y diálogos de acciones.
 * El menú se porta a `document.body` para que ningún contenedor con overflow lo
 * recorte; por eso su posición se calcula respecto de la ventana.
 */
export function LibraryBookCard({
  book,
  collections,
  onOpen,
  onRename,
  onRemove,
  onToggleCollection,
  onShare,
}: {
  book: LibraryBookItem
  collections: LibraryCollectionItem[]
  onOpen: (id: string) => void
  onRename: (id: string, title: string) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
  onToggleCollection: (id: string, collectionId: string) => void | Promise<void>
  onShare: (id: string) => void | Promise<void>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [showCollections, setShowCollections] = useState(false)
  const [menuError, setMenuError] = useState("")
  const [dialog, setDialog] = useState<"rename" | "remove" | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const progress = clampProgress(book.progress)
  const [menuPosition, setMenuPosition] = useState({
    left: 0,
    top: 0,
    above: true,
  })

  // Mantiene el menú anclado al botón al desplazar o redimensionar la ventana.
  useEffect(() => {
    if (!menuOpen) return
    function positionMenu() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPosition({
        left: Math.max(12, Math.min(rect.right - 230, window.innerWidth - 242)),
        top: rect.top > 260 ? rect.top - 8 : rect.bottom + 8,
        above: rect.top > 260,
      })
    }
    positionMenu()
    window.addEventListener("resize", positionMenu)
    window.addEventListener("scroll", positionMenu, true)
    return () => {
      window.removeEventListener("resize", positionMenu)
      window.removeEventListener("scroll", positionMenu, true)
    }
  }, [menuOpen])

  // Cierra por clic/foco exterior o Escape y gestiona el foco inicial del menú.
  useEffect(() => {
    if (!menuOpen) return
    const onOutside = (event: PointerEvent) => {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !menuPanelRef.current?.contains(event.target as Node)
      ) {
        setMenuOpen(false)
        setShowCollections(false)
      }
    }
    const onFocusOutside = (event: FocusEvent) => {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !menuPanelRef.current?.contains(event.target as Node)
      ) {
        setMenuOpen(false)
        setShowCollections(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false)
        setShowCollections(false)
        triggerRef.current?.focus()
      }
    }
    const focusFrame = window.requestAnimationFrame(() =>
      menuPanelRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    )
    document.addEventListener("pointerdown", onOutside)
    document.addEventListener("focusin", onFocusOutside)
    document.addEventListener("keydown", onKey)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener("pointerdown", onOutside)
      document.removeEventListener("focusin", onFocusOutside)
      document.removeEventListener("keydown", onKey)
    }
  }, [menuOpen])

  /** Restablece todo el estado efímero del menú. */
  function closeMenu() {
    setMenuOpen(false)
    setShowCollections(false)
    setMenuError("")
  }

  return (
    <article className="book-card library-ui-book-card">
      <button
        type="button"
        className="library-ui-book-open"
        onClick={() => onOpen(book.id)}
        aria-label={`Abrir ${book.title}`}
      >
        <BookCover book={book} />
      </button>
      <div className="book-info library-ui-book-info">
        <div className="library-ui-book-meta">
          <button
            type="button"
            className="library-ui-book-title"
            onClick={() => onOpen(book.id)}
          >
            <h3 title={book.title}>{book.title}</h3>
          </button>
          <p title={book.author}>{book.author}</p>
        </div>
        <div className="library-ui-book-actions" ref={menuRef}>
          <button
            type="button"
            ref={triggerRef}
            className="library-ui-more"
            aria-label={`Más opciones para ${book.title}`}
            aria-haspopup="menu"
            aria-controls={menuId}
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((open) => !open)
              setShowCollections(false)
            }}
          >
            <Icon name="more" size={17} />
          </button>
          {menuOpen &&
            createPortal(
              <div
                ref={menuPanelRef}
                className={`library-ui-menu ${
                  menuPosition.above ? "above" : ""
                }`}
                style={{
                  left: menuPosition.left,
                  top: menuPosition.top,
                  maxHeight: menuPosition.above
                    ? menuPosition.top - 12
                    : window.innerHeight - menuPosition.top - 12,
                }}
                id={menuId}
                role="menu"
                aria-label={`Opciones para ${book.title}`}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp")
                    return
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  )
                  const index = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  )
                  items[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                      items.length
                  ]?.focus()
                  event.preventDefault()
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu()
                    setDialog("rename")
                  }}
                >
                  Renombrar
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-expanded={showCollections}
                  onClick={() => setShowCollections((open) => !open)}
                >
                  Agregar a una colección <Icon name="chevron" size={14} />
                </button>
                {showCollections && (
                  <div
                    className="library-ui-menu-collections"
                    role="group"
                    aria-label="Tus colecciones"
                  >
                    {collections.length ? (
                      collections.map((collection) => (
                        <button
                          type="button"
                          key={collection.id}
                          role="menuitemcheckbox"
                          aria-checked={collection.bookIds.includes(book.id)}
                          onClick={() => {
                            setMenuError("")
                            void Promise.resolve()
                              .then(() =>
                                onToggleCollection(book.id, collection.id),
                              )
                              .catch((cause) =>
                                setMenuError(
                                  cause instanceof Error
                                    ? cause.message
                                    : "No se pudo actualizar la colección.",
                                ),
                              )
                          }}
                        >
                          <span className="library-ui-check">
                            {collection.bookIds.includes(book.id) ? "✓" : ""}
                          </span>
                          {collection.name}
                        </button>
                      ))
                    ) : (
                      <p>
                        Aún no tienes colecciones. Puedes crear una debajo de la
                        biblioteca.
                      </p>
                    )}
                    {menuError && (
                      <p className="library-ui-menu-error" role="alert">
                        {menuError}
                      </p>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu()
                    void onShare(book.id)
                  }}
                >
                  Compartir o exportar
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="library-ui-menu-danger"
                  onClick={() => {
                    closeMenu()
                    setDialog("remove")
                  }}
                >
                  Eliminar de la biblioteca
                </button>
              </div>,
              document.body,
            )}
        </div>
      </div>
      {progress > 0 && (
        <div
          className="mini-progress"
          aria-label={`${Math.round(progress)}% leído`}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
      )}
      {dialog === "rename" && (
        <ActionDialog
          title="Renombrar libro"
          description="El archivo EPUB y tu progreso no cambiarán."
          confirmLabel="Guardar nombre"
          initialValue={book.title}
          onClose={() => setDialog(null)}
          onConfirm={(title) => onRename(book.id, title)}
        />
      )}
      {dialog === "remove" && (
        <ActionDialog
          title="Eliminar de la biblioteca"
          description={`Se eliminarán “${book.title}”, su archivo guardado y su progreso. Esta acción no se puede deshacer.`}
          confirmLabel="Eliminar libro"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() => onRemove(book.id)}
        />
      )}
    </article>
  )
}

/** Lista colecciones, permite crearlas y despliega sus libros de forma local. */
export function CollectionsSection({
  collections,
  books,
  onCreate,
  onOpenBook,
}: {
  collections: LibraryCollectionItem[]
  books: LibraryBookItem[]
  onCreate: (name: string) => void | Promise<void>
  onOpenBook: (id: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  /** Valida el nombre y delega la persistencia de la nueva colección. */
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim()) {
      setError("Ponle un nombre a la colección.")
      return
    }
    setBusy(true)
    setError("")
    try {
      await onCreate(name.trim())
      setName("")
      setCreating(false)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No se pudo crear la colección.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="library-ui-collections-section">
      <div className="section-heading library-ui-collections-heading">
        <div>
          <span className="section-kicker">ORGANIZA TUS LECTURAS</span>
          <h2>Colecciones</h2>
        </div>
        <button
          type="button"
          className="library-ui-create-button"
          onClick={() => setCreating((open) => !open)}
          aria-expanded={creating}
        >
          <Icon name="plus" size={17} /> Nueva colección
        </button>
      </div>
      {creating && (
        <form
          className="library-ui-create-form"
          onSubmit={(event) => {
            void create(event)
          }}
        >
          <label htmlFor="collection-name">Nombre de la colección</label>
          <div>
            <input
              id="collection-name"
              ref={inputRef}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Por ejemplo, Mis favoritos"
            />
            <button type="submit" disabled={busy}>
              {busy ? "Creando…" : "Crear"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false)
                setName("")
                setError("")
              }}
            >
              Cancelar
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      {collections.length ? (
        <div className="library-ui-collections-grid">
          {collections.map((collection) => {
            const members = collection.bookIds
              .map((id) => books.find((book) => book.id === id))
              .filter((book): book is LibraryBookItem => Boolean(book))
            const expanded = expandedId === collection.id
            return (
              <div className="library-ui-collection" key={collection.id}>
                <button
                  type="button"
                  className="library-ui-collection-trigger"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : collection.id)}
                >
                  <div
                    className="library-ui-collection-covers"
                    aria-hidden="true"
                  >
                    {members.length ? (
                      members.slice(0, 3).map((book) => (
                        <div
                          key={book.id}
                          className="library-ui-collection-mini-cover"
                        >
                          {book.coverUrl ? (
                            <img src={book.coverUrl} alt="" loading="lazy" />
                          ) : (
                            <span>{book.title}</span>
                          )}
                        </div>
                      ))
                    ) : (
                      <span className="library-ui-collection-folder">
                        <Icon name="folder" size={30} />
                      </span>
                    )}
                  </div>
                  <div className="library-ui-collection-label">
                    <strong>{collection.name}</strong>
                    <span>
                      {members.length}{" "}
                      {members.length === 1 ? "libro" : "libros"}
                    </span>
                  </div>
                  <span
                    className={`library-ui-collection-chevron ${
                      expanded ? "expanded" : ""
                    }`}
                  >
                    <Icon name="chevron" size={18} />
                  </span>
                </button>
                {expanded && (
                  <div className="library-ui-collection-content">
                    {members.length ? (
                      members.map((book) => (
                        <button
                          type="button"
                          key={book.id}
                          onClick={() => onOpenBook(book.id)}
                        >
                          {book.title}
                          <Icon name="chevron" size={14} />
                        </button>
                      ))
                    ) : (
                      <p>
                        Esta colección está vacía. Agrega libros desde su menú
                        de tres puntos.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="library-ui-empty-collections">
          <Icon name="folder" size={24} />
          <p>Crea una colección para agrupar los libros a tu manera.</p>
        </div>
      )}
    </section>
  )
}
