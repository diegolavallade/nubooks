import type { Book } from "epubjs"

/**
 * Destruye una instancia de epub.js únicamente después de que termine su trabajo.
 *
 * epub.js continúa analizando y sustituyendo recursos aun después de exponer los
 * metadatos. Destruir el libro durante ese periodo provoca excepciones asíncronas.
 * Si alguna promesa falla se conserva la instancia hasta que el recolector pueda
 * liberarla, porque llamar `destroy()` en ese estado es menos seguro.
 */
export function disposeEpubWhenReady(book: Book, extra?: Promise<unknown>) {
  const pending = extra
    ? [book.opened, book.ready, extra]
    : [book.opened, book.ready]
  void Promise.allSettled(pending).then((results) => {
    if (results.every((result) => result.status === "fulfilled")) book.destroy()
  })
}
