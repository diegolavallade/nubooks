import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Prueba de humo de la API de almacenamiento en navegador.
 *
 * Conduce Edge mediante Chrome DevTools Protocol (CDP), usa un perfil temporal
 * y carga el módulo real servido por Vite. Verifica dos sesiones separadas para
 * demostrar que IndexedDB conserva datos tras una recarga.
 * Requisito: Vite disponible en http://127.0.0.1:8443/.
 */
const profile = await mkdtemp(path.join(tmpdir(), "nubooks-storage-smoke-"))
const browserPath =
  process.env.EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket

/** Espera el archivo con el puerto CDP que Edge crea después de arrancar. */
async function debugPort() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return Number(
        (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0],
      )
    } catch {
      await delay(150)
    }
  }
  throw new Error("Edge did not expose a debugging port")
}

try {
  // Descubre la página inicial y establece el canal de comandos CDP.
  const port = await debugPort()
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()
  const page = targets.find((target) => target.type === "page")
  if (!page) throw new Error("No page target")
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let sequence = 0
  const pending = new Map()

  // Correlaciona cada respuesta CDP con la promesa creada por `command`.
  socket.onmessage = ({ data }) => {
    const response = JSON.parse(data)
    if (!response.id || !pending.has(response.id)) return
    const { resolve, reject } = pending.get(response.id)
    pending.delete(response.id)
    response.error
      ? reject(new Error(response.error.message))
      : resolve(response.result)
  }

  /** Envía un comando CDP con identificador único y timeout defensivo. */
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 20000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })

  /** Evalúa JavaScript en la página y propaga sus excepciones al proceso Node. */
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      )
    return result.result.value
  }
  await command("Runtime.enable")
  await command("Page.enable")
  await command("Page.navigate", { url: "http://127.0.0.1:8443/" })
  await delay(1000)

  // Primera sesión: escribe una muestra representativa de todos los modelos.
  const first = await evaluate(`(async () => {
    const storage = await import('/src/storage.ts');
    const assert = (condition, message) => { if (!condition) throw new Error(message) };
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], 'smoke.epub');
    const book = await storage.importBook(file, { title: 'Prueba persistente', author: 'Nubooks' });
    assert((await storage.readBook(book.id)).byteLength === 7, 'binary missing');
    const collection = await storage.createCollection('Mi colección');
    await storage.setCollectionBooks(collection.id, [book.id]);
    await storage.updateBookState(book.id, { settings: { ...book.settings, theme: 'dark' } });
    await storage.updateBookState(book.id, { progress: { cfi: 'epubcfi(/6/2)', percent: 37, chapter: 'Capítulo 1', updatedAt: new Date().toISOString() } });
    await storage.setBookCover(book.id, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==');
    await storage.renameBook(book.id, 'Otro nombre');
    await storage.markBookOpened(book.id);
    await Promise.all([storage.updateProfile({ name: 'Ana' }), storage.updateProfile({ libraryView: 'list' })]);
    return { id: book.id, collectionId: collection.id };
  })()`)
  await command("Page.reload", { ignoreCache: true })
  await delay(1000)

  // Segunda sesión: valida persistencia, relaciones y borrado en cascada lógico.
  const second = await evaluate(`(async () => {
    const storage = await import('/src/storage.ts');
    const assert = (condition, message) => { if (!condition) throw new Error(message) };
    const id = ${JSON.stringify(first.id)};
    const collectionId = ${JSON.stringify(first.collectionId)};
    const book = (await storage.listBooks()).find((value) => value.id === id);
    assert(book?.title === 'Otro nombre', 'title was not persisted');
    assert(book?.coverDataUrl?.startsWith('data:image/png;base64,'), 'cover was not persisted');
    assert(book?.settings.theme === 'dark', 'settings were not persisted');
    assert(book?.progress?.percent === 37, 'progress was not persisted');
    assert(book?.lastOpenedAt, 'last-opened timestamp was not persisted');
    const profile = await storage.getProfile();
    assert(profile.name === 'Ana' && profile.libraryView === 'list', 'concurrent profile preferences were not persisted');
    assert((await storage.listCollections()).find((value) => value.id === collectionId)?.bookIds.includes(id), 'collection was not persisted');
    await storage.removeBook(id);
    assert(!(await storage.listBooks()).some((value) => value.id === id), 'book was not removed');
    assert(!(await storage.listCollections()).find((value) => value.id === collectionId)?.bookIds.includes(id), 'collection reference was not removed');
    await storage.deleteCollection(collectionId);
    return { persisted: true, removed: true };
  })()`)
  console.log(JSON.stringify({ first, second }))
} finally {
  // El perfil contiene datos de prueba: siempre se cierra Edge antes de borrarlo.
  socket?.close()
  browser.kill()
  await delay(200)
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  })
}
