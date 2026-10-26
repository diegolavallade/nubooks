import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Prueba end-to-end de la biblioteca completa en el preview web.
 *
 * Importa dos EPUB reales, avanza una lectura, cambia ajustes, edita el perfil,
 * crea una colección, exporta y elimina. Todo se controla por CDP sobre un perfil
 * temporal de Edge. Ejecutar con `node scripts/library-smoke.mjs` mientras Vite
 * ya está disponible en el puerto 8443.
 */
const firstPath = path.resolve(
  "ebooks/Bunge, Mario - Filosofia para medicos (r1.0).epub",
)
const secondPath = path.resolve("ebooks/ebook.epub")
const browserPath =
  process.env.EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const profile = await mkdtemp(path.join(tmpdir(), "nubooks-library-smoke-"))
const browser = spawn(
  browserPath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,900",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
const exceptions = []
const result = {}

/** Espera a que Edge publique el puerto aleatorio de depuración. */
async function debugPort() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return Number(
        (
          await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
        ).split("\n")[0],
      )
    } catch {
      await delay(200)
    }
  }
  throw new Error("Edge did not open its debugging port")
}

try {
  // Conexión CDP y registro de excepciones que ocurran dentro de la página.
  const port = await debugPort()
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()
  const page = targets.find((target) => target.type === "page")
  if (!page) throw new Error("Edge did not create a page")
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const pending = new Map()
  let nextId = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(
        message.params?.exceptionDetails?.exception?.description ||
          message.params?.exceptionDetails?.text ||
          "Unknown exception",
      )
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error
      ? reject(new Error(message.error.message))
      : resolve(message.result)
  }

  /** Envía un comando CDP y evita que una respuesta perdida bloquee la prueba. */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 15000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })

  /** Evalúa una expresión en la página devolviendo valores serializables. */
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails)
      throw new Error(
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text,
      )
    return response.result.value
  }

  /** Repite una condición de UI/almacenamiento hasta cumplirla o agotar intentos. */
  const waitFor = async (predicate, label, attempts = 100) => {
    let value
    for (let attempt = 0; attempt < attempts; attempt++) {
      value = await predicate()
      if (value) return value
      await delay(250)
    }
    throw new Error(
      `${label} timed out; last=${JSON.stringify(value)}; text=${JSON.stringify(await evaluate('document.querySelector("#root")?.innerText?.slice(0,400)'))}`,
    )
  }

  // Utilidades de interacción que concentran los detalles de CDP y del DOM.
  const click = (expression) =>
    evaluate(
      `(() => { const element = ${expression}; if (!element) return false; element.click(); return true })()`,
    )
  const setInput = (selector, value) =>
    evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  const catalog = () =>
    evaluate(`new Promise((resolve, reject) => {
    const opening = indexedDB.open('nubooks-library');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction(['books', 'collections', 'meta'], 'readonly');
      const requests = ['books', 'collections', 'meta'].map(name => tx.objectStore(name).getAll());
      tx.oncomplete = () => resolve({ books: requests[0].result, collections: requests[1].result, meta: requests[2].result });
      tx.onerror = () => reject(tx.error);
    };
  })`)
  const waitLibrary = () =>
    waitFor(
      () =>
        evaluate(
          'Boolean(document.querySelector(".library-section") && !document.querySelector(".reader-shell"))',
        ),
      "Library",
    )
  const waitReader = () =>
    waitFor(
      () =>
        evaluate(
          'Boolean(document.querySelector(".reader-shell .epub-viewport iframe")?.contentDocument?.body?.innerHTML?.length)',
        ),
      "Reader",
    )
  const closeReader = async () => {
    if (
      !(await click(
        `document.querySelector('[aria-label="Volver a la biblioteca"]')`,
      ))
    )
      throw new Error("Reader close button missing")
    await waitLibrary()
  }
  const importFile = async (filename) => {
    const { root } = await send("DOM.getDocument")
    const { nodeId } = await send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "input[type=file]",
    })
    if (!nodeId) throw new Error("EPUB file input missing")
    await send("DOM.setFileInputFiles", { nodeId, files: [filename] })
    await waitReader()
  }
  const openCardMenu = async (title) => {
    const found = await click(
      `[...document.querySelectorAll('article.book-card')].find(card => card.querySelector('h3')?.textContent?.trim() === ${JSON.stringify(title)})?.querySelector('.library-ui-more')`,
    )
    if (!found) throw new Error(`Menu trigger missing for ${title}`)
    await waitFor(
      () => evaluate('Boolean(document.querySelector("[role=menu]"))'),
      "Book menu",
    )
  }
  const clickMenu = async (label) => {
    if (
      !(await click(
        `[...document.querySelectorAll('[role=menu] button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`,
      ))
    )
      throw new Error(`Menu action ${label} missing`)
  }

  // 1. Importación, navegación, tema y persistencia del primer libro.
  await send("Runtime.enable")
  await send("Page.enable")
  await send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: profile,
  })
  await send("Page.navigate", { url: "http://127.0.0.1:8443/" })
  await waitLibrary()
  await importFile(firstPath)
  const firstTitle = await evaluate(
    'document.querySelector(".reader-book-title")?.textContent?.trim()',
  )
  const firstStart = await evaluate(
    'document.querySelector(".reader-footer")?.textContent?.trim()',
  )
  await click(`document.querySelector('[aria-label="Página siguiente"]')`)
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('.reader-footer')?.textContent?.trim() !== ${JSON.stringify(firstStart)}`,
      ),
    "Page advance",
  )
  const firstResumeFooter = await evaluate(
    'document.querySelector(".reader-footer")?.textContent?.trim()',
  )
  await click(
    `document.querySelector('[aria-label="Temas y configuraciones"]')`,
  )
  await click(
    `[...document.querySelectorAll('.reader-settings button')].find(button => button.textContent.trim() === 'Oscuro')`,
  )
  if (
    !(await evaluate(
      'document.querySelector(".reader-shell")?.classList.contains("theme-dark")',
    ))
  )
    throw new Error("Dark theme did not apply")
  await closeReader()
  let snapshot = await catalog()
  const first = snapshot.books.find((book) => book.title === firstTitle)
  if (!first?.progress?.cfi || first.settings.theme !== "dark")
    throw new Error("First book progress/theme did not persist in IndexedDB")
  const firstCfi = first.progress.cfi
  result.firstBook = {
    title: first.title,
    percent: first.progress.percent,
    dark: true,
    cover: Boolean(first.coverDataUrl),
  }

  // 2. Aislamiento de preferencias y orden de “Continúa leyendo”.
  await importFile(secondPath)
  const secondTitle = await evaluate(
    'document.querySelector(".reader-book-title")?.textContent?.trim()',
  )
  if (
    !(await evaluate(
      'document.querySelector(".reader-shell")?.classList.contains("theme-light")',
    ))
  )
    throw new Error("Second book inherited first book theme")
  await closeReader()
  snapshot = await catalog()
  const second = snapshot.books.find((book) => book.title === secondTitle)
  if (!second || snapshot.books.length !== 2)
    throw new Error("Second book was not stored")
  result.secondBook = {
    title: second.title,
    light: true,
    cover: Boolean(second.coverDataUrl),
  }
  if (
    !(await evaluate(
      `document.querySelector('.continue-card h3')?.textContent?.trim() === ${JSON.stringify(secondTitle)}`,
    ))
  )
    throw new Error(
      "Continue Reading did not switch to most recently opened book",
    )

  // 3. Perfil, colección, portadas y conservación después de recargar.
  await click(
    `document.querySelector('[aria-label="Abrir preferencias de perfil"]')`,
  )
  await waitFor(
    () => evaluate('Boolean(document.querySelector(".profile-dialog[open]"))'),
    "Profile dialog",
  )
  await setInput("#profile-name", "Lucía QA")
  await click(
    `[...document.querySelectorAll('.profile-dialog button')].find(button => button.textContent.trim() === 'Guardar')`,
  )
  await waitFor(
    () => evaluate('!document.querySelector(".profile-dialog[open]")'),
    "Profile save",
  )
  await click(
    `[...document.querySelectorAll('button')].find(button => button.textContent.includes('Nueva colección'))`,
  )
  await setInput("#collection-name", "Favoritos QA")
  await click(
    `[...document.querySelectorAll('.library-ui-create-form button')].find(button => button.textContent.trim() === 'Crear')`,
  )
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll(".library-ui-collection strong")].some(element => element.textContent === "Favoritos QA")',
      ),
    "Collection create",
  )
  await openCardMenu(firstTitle)
  await clickMenu("Agregar a una colección")
  await click(
    `[...document.querySelectorAll('[role=menuitemcheckbox]')].find(button => button.textContent.includes('Favoritos QA'))`,
  )
  await waitFor(
    async () => (await catalog()).collections[0]?.bookIds?.includes(first.id),
    "Collection membership",
  )
  await send("Page.reload", { ignoreCache: true })
  await waitLibrary()
  if (
    !(await evaluate(
      'document.querySelector(".hero h1")?.textContent?.includes("Lucía QA")',
    ))
  )
    throw new Error("Profile greeting was lost on reload")
  if (
    !(await evaluate(
      `document.querySelector('.continue-card h3')?.textContent?.trim() === ${JSON.stringify(secondTitle)}`,
    ))
  )
    throw new Error("Continue Reading was lost on reload")
  snapshot = await catalog()
  if (
    snapshot.books.length !== 2 ||
    snapshot.collections[0]?.bookIds[0] !== first.id
  )
    throw new Error("Library or collection lost on reload")
  if (
    !snapshot.books.every((book) =>
      book.coverDataUrl?.startsWith("data:image/"),
    )
  )
    throw new Error(
      "Cover was not persisted as an image data URL for both books",
    )
  if (
    (await evaluate(
      `document.querySelectorAll('article.book-card .library-ui-cover img[src^="data:image/"]').length`,
    )) !== 2
  )
    throw new Error("Both persisted cover images did not render after reload")
  result.reload = {
    profile: true,
    continueReading: true,
    collection: true,
    covers: 2,
  }

  // 4. Restauración exacta de CFI y preferencias al reabrir.
  const opened = await click(
    `[...document.querySelectorAll('article.book-card')].find(card => card.querySelector('h3')?.textContent?.trim() === ${JSON.stringify(firstTitle)})?.querySelector('.library-ui-book-open')`,
  )
  if (!opened) throw new Error("First book card not found after reload")
  await waitReader()
  if (
    !(await evaluate(
      'document.querySelector(".reader-shell")?.classList.contains("theme-dark")',
    ))
  )
    throw new Error("First book theme was lost after reload")
  await waitFor(
    () =>
      evaluate(
        `document.querySelector('.reader-footer')?.textContent?.trim() === ${JSON.stringify(firstResumeFooter)}`,
      ),
    "Restored page",
  )
  await closeReader()
  snapshot = await catalog()
  if (
    snapshot.books.find((book) => book.id === first.id)?.progress?.cfi !==
    firstCfi
  )
    throw new Error("First book CFI changed when resuming without navigation")
  if (
    !(await evaluate(
      `document.querySelector('.continue-card h3')?.textContent?.trim() === ${JSON.stringify(firstTitle)}`,
    ))
  )
    throw new Error("Continue Reading did not reflect the reopened book")
  result.reopen = {
    dark: true,
    restoredPage: firstResumeFooter,
    exactCfi: true,
    continueReading: true,
  }

  // 5. Renombrado y exportación byte a byte idéntica al original.
  await openCardMenu(firstTitle)
  await clickMenu("Renombrar")
  await waitFor(
    () =>
      evaluate('Boolean(document.querySelector(".library-ui-dialog[open]"))'),
    "Rename dialog",
  )
  await setInput(".library-ui-dialog input", "Filosofía QA")
  await click(
    `[...document.querySelectorAll('.library-ui-dialog button')].find(button => button.textContent.trim() === 'Guardar nombre')`,
  )
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("article.book-card h3")].some(element => element.textContent === "Filosofía QA")',
      ),
    "Rename save",
  )
  await openCardMenu("Filosofía QA")
  await clickMenu("Compartir o exportar")
  const download = await waitFor(
    async () =>
      (await readdir(profile)).find((name) =>
        name.toLowerCase().endsWith(".epub"),
      ),
    "Export download",
    120,
  )
  const originalHash = createHash("sha256")
    .update(await readFile(firstPath))
    .digest("hex")
  const exportedHash = createHash("sha256")
    .update(await readFile(path.join(profile, download)))
    .digest("hex")
  if (originalHash !== exportedHash)
    throw new Error("Exported EPUB bytes differ from imported file")
  result.export = { fileName: download, sameBytes: true }

  // 6. Eliminación del libro y limpieza de su referencia en la colección.
  await openCardMenu("Filosofía QA")
  await clickMenu("Eliminar de la biblioteca")
  await waitFor(
    () =>
      evaluate('Boolean(document.querySelector(".library-ui-dialog[open]"))'),
    "Remove dialog",
  )
  await click(
    `[...document.querySelectorAll('.library-ui-dialog button')].find(button => button.textContent.trim() === 'Eliminar libro')`,
  )
  await waitFor(async () => (await catalog()).books.length === 1, "Remove book")
  await send("Page.reload", { ignoreCache: true })
  await waitLibrary()
  snapshot = await catalog()
  if (
    snapshot.books.length !== 1 ||
    snapshot.collections[0]?.bookIds.length !== 0
  )
    throw new Error("Removal did not delete book or collection membership")
  if (
    (await evaluate(
      'document.querySelector("article.book-card h3")?.textContent?.trim()',
    )) !== secondTitle
  )
    throw new Error("Removed book still appears in library")
  result.remove = {
    bookCount: snapshot.books.length,
    collectionBookCount: snapshot.collections[0].bookIds.length,
  }
  if (exceptions.length)
    throw new Error(
      `Browser exceptions: ${JSON.stringify(exceptions.slice(-3))}`,
    )
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  if (exceptions.length)
    console.error(
      "Browser exceptions:",
      JSON.stringify(exceptions.slice(-5), null, 2),
    )
  throw error
} finally {
  // La condición de prefijo impide borrar accidentalmente un directorio ajeno.
  socket?.close()
  browser.kill()
  if (
    profile.startsWith(tmpdir() + path.sep) &&
    path.basename(profile).startsWith("nubooks-library-smoke-")
  ) {
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  }
}
