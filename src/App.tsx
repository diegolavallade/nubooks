import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import EpubReader, { type ImportedBook } from "./EpubReader"
import type { ReaderProgress } from "./ReliableEpubReader"
import { extractEpubMetadata } from "./epubMetadata"
import {
  createCollection,
  defaultReaderSettings,
  exportBook,
  getProfile,
  importBook,
  listBooks,
  listCollections,
  markBookOpened,
  readBook,
  removeBook,
  renameBook,
  setBookCover,
  setCollectionBooks,
  updateBookState,
  updateProfile,
  type BookProgress,
  type BookState,
  type StoredBook,
  type StoredCollection,
  type UserProfile,
} from "./storage"
import {
  CollectionsSection,
  ContinueReadingCard,
  LibraryBookCard,
  LibraryHero,
  type LibraryBookItem,
} from "./components/LibraryUI"

/**
 * Orquestador principal de Nubooks.
 *
 * Esta pantalla mantiene sincronizadas tres representaciones de la biblioteca:
 * el estado visible de React, la capa de persistencia de `storage.ts` y, cuando
 * hay un libro abierto, la sesión aislada de epub.js. Los datos binarios del
 * EPUB nunca viven aquí de forma permanente: solo se cargan al abrir un libro.
 */
type View = UserProfile["libraryView"]
type ActiveBook = {
  record: StoredBook
  readerBook: ImportedBook
}

/** Dibuja los iconos de navegación sin depender de una biblioteca externa. */
function Icon({
  name,
  size = 20,
}: {
  name: "books" | "carousel" | "grid" | "list" | "search" | "settings"
  size?: number
}) {
  const paths = {
    books: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </>
    ),
    carousel: (
      <>
        <rect x="6" y="4" width="12" height="16" rx="1.5" />
        <path d="M2 7v10M22 7v10" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    list: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <circle cx="3" cy="6" r=".5" fill="currentColor" />
        <circle cx="3" cy="12" r=".5" fill="currentColor" />
        <circle cx="3" cy="18" r=".5" fill="currentColor" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
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

/** Normaliza cualquier excepción a un mensaje seguro para mostrar en la interfaz. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Ocurrió un error inesperado."
}

/** Adapta el modelo persistido al modelo mínimo que consumen las tarjetas. */
function bookItem(book: StoredBook): LibraryBookItem {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    coverUrl: book.coverDataUrl,
    progress: book.progress?.percent ?? 0,
    chapter:
      book.progress?.chapter ??
      (book.progress?.location && book.progress.totalLocations
        ? "Ubicación " +
          book.progress.location +
          " de " +
          book.progress.totalLocations
        : null),
  }
}

/**
 * Diálogo modal para editar el nombre del perfil.
 * Mantiene abierto el elemento `<dialog>` mientras el componente exista y
 * bloquea el cierre accidental durante una escritura en curso.
 */
function ProfileDialog({
  name,
  settingsPerBook,
  onSave,
  onClose,
}: {
  name: string
  settingsPerBook: boolean
  onSave: (name: string, settingsPerBook: boolean) => Promise<void>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState(name)
  const [perBook, setPerBook] = useState(settingsPerBook)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  /** Valida mediante la capa superior, comunica errores y cierra al guardar. */
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await onSave(value, perBook)
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="profile-dialog"
      aria-labelledby="profile-title"
      onClick={event => { if (event.target === event.currentTarget && !busy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() } }}
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
        <span className="section-kicker">PREFERENCIAS</span>
        <h2 id="profile-title">Tu perfil</h2>
        <p>Así aparecerá tu nombre en el saludo de la biblioteca.</p>
        <label htmlFor="profile-name">Tu nombre</label>
        <input
          id="profile-name"
          autoFocus
          maxLength={80}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="¿Cómo te llamas?"
        />
        <small>Puedes dejarlo vacío para mostrar solo el saludo.</small>
        <div className="setting-row"><div><span>Configuración por libro</span><small style={{display:"block",marginTop:5}}>Desactiva para compartir tema, tipografía y formato entre todos.</small></div><button type="button" className={"switch " + (perBook ? "on" : "")} role="switch" aria-checked={perBook} aria-label="Configuración por libro" onClick={() => setPerBook(value => !value)}><i /></button></div>
        {error && (
          <div className="profile-error" role="alert">
            {error}
          </div>
        )}
        <div className="profile-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** Compone la biblioteca, el importador y el lector en una sola aplicación. */
export default function App() {
  // Estado persistente que se refleja en pantalla.
  const [books, setBooks] = useState<StoredBook[]>([])
  const [collections, setCollections] = useState<StoredCollection[]>([])
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    libraryView: "grid",
  })
  const [active, setActive] = useState<ActiveBook | null>(null)
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [profileOpen, setProfileOpen] = useState(false)
  const [coverBackfillTick, setCoverBackfillTick] = useState(0)

  // Referencias imperativas para controles nativos y escrituras diferidas.
  const fileInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const progressTimer = useRef<number | null>(null)
  const pendingProgress = useRef<{
    id: string
    value: BookProgress
  } | null>(
    null,
  )
  const bookWriteQueue = useRef<Promise<void>>(Promise.resolve())
  const attemptedCovers = useRef(new Set<string>())
  const profileWriteQueue = useRef<Promise<unknown>>(Promise.resolve())

  /** Recarga en paralelo los datos que pueden cambiar desde la biblioteca. */
  const refreshLibrary = useCallback(async () => {
    const [savedBooks, savedCollections] = await Promise.all([
      listBooks(),
      listCollections(),
    ])
    setBooks(savedBooks)
    setCollections(savedCollections)
  }, [])

  // Carga inicial. La bandera evita actualizar React si la vista se desmontó.
  useEffect(() => {
    let cancelled = false
    Promise.all([listBooks(), listCollections(), getProfile()])
      .then(([savedBooks, savedCollections, savedProfile]) => {
        if (cancelled) return
        setBooks(savedBooks)
        setCollections(savedCollections)
        setProfile(savedProfile)
      })
      .catch((cause) => {
        if (!cancelled)
          setError("No se pudo cargar la biblioteca: " + messageOf(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Atajo global de búsqueda; funciona con Ctrl en Windows/Linux y Cmd en macOS.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener("keydown", focusSearch)
    return () => window.removeEventListener("keydown", focusSearch)
  }, [])

  /**
   * Serializa las modificaciones de un libro.
   * IndexedDB y el archivo JSON nativo son consistentes por transacción, pero
   * esta cola además conserva el orden lógico de cambios rápidos de la UI.
   */
  const enqueueBookWrite = useCallback(
    (id: string, patch: Partial<BookState>) => {
      const task = bookWriteQueue.current.then(() => updateBookState(id, patch))
      bookWriteQueue.current = task.then(
        () => undefined,
        (cause) => {
          setError("No se pudo guardar la lectura: " + messageOf(cause))
        },
      )
      return task
    },
    [],
  )

  /** Persiste inmediatamente el último progreso pendiente, si existe. */
  const flushProgress = useCallback(async () => {
    if (progressTimer.current !== null)
      window.clearTimeout(progressTimer.current)
    progressTimer.current = null
    const pending = pendingProgress.current
    pendingProgress.current = null
    if (!pending) return
    try {
      await enqueueBookWrite(pending.id, { progress: pending.value })
    } catch {
      /* The write queue already displays the error. */
    }
  }, [enqueueBookWrite])

  // Reduce el riesgo de perder el último avance al ocultar o abandonar la página.
  useEffect(() => {
    const flushOnHide = () => {
      void flushProgress()
    }
    window.addEventListener("pagehide", flushOnHide)
    document.addEventListener("visibilitychange", flushOnHide)
    return () => {
      window.removeEventListener("pagehide", flushOnHide)
      document.removeEventListener("visibilitychange", flushOnHide)
    }
  }, [flushProgress])

  // Completa portadas antiguas de una en una para no abrir varios ZIP a la vez.
  useEffect(() => {
    if (loading || active) return
    const missing = books.find(
      (book) => !book.coverDataUrl && !attemptedCovers.current.has(book.id),
    )
    if (!missing) return
    attemptedCovers.current.add(missing.id)
    let cancelled = false
    void (async () => {
      try {
        const data = await readBook(missing.id)
        const file = new File([data], missing.fileName, {
          type: "application/epub+zip",
        })
        const metadata = await extractEpubMetadata(file)
        if (metadata.coverDataUrl) {
          const updated = await setBookCover(missing.id, metadata.coverDataUrl)
          if (!cancelled)
            setBooks((current) =>
              current.map((book) => (book.id === missing.id ? updated : book)),
            )
        }
      } catch {
        // A book without a usable cover keeps its typographic fallback.
      } finally {
        if (!cancelled) setCoverBackfillTick((value) => value + 1)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [books, loading, active, coverBackfillTick])

  /**
   * Actualiza el progreso de forma optimista y agrupa eventos de paginación
   * cercanos en una sola escritura (debounce de 500 ms).
   */
  const handleReaderProgress = useCallback(
    (id: string, value: ReaderProgress) => {
      const progress: BookProgress = {
        cfi: value.cfi || null,
        percent: value.percentage,
        chapter: null,
        section: value.section,
        page: value.page,
        pages: value.pages,
        location: value.location,
        totalLocations: value.totalLocations,
        updatedAt: new Date().toISOString(),
      }
      pendingProgress.current = { id, value: progress }
      setBooks((current) =>
        current.map((book) => (book.id === id ? { ...book, progress } : book)),
      )
      if (progressTimer.current !== null)
        window.clearTimeout(progressTimer.current)
      progressTimer.current = window.setTimeout(() => {
        void flushProgress()
      }, 500)
    },
    [flushProgress],
  )

  /** Recupera el binario, registra la apertura y crea la sesión del lector. */
  const openBook = useCallback(
    async (id: string) => {
      if (openingId) return
      setOpeningId(id)
      setError("")
      try {
        const data = await readBook(id)
        const record = await markBookOpened(id)
        setBooks((current) =>
          current.map((book) => (book.id === id ? record : book)),
        )
        setActive({
          record,
          readerBook: {
            id: record.id,
            title: record.title,
            author: record.author,
            data,
          },
        })
      } catch (cause) {
        setError("No se pudo abrir el libro: " + messageOf(cause))
      } finally {
        setOpeningId(null)
      }
    },
    [openingId],
  )

  /**
   * Valida e importa una selección de EPUB secuencialmente.
   * El procesamiento secuencial limita el uso de memoria porque extraer
   * metadatos implica descomprimir temporalmente cada archivo.
   */
  const importFiles = async (files: FileList | null) => {
    if (!files?.length || importing) return
    setImporting(true)
    setError("")
    const importedIds: string[] = []
    const failures: string[] = []
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".epub")) {
        failures.push(file.name + ": solo se admiten archivos EPUB.")
        continue
      }
      if (file.size < 4 || file.size > 200 * 1024 * 1024) {
        failures.push(file.name + ": el archivo está vacío o supera 200 MB.")
        continue
      }
      try {
        const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer())
        if (
          signature[0] !== 0x50 ||
          signature[1] !== 0x4b ||
          signature[2] !== 0x03 ||
          signature[3] !== 0x04
        ) {
          throw new Error("No parece un archivo EPUB válido.")
        }
        const metadata = await extractEpubMetadata(file)
        let book = await importBook(file, metadata)
        if (metadata.coverDataUrl && !book.coverDataUrl)
          book = await setBookCover(book.id, metadata.coverDataUrl)
        importedIds.push(book.id)
      } catch (cause) {
        failures.push(file.name + ": " + messageOf(cause))
      }
    }
    try {
      await refreshLibrary()
    } catch (cause) {
      failures.push("No se pudo actualizar la biblioteca: " + messageOf(cause))
    }
    if (failures.length) setError(failures.join(" "))
    setImporting(false)
    if (importedIds.length === 1) void openBook(importedIds[0])
  }

  /** Vacía todas las escrituras antes de volver a la biblioteca. */
  const closeReader = async () => {
    await flushProgress()
    await bookWriteQueue.current
    await profileWriteQueue.current
    setActive(null)
    try {
      await refreshLibrary()
    } catch (cause) {
      setError("No se pudo actualizar la biblioteca: " + messageOf(cause))
    }
  }

  /** Refleja ajustes al instante y los añade a la cola persistente. */
  const changeSettings = (id: string, settings: BookState["settings"]) => {
    if (profile.settingsPerBook === false) {
      setProfile(current => ({...current, globalReaderSettings: settings}))
      profileWriteQueue.current = profileWriteQueue.current.then(() => updateProfile({globalReaderSettings: settings})).catch(cause => setError(messageOf(cause)))
      return
    }
    setBooks((current) =>
      current.map((book) => (book.id === id ? { ...book, settings } : book)),
    )
    void enqueueBookWrite(id, { settings }).catch(() => undefined)
  }

  /** Guarda la preferencia de presentación sin bloquear la interacción. */
  const changeView = (view: View) => {
    setProfile((current) => ({ ...current, libraryView: view }))
    void updateProfile({ libraryView: view })
      .then(setProfile)
      .catch((cause) =>
        setError("No se pudo guardar la vista: " + messageOf(cause)),
      )
  }

  /** Renombra un libro y sustituye únicamente el registro afectado. */
  const rename = async (id: string, title: string) => {
    const updated = await renameBook(id, title)
    setBooks((current) =>
      current.map((book) => (book.id === id ? updated : book)),
    )
  }

  /** Elimina el libro y su pertenencia visible a todas las colecciones. */
  const remove = async (id: string) => {
    await removeBook(id)
    setBooks((current) => current.filter((book) => book.id !== id))
    setCollections((current) =>
      current.map((collection) => ({
        ...collection,
        bookIds: collection.bookIds.filter((bookId) => bookId !== id),
      })),
    )
  }

  /** Añade o quita un libro de una colección conservando los demás miembros. */
  const toggleCollection = async (bookId: string, collectionId: string) => {
    const collection = collections.find((item) => item.id === collectionId)
    if (!collection) throw new Error("Colección no encontrada.")
    const bookIds = collection.bookIds.includes(bookId)
      ? collection.bookIds.filter((id) => id !== bookId)
      : [...collection.bookIds, bookId]
    const updated = await setCollectionBooks(collectionId, bookIds)
    setCollections((current) =>
      current.map((item) => (item.id === collectionId ? updated : item)),
    )
  }

  /** Crea una colección y la incorpora al estado actual. */
  const create = async (name: string) => {
    const added = await createCollection(name)
    setCollections((current) => [...current, added])
  }

  /** Persiste el nombre del perfil y adopta la versión normalizada del almacén. */
  const saveProfile = async (name: string, settingsPerBook: boolean) => {
    const saved = await updateProfile({ name, settingsPerBook, globalReaderSettings: profile.globalReaderSettings ?? latest?.settings ?? defaultReaderSettings })
    setProfile(saved)
  }

  // Modelos derivados: se recalculan solo cuando cambian sus dependencias.
  const items = useMemo(() => books.map(bookItem), [books])
  const normalizedQuery = query.trim().toLocaleLowerCase("es-MX")
  const filtered = useMemo(
    () =>
      items.filter((book) =>
        (book.title + " " + book.author)
          .toLocaleLowerCase("es-MX")
          .includes(normalizedQuery),
      ),
    [items, normalizedQuery],
  )
  const latest = useMemo(
    () =>
      [...books]
        .filter((book) => book.lastOpenedAt)
        .sort((a, b) =>
          (b.lastOpenedAt || "").localeCompare(a.lastOpenedAt || ""),
        )[0] ?? null,
    [books],
  )

  // El lector sustituye por completo la biblioteca mientras haya una sesión activa.
  if (active)
    return (
      <EpubReader
        book={active.readerBook}
        initialSettings={profile.settingsPerBook === false ? (profile.globalReaderSettings ?? defaultReaderSettings) : active.record.settings}
        coverUrl={active.record.coverDataUrl}
        initialBookmarks={active.record.bookmarks}
        onBookmarksChange={bookmarks => { setBooks(current => current.map(book => book.id === active.record.id ? {...book, bookmarks} : book)); void enqueueBookWrite(active.record.id, {bookmarks}).catch(() => undefined) }}
        initialPosition={active.record.progress?.cfi}
        onSettingsChange={(settings) =>
          changeSettings(active.record.id, settings)
        }
        onProgress={(progress) =>
          handleReaderProgress(active.record.id, progress)
        }
        onClose={() => {
          void closeReader()
        }}
      />
    )

  // Vista principal de biblioteca.
  return (
    <div className="app-shell">
      <main className="content">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="books" size={19} />
            </span>
            <span>Lector</span>
          </div>
          <label className="search-box">
            <Icon name="search" size={18} />
            <input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar en tu biblioteca"
              aria-label="Buscar en tu biblioteca"
            />
            <kbd>Ctrl K</kbd>
          </label>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".epub,application/epub+zip"
            multiple
            onChange={(event) => {
              void importFiles(event.target.files)
              event.target.value = ""
            }}
            aria-label="Seleccionar archivos EPUB"
          />
          <button
            className="import-button"
            onClick={() => fileInput.current?.click()}
            disabled={importing || loading}
            title="Abrir archivos EPUB"
          >
            <span className="import-plus">+</span>
            <span>{importing ? "Importando…" : "Abrir EPUB"}</span>
          </button>
          <button
            className="top-settings"
            onClick={() => setProfileOpen(true)}
            aria-label="Abrir preferencias de perfil"
          >
            <Icon name="settings" />
          </button>
        </header>

        {error && (
          <div className="import-error app-error" role="alert">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Cerrar aviso"
            >
              ×
            </button>
          </div>
        )}

        <LibraryHero userName={profile.name} hasBooks={books.length > 0} />
        <ContinueReadingCard
          book={latest ? bookItem(latest) : null}
          onOpen={(id) => {
            void openBook(id)
          }}
          onImport={() => fileInput.current?.click()}
        />

        <section className="library-section">
          <div className="section-heading library-heading">
            <div>
              <span className="section-kicker">TUS LIBROS</span>
              <h2>Tu biblioteca</h2>
            </div>
            <div className="view-toggle" aria-label="Vista de biblioteca">
              {(["grid", "list", "carousel"] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  className={profile.libraryView === view ? "active" : ""}
                  onClick={() => changeView(view)}
                  aria-label={
                    view === "grid"
                      ? "Vista de cuadrícula"
                      : view === "list"
                        ? "Vista de lista"
                        : "Vista de carrusel horizontal"
                  }
                  aria-pressed={profile.libraryView === view}
                >
                  <Icon name={view} size={17} />
                </button>
              ))}
            </div>
          </div>
          {loading ? (
            <div className="empty-state">Cargando biblioteca…</div>
          ) : (
            <>
              <div className={"book-collection " + profile.libraryView}>
                {filtered.map((book) => (
                  <LibraryBookCard
                    key={book.id}
                    book={book}
                    collections={collections}
                    onOpen={(id) => {
                      void openBook(id)
                    }}
                    onRename={rename}
                    onRemove={remove}
                    onToggleCollection={toggleCollection}
                    onShare={async (id) => {
                      try {
                        await exportBook(id)
                      } catch (cause) {
                        setError(
                          "No se pudo exportar el EPUB: " + messageOf(cause),
                        )
                      }
                    }}
                  />
                ))}
              </div>
              {!filtered.length && (
                <div className="empty-state">
                  {books.length
                    ? "No encontramos libros con “" + query + "”."
                    : "Todavía no hay libros. Abre un EPUB para comenzar tu biblioteca."}
                </div>
              )}
            </>
          )}
        </section>

        <CollectionsSection
          collections={collections}
          books={items}
          onCreate={create}
          onOpenBook={(id) => {
            void openBook(id)
          }}
        />
      </main>
      {profileOpen && (
        <ProfileDialog
          name={profile.name}
          settingsPerBook={profile.settingsPerBook !== false}
          onSave={saveProfile}
          onClose={() => setProfileOpen(false)}
        />
      )}
      {openingId && (
        <div className="reader-book-opening waiting" aria-label="Abriendo libro"><div className="reader-opening-cover">{books.find(book => book.id === openingId)?.coverDataUrl ? <img src={books.find(book => book.id === openingId)!.coverDataUrl!} alt="" /> : <span>{books.find(book => book.id === openingId)?.title}</span>}</div></div>
      )}
    </div>
  )
}
