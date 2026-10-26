import { invoke, isTauri } from "@tauri-apps/api/core"

/**
 * Capa unificada de persistencia de Nubooks.
 *
 * Toda la aplicación consume estas funciones sin saber dónde se ejecuta:
 * - en Tauri, las operaciones invocan comandos Rust y guardan archivos reales;
 * - en el preview web, IndexedDB conserva tanto registros como blobs EPUB.
 *
 * La API y los modelos son deliberadamente idénticos en ambos entornos. No se
 * usa localStorage para la biblioteca porque no es apropiado para archivos
 * binarios grandes ni ofrece transacciones entre registros relacionados.
 */

/** Preferencias del lector guardadas por libro. */
export type ReaderSettings = {
  fontScale?: number
  fontSize: "small" | "medium" | "large"
  animation: "slide" | "ripple" | "fade" | "continuous"
  theme: "light" | "dark"
  columns: "1" | "2" | "auto"
  justify: boolean
}

/** Última ubicación conocida y datos auxiliares para mostrar el avance. */
export type BookProgress = {
  cfi: string | null
  percent: number
  chapter: string | null
  section?: number | null
  page?: number | null
  pages?: number | null
  location?: number | null
  totalLocations?: number | null
  updatedAt: string
}

/** Marcador creado por el usuario dentro de un EPUB. */
export type Bookmark = {
  id: string
  cfi: string
  label: string
  createdAt: string
  kind?: "bookmark" | "highlight"
  chapter?: string
  percent?: number
}

/** Registro completo de un libro, excluyendo el binario EPUB. */
export type StoredBook = {
  id: string
  title: string
  author: string
  fileName: string
  coverDataUrl: string | null
  addedAt: string
  lastOpenedAt: string | null
  progress: BookProgress | null
  settings: ReaderSettings
  bookmarks: Bookmark[]
}

/** Porción modificable del registro durante una sesión de lectura. */
export type BookState = Pick<StoredBook, "settings" | "progress" | "bookmarks">

/** Preferencias generales de la biblioteca. */
export type UserProfile = {
  name: string
  libraryView: "grid" | "list" | "carousel"
  settingsPerBook?: boolean
  globalReaderSettings?: ReaderSettings
}

/** Agrupación ordenada de referencias a libros existentes. */
export type StoredCollection = {
  id: string
  name: string
  bookIds: string[]
  createdAt: string
  updatedAt: string
}

/** Metadatos opcionales obtenidos antes de persistir un EPUB. */
export type ImportMetadata = {
  title?: string
  author?: string
  coverDataUrl?: string | null
}

/** Configuración inicial asignada de forma independiente a cada libro nuevo. */
export const defaultReaderSettings: ReaderSettings = {
  fontSize: "medium",
  animation: "slide",
  theme: "light",
  columns: "auto",
  justify: false,
}
const defaultProfile: UserProfile = { name: "", libraryView: "grid" }
const MAX_EPUB_BYTES = 200 * 1024 * 1024
const MAX_COVER_BYTES = 3 * 1024 * 1024
const DB_NAME = "nubooks-library"
const DB_VERSION = 1
const desktop = isTauri()

/** Elimina controles, limita longitud y aplica un valor alternativo si queda vacío. */
function cleanName(value: string, fallback: string, maxLength = 200): string {
  return (
    value
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, maxLength) || fallback
  )
}

/** Valida formato, MIME y tamaño aproximado de una portada codificada en base64. */
function validateCover(dataUrl: string | null | undefined): string | null {
  if (!dataUrl) return null
  const match =
    /^data:(image\/(?:jpeg|png|webp|gif|svg\+xml));base64,([a-zA-Z0-9+/=]+)$/.exec(
      dataUrl,
    )
  if (!match || match[2].length > Math.ceil((MAX_COVER_BYTES * 4) / 3) + 4) {
    throw new Error("La portada debe ser una imagen válida de hasta 3 MB.")
  }
  return dataUrl
}

/** Extrae únicamente el estado que puede editar el lector. */
function asBookState(book: StoredBook): BookState {
  return {
    settings: book.settings,
    progress: book.progress,
    bookmarks: book.bookmarks,
  }
}

/** Convierte una petición IndexedDB basada en eventos a una promesa tipada. */
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error("Error de IndexedDB"))
  })
}

/** Se resuelve solo tras confirmar la transacción completa, no cada petición individual. */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Transacción cancelada"))
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Error de IndexedDB"))
  })
}

// Se comparte la promesa de apertura para no crear conexiones concurrentes.
// Si falla, se limpia la caché y una llamada posterior puede volver a intentar.
let browserDb: Promise<IDBDatabase> | null = null

/** Abre o crea el esquema IndexedDB usado por el adaptador del navegador. */
function db(): Promise<IDBDatabase> {
  if (!browserDb)
    browserDb = new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, DB_VERSION)
      opening.onupgradeneeded = () => {
        const database = opening.result
        if (!database.objectStoreNames.contains("books"))
          database.createObjectStore("books", { keyPath: "id" })
        if (!database.objectStoreNames.contains("files"))
          database.createObjectStore("files")
        if (!database.objectStoreNames.contains("collections"))
          database.createObjectStore("collections", { keyPath: "id" })
        if (!database.objectStoreNames.contains("meta"))
          database.createObjectStore("meta")
      }
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () =>
        reject(opening.error ?? new Error("No se pudo abrir la biblioteca"))
    }).catch((error) => {
      browserDb = null
      throw error
    })
  return browserDb
}

/** Codifica metadatos UTF-8 en el encabezado aceptado por el comando Rust. */
function encodeHeader(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
}

/** Calcula el identificador por contenido; reimportar los mismos bytes es idempotente. */
async function hashEpub(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(hash, (part) => part.toString(16).padStart(2, "0")).join("")
}

/** Aplica validaciones rápidas de nombre, tamaño y firma ZIP. */
function validateEpub(bytes: ArrayBuffer, name: string): void {
  if (!name.toLowerCase().endsWith(".epub"))
    throw new Error("Selecciona un archivo .epub.")
  if (bytes.byteLength < 4 || bytes.byteLength > MAX_EPUB_BYTES)
    throw new Error("El EPUB está vacío o supera 200 MB.")
  const prefix = new Uint8Array(bytes, 0, 4)
  if (
    prefix[0] !== 0x50 ||
    prefix[1] !== 0x4b ||
    prefix[2] !== 0x03 ||
    prefix[3] !== 0x04
  ) {
    throw new Error("El archivo no parece ser un EPUB válido.")
  }
}

/**
 * Importa un EPUB validado y evita duplicados mediante su SHA-256.
 * En navegador, registro y blob se escriben en una única transacción atómica.
 */
export async function importBook(
  file: File,
  metadata: ImportMetadata = {},
): Promise<StoredBook> {
  if (file.size > MAX_EPUB_BYTES)
    throw new Error("El EPUB supera el límite de 200 MB.")
  const bytes = await file.arrayBuffer()
  validateEpub(bytes, file.name)
  const id = await hashEpub(bytes)
  const title = cleanName(
    metadata.title ?? file.name.replace(/\.epub$/i, ""),
    "Sin título",
  )
  const author = cleanName(metadata.author ?? "", "Autor desconocido")
  const coverDataUrl = validateCover(metadata.coverDataUrl)
  if (desktop) {
    const book = await invoke<StoredBook>(
      "import_epub",
      new Uint8Array(bytes),
      {
        headers: {
          "X-Nubooks-Metadata": encodeHeader({
            id,
            title,
            author,
            fileName: file.name,
          }),
        },
      },
    )
    if (coverDataUrl && !book.coverDataUrl)
      return invoke<StoredBook>("set_cover", { id, dataUrl: coverDataUrl })
    return book
  }
  const database = await db()
  const old = await request<StoredBook | undefined>(
    database.transaction("books").objectStore("books").get(id),
  )
  if (old)
    return coverDataUrl && !old.coverDataUrl
      ? setBookCover(id, coverDataUrl)
      : old
  const now = new Date().toISOString()
  const book: StoredBook = {
    id,
    title,
    author,
    fileName: cleanName(file.name, `${id}.epub`),
    coverDataUrl,
    addedAt: now,
    lastOpenedAt: null,
    progress: null,
    settings: { ...defaultReaderSettings },
    bookmarks: [],
  }
  const transaction = database.transaction(["books", "files"], "readwrite")
  transaction.objectStore("books").put(book)
  transaction
    .objectStore("files")
    .put(new Blob([bytes], { type: "application/epub+zip" }), id)
  await completed(transaction)
  return book
}

/** Devuelve libros ordenados por apertura reciente y luego por fecha de alta. */
export async function listBooks(): Promise<StoredBook[]> {
  if (desktop) return invoke<StoredBook[]>("list_books")
  const database = await db()
  const books = await request<StoredBook[]>(
    database.transaction("books").objectStore("books").getAll(),
  )
  return books.sort((a, b) =>
    (b.lastOpenedAt ?? b.addedAt).localeCompare(a.lastOpenedAt ?? a.addedAt),
  )
}

/** Recupera los bytes completos necesarios para construir la sesión de epub.js. */
export async function readBook(id: string): Promise<ArrayBuffer> {
  if (desktop) return invoke<ArrayBuffer>("read_epub", { id })
  const database = await db()
  const file = await request<Blob | undefined>(
    database.transaction("files").objectStore("files").get(id),
  )
  if (!file) throw new Error("No se encontró el archivo EPUB en la biblioteca.")
  return file.arrayBuffer()
}

/** Elimina registro, binario y referencias de colecciones en una transacción. */
export async function removeBook(id: string): Promise<void> {
  if (desktop) return invoke<void>("remove_book", { id })
  const database = await db()
  const transaction = database.transaction(
    ["books", "files", "collections"],
    "readwrite",
  )
  transaction.objectStore("books").delete(id)
  transaction.objectStore("files").delete(id)
  const cursor = transaction.objectStore("collections").openCursor()
  cursor.onsuccess = () => {
    const entry = cursor.result
    if (!entry) return
    const collection = entry.value as StoredCollection
    if (collection.bookIds.includes(id))
      entry.update({
        ...collection,
        bookIds: collection.bookIds.filter((item) => item !== id),
        updatedAt: new Date().toISOString(),
      })
    entry.continue()
  }
  await completed(transaction)
}

/**
 * Patrón común de lectura-modificación-escritura para libros en IndexedDB.
 * La función `change` se ejecuta dentro de la transacción para no pisar cambios.
 */
async function browserUpdateBook(
  id: string,
  change: (book: StoredBook) => StoredBook,
): Promise<StoredBook> {
  const database = await db()
  const transaction = database.transaction("books", "readwrite")
  const done = completed(transaction)
  const store = transaction.objectStore("books")
  const updated = new Promise<StoredBook>((resolve, reject) => {
    const lookup = store.get(id)
    lookup.onsuccess = () => {
      if (!lookup.result) {
        reject(new Error("Libro no encontrado"))
        return
      }
      try {
        const book = change(lookup.result as StoredBook)
        store.put(book)
        resolve(book)
      } catch (error) {
        reject(error)
      }
    }
    lookup.onerror = () => reject(lookup.error)
  })
  const book = await updated
  await done
  return book
}

/** Cambia únicamente el título visible; no renombra ni modifica el EPUB. */
export async function renameBook(
  id: string,
  title: string,
): Promise<StoredBook> {
  const clean = cleanName(title, "")
  if (!clean) throw new Error("Escribe un título para el libro.")
  if (desktop) return invoke<StoredBook>("rename_book", { id, title: clean })
  return browserUpdateBook(id, (book) => ({ ...book, title: clean }))
}

/** Marca una apertura con fecha ISO para alimentar “Continúa leyendo”. */
export async function markBookOpened(id: string): Promise<StoredBook> {
  if (desktop) return invoke<StoredBook>("mark_book_opened", { id })
  return browserUpdateBook(id, (book) => ({
    ...book,
    lastOpenedAt: new Date().toISOString(),
  }))
}

/** Obtiene el estado de lectura sin transferir el binario o datos de catálogo. */
export async function getBookState(id: string): Promise<BookState> {
  if (desktop) return invoke<BookState>("get_book_state", { id })
  const database = await db()
  const book = await request<StoredBook | undefined>(
    database.transaction("books").objectStore("books").get(id),
  )
  if (!book) throw new Error("Libro no encontrado")
  return asBookState(book)
}

/** Fusiona ajustes y reemplaza explícitamente progreso/marcadores si se proporcionan. */
export async function updateBookState(
  id: string,
  patch: Partial<BookState>,
): Promise<StoredBook> {
  if (desktop) return invoke<StoredBook>("update_book_state", { id, patch })
  return browserUpdateBook(id, (book) => ({
    ...book,
    settings: patch.settings
      ? { ...book.settings, ...patch.settings }
      : book.settings,
    progress: patch.progress === undefined ? book.progress : patch.progress,
    bookmarks: patch.bookmarks === undefined ? book.bookmarks : patch.bookmarks,
  }))
}

/** Asigna o retira la portada después de validarla. */
export async function setBookCover(
  id: string,
  coverDataUrl: string | null,
): Promise<StoredBook> {
  const cover = validateCover(coverDataUrl)
  if (desktop) return invoke<StoredBook>("set_cover", { id, dataUrl: cover })
  return browserUpdateBook(id, (book) => ({ ...book, coverDataUrl: cover }))
}

/**
 * Exporta una copia del EPUB.
 * Tauri abre un diálogo nativo; el navegador crea una URL temporal y simula una
 * descarga, revocándola después para liberar memoria.
 */
export async function exportBook(id: string): Promise<boolean> {
  if (desktop) return invoke<boolean>("export_epub", { id })
  const database = await db()
  const book = await request<StoredBook | undefined>(
    database.transaction("books").objectStore("books").get(id),
  )
  if (!book) throw new Error("Libro no encontrado")
  const bytes = await readBook(id)
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/epub+zip" }),
  )
  const link = document.createElement("a")
  link.href = url
  link.download = book.fileName.toLowerCase().endsWith(".epub")
    ? book.fileName
    : `${book.title}.epub`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return true
}

/** Obtiene el perfil o crea conceptualmente sus valores iniciales. */
export async function getProfile(): Promise<UserProfile> {
  if (desktop) return invoke<UserProfile>("get_profile")
  const database = await db()
  return (
    (await request<UserProfile | undefined>(
      database.transaction("meta").objectStore("meta").get("profile"),
    )) ?? { ...defaultProfile }
  )
}

/** Actualiza campos del perfil conservando los que no aparecen en el parche. */
export async function updateProfile(
  patch: Partial<UserProfile>,
): Promise<UserProfile> {
  if (desktop) return invoke<UserProfile>("update_profile", { patch })
  const database = await db()
  const transaction = database.transaction("meta", "readwrite")
  const done = completed(transaction)
  const store = transaction.objectStore("meta")
  const updated = new Promise<UserProfile>((resolve, reject) => {
    const lookup = store.get("profile")
    lookup.onsuccess = () => {
      const current = lookup.result as UserProfile | undefined ?? defaultProfile
      const profile: UserProfile = {
        name:
          patch.name === undefined
            ? current.name
            : patch.name
                .trim()
                .replace(/[\u0000-\u001f\u007f]/g, " ")
                .slice(0, 80),
        libraryView: patch.libraryView ?? current.libraryView,
        settingsPerBook: patch.settingsPerBook ?? current.settingsPerBook ?? true,
        globalReaderSettings: patch.globalReaderSettings ?? current.globalReaderSettings,
      }
      store.put(profile, "profile")
      resolve(profile)
    }
    lookup.onerror = () => reject(lookup.error)
  })
  const profile = await updated
  await done
  return profile
}

/** Lista colecciones en el mismo orden en que se crearon. */
export async function listCollections(): Promise<StoredCollection[]> {
  if (desktop) return invoke<StoredCollection[]>("list_collections")
  const database = await db()
  const values = await request<StoredCollection[]>(
    database.transaction("collections").objectStore("collections").getAll(),
  )
  return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Crea una colección vacía con identificador y marcas de tiempo nuevas. */
export async function createCollection(
  name: string,
): Promise<StoredCollection> {
  const clean = cleanName(name, "", 100)
  if (!clean) throw new Error("Escribe un nombre para la colección.")
  if (desktop)
    return invoke<StoredCollection>("create_collection", { name: clean })
  const now = new Date().toISOString()
  const collection: StoredCollection = {
    id: crypto.randomUUID(),
    name: clean,
    bookIds: [],
    createdAt: now,
    updatedAt: now,
  }
  const database = await db()
  const transaction = database.transaction("collections", "readwrite")
  transaction.objectStore("collections").put(collection)
  await completed(transaction)
  return collection
}

/** Equivalente transaccional de `browserUpdateBook` para colecciones. */
async function browserUpdateCollection(
  id: string,
  change: (value: StoredCollection) => StoredCollection,
): Promise<StoredCollection> {
  const database = await db()
  const transaction = database.transaction("collections", "readwrite")
  const done = completed(transaction)
  const store = transaction.objectStore("collections")
  const updated = new Promise<StoredCollection>((resolve, reject) => {
    const lookup = store.get(id)
    lookup.onsuccess = () => {
      if (!lookup.result) {
        reject(new Error("Colección no encontrada"))
        return
      }
      const value = change(lookup.result as StoredCollection)
      store.put(value)
      resolve(value)
    }
    lookup.onerror = () => reject(lookup.error)
  })
  const result = await updated
  await done
  return result
}

/** Cambia el nombre y registra cuándo se modificó la colección. */
export async function renameCollection(
  id: string,
  name: string,
): Promise<StoredCollection> {
  const clean = cleanName(name, "", 100)
  if (!clean) throw new Error("Escribe un nombre para la colección.")
  if (desktop)
    return invoke<StoredCollection>("rename_collection", { id, name: clean })
  return browserUpdateCollection(id, (value) => ({
    ...value,
    name: clean,
    updatedAt: new Date().toISOString(),
  }))
}

/**
 * Sustituye miembros, elimina duplicados y rechaza referencias inexistentes.
 * Validar aquí mantiene el mismo contrato que aplica el backend nativo.
 */
export async function setCollectionBooks(
  id: string,
  bookIds: string[],
): Promise<StoredCollection> {
  if (desktop)
    return invoke<StoredCollection>("set_collection_books", { id, bookIds })
  const known = new Set((await listBooks()).map((book) => book.id))
  const unique = [...new Set(bookIds)]
  if (unique.some((bookId) => !known.has(bookId)))
    throw new Error("La colección contiene un libro inexistente.")
  return browserUpdateCollection(id, (value) => ({
    ...value,
    bookIds: unique,
    updatedAt: new Date().toISOString(),
  }))
}

/** Elimina la colección sin afectar a ninguno de sus libros. */
export async function deleteCollection(id: string): Promise<void> {
  if (desktop) return invoke<void>("delete_collection", { id })
  const database = await db()
  const transaction = database.transaction("collections", "readwrite")
  transaction.objectStore("collections").delete(id)
  await completed(transaction)
}
