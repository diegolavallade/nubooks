import ePub, { type Book } from "epubjs"
import { disposeEpubWhenReady } from "./epubLifecycle"

/**
 * Extracción y normalización de metadatos de importación.
 * Las portadas se convierten a data URL persistibles y se redimensionan para
 * que ni IndexedDB ni el archivo de metadatos nativo almacenen imágenes enormes.
 */

/** Resultado estable que consume la capa de almacenamiento. */
export type EpubImportMetadata = {
  title: string
  author: string
  coverDataUrl: string | null
}

const MAX_COVER_SOURCE_BYTES = 20 * 1024 * 1024
const MAX_STORED_COVER_BYTES = 2 * 1024 * 1024
const MAX_COVER_DIMENSION = 900

/** Limita esperas de epub.js para que un recurso defectuoso no bloquee la importación. */
function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Tiempo de espera agotado al leer el EPUB.")),
        milliseconds,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Carga una URL como imagen DOM y rechaza archivos corruptos o demasiado lentos. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const timer = setTimeout(() => {
      image.src = ""
      reject(new Error("Tiempo de espera agotado al cargar la portada."))
    }, 10000)
    image.onload = () => {
      clearTimeout(timer)
      resolve(image)
    }
    image.onerror = () => {
      clearTimeout(timer)
      reject(new Error("La portada no es una imagen válida."))
    }
    image.src = url
  })
}

/** Envuelve la API por callback de canvas en una promesa. */
function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Codifica un blob para guardarlo junto con los metadatos del libro. */
function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("No se pudo codificar la portada."))
    reader.onerror = () =>
      reject(reader.error ?? new Error("No se pudo codificar la portada."))
    reader.readAsDataURL(blob)
  })
}

/**
 * Convierte una portada temporal en una imagen WebP/JPEG pequeña y persistible.
 * El fondo blanco evita que transparencias se vuelvan negras al usar JPEG.
 */
async function persistentCover(sourceUrl: string): Promise<string | null> {
  // Imported EPUBs are opened from bytes, so epub.js provides a temporary blob
  // URL. Never store that URL: the library must survive a reload and reopening.
  if (!sourceUrl.startsWith("blob:") && !sourceUrl.startsWith("data:image/"))
    return null
  const source = await (await fetch(sourceUrl)).blob()
  if (!source.size || source.size > MAX_COVER_SOURCE_BYTES) return null

  const imageUrl = URL.createObjectURL(source)
  try {
    const image = await loadImage(imageUrl)
    if (!image.naturalWidth || !image.naturalHeight) return null
    const scale = Math.min(
      1,
      MAX_COVER_DIMENSION / image.naturalWidth,
      MAX_COVER_DIMENSION / image.naturalHeight,
    )
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext("2d")
    if (!context) return null
    // JPEG fallback remains legible for transparent source artwork.
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    for (const [type, quality] of [
      ["image/webp", 0.84],
      ["image/jpeg", 0.78],
    ] as const) {
      const output = await canvasBlob(canvas, type, quality)
      if (
        !output ||
        output.size > MAX_STORED_COVER_BYTES ||
        !/^image\/(webp|jpeg|png)$/.test(output.type)
      )
        continue
      return blobDataUrl(output)
    }
    return null
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

/** Busca portadas declaradas informalmente cuando `book.coverUrl()` no las detecta. */
async function manifestCover(book: Book): Promise<string | null> {
  if (!book.archived) return null
  // epub.js does not recognize every EPUB 2/3 cover declaration. Restrict the
  // fallback to manifest images explicitly named like covers, rather than
  // mistaking the first illustration in a book for its jacket.
  const coverName =
    /(?:^|[/._-])(cover(?:image|art)?|portada|cubierta|front)(?:$|[/._0-9-])/i
  const candidates = Object.entries(book.packaging.manifest ?? {}).filter(
    ([id, item]) =>
      item.type?.startsWith("image/") &&
      (coverName.test(id) || coverName.test(item.href)),
  )
  for (const [, item] of candidates.slice(0, 3)) {
    try {
      const url = await book.archive.createUrl(book.resolve(item.href), {
        base64: false,
      })
      const cover = await persistentCover(url)
      if (cover) return cover
    } catch {
      /* Try the next candidate. */
    }
  }
  return null
}

/** Extrae título, autor y portada sin descartar el EPUB por una cubierta defectuosa. */
export async function extractEpubMetadata(
  file: File,
): Promise<EpubImportMetadata> {
  const book = ePub(await file.arrayBuffer())
  const extraction = (async (): Promise<EpubImportMetadata> => {
    // Metadata is available before epub.js finishes all resource replacements.
    // Waiting for `opened` here can stall importing an otherwise usable book
    // when an unrelated resource in its archive is malformed.
    const metadata = await withTimeout(book.loaded.metadata, 20000)
    const title =
      metadata.title?.trim() ||
      file.name.replace(/\.epub$/i, "") ||
      "Sin título"
    const author = metadata.creator?.trim() || "Autor desconocido"
    let coverDataUrl: string | null = null
    try {
      const coverUrl = await withTimeout(book.coverUrl(), 10000)
      if (coverUrl) coverDataUrl = await persistentCover(coverUrl)
    } catch {
      // A missing, corrupt, or oversized cover should not discard a valid book.
    }
    if (!coverDataUrl) coverDataUrl = await manifestCover(book)
    return { title, author, coverDataUrl }
  })()
  disposeEpubWhenReady(
    book,
    extraction.catch(() => undefined),
  )
  return extraction
}
