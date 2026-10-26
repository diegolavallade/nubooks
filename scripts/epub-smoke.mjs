import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Prueba de humo especializada en el lector EPUB.
 *
 * Cubre índice, botones, teclado, rueda, gestos táctiles, temas, columnas,
 * justificación, flujo continuo, restauración a modo paginado y contador de
 * progreso. Puede guardar evidencia con `--screenshots=<directorio>`.
 * Uso: `node scripts/epub-smoke.mjs ebooks/ebook.epub`, con Vite ya iniciado.
 */
const epubPath = path.resolve(process.argv[2] || "ebooks/ebook.epub")
const screenshotDir = process.argv
  .find((arg) => arg.startsWith("--screenshots="))
  ?.slice("--screenshots=".length)
const browserPath =
  process.env.EDGE_PATH ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
const profile = await mkdtemp(path.join(tmpdir(), "nubooks-epub-smoke-"))
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
const browserExceptions = []

/** Espera el puerto CDP elegido automáticamente por Edge. */
async function port() {
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
  // Prepara el transporte CDP y captura excepciones no controladas del navegador.
  const debugPort = await port()
  const targets = await (
    await fetch(`http://127.0.0.1:${debugPort}/json/list`)
  ).json()
  const page = targets.find((target) => target.type === "page")
  if (!page) throw new Error("Edge did not create a page")
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let nextId = 0
  const pending = new Map()
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === "Runtime.exceptionThrown") {
      browserExceptions.push(
        message.params?.exceptionDetails?.exception?.description ||
          message.params?.exceptionDetails?.text ||
          "Unknown browser exception",
      )
    }
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error
      ? reject(new Error(message.error.message))
      : resolve(message.result)
  }

  /** Envía un comando CDP con timeout para mantener la prueba acotada. */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 10000)
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
  await send("Runtime.enable")
  await send("Page.enable")

  /** Guarda una captura opcional con un nombre derivado del EPUB probado. */
  const screenshot = async (suffix) => {
    if (!screenshotDir) return
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })
    const filename = `${path.basename(epubPath).replace(/[^a-z\d_-]+/gi, "_")}-${suffix}.png`
    await writeFile(
      path.join(screenshotDir, filename),
      Buffer.from(data, "base64"),
    )
  }

  /** Ejecuta JavaScript dentro de la página y devuelve su resultado por valor. */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }

  /** Toma una instantánea compacta del DOM y de los iframes del libro. */
  const state = () =>
    evaluate(`(() => {
    const viewport = document.querySelector('.epub-viewport');
    const frames = [...(viewport?.querySelectorAll('iframe') || [])];
    const contents = frames.map(frame => ({
      text: frame.contentDocument?.body?.innerText?.trim() || '',
      images: frame.contentDocument?.querySelectorAll('img, svg image')?.length || 0,
      html: frame.contentDocument?.body?.innerHTML?.length || 0,
      scrollTop: frame.contentDocument?.documentElement?.scrollTop || frame.contentDocument?.body?.scrollTop || 0,
    }));
    const scroller = viewport?.querySelector('.epub-container');
    const stored = Object.keys(localStorage).filter(key => key.startsWith('nubooks:position:')).map(key => localStorage.getItem(key));
    return {
      url: location.href,
      rootText: document.querySelector('#root')?.innerText?.slice(0, 300) || '',
      viewportHtml: viewport?.innerHTML?.slice(0, 500) || '',
      viewportWidth: viewport?.clientWidth || 0,
      viewportHeight: viewport?.clientHeight || 0,
      error: document.querySelector('.epub-error, .import-error, .epub-reader-alert')?.textContent?.trim() || '',
      loading: Boolean(document.querySelector('.epub-message:not(.epub-error)')),
      frames: frames.length,
      text: contents.map(item => item.text).join(' ').slice(0, 300),
      images: contents.reduce((sum, item) => sum + item.images, 0),
      html: contents.reduce((sum, item) => sum + item.html, 0),
      scrollLeft: scroller?.scrollLeft || 0,
      scrollTop: scroller?.scrollTop || 0,
      iframeScrollTop: contents.reduce((sum, item) => sum + item.scrollTop, 0),
      scrollHeight: scroller?.scrollHeight || 0,
      clientHeight: scroller?.clientHeight || 0,
      footer: document.querySelector('.reader-footer')?.textContent?.trim() || '',
      cfi: stored[0] || '',
      pageControls: document.querySelectorAll('.page-control').length,
    };
  })()`)

  // Define cuándo hay contenido útil y una firma capaz de detectar movimiento
  // entre EPUB paginados, continuos o con posiciones guardadas de distinta forma.
  const readable = (value) =>
    !value.loading &&
    value.frames > 0 &&
    value.html > 0 &&
    (value.text.length > 0 || value.images > 0)
  const position = (value) =>
    JSON.stringify([
      value.cfi,
      value.scrollLeft,
      value.scrollTop,
      value.footer,
      value.text,
    ])
  const waitFor = async (predicate, message) => {
    let last
    for (let attempt = 0; attempt < 80; attempt++) {
      last = await state()
      if (last.error) throw new Error(last.error)
      if (predicate(last)) return last
      await delay(250)
    }
    throw new Error(`${message}; state=${JSON.stringify(last)}`)
  }
  const assertReadable = (message) => waitFor(readable, message)

  /** Exige que el contenido permanezca legible 2,5 s, no solo un instante. */
  const assertStableReadable = async (message) => {
    let last
    let stableSince = 0
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      last = await state()
      if (last.error) throw new Error(last.error)
      if (readable(last)) {
        if (!stableSince) stableSince = Date.now()
        if (Date.now() - stableSince >= 2500) return last
      } else {
        stableSince = 0
      }
      await delay(250)
    }
    throw new Error(`${message}; state=${JSON.stringify(last)}`)
  }
  const assertMoved = (before, message) =>
    waitFor(
      (after) => readable(after) && position(after) !== position(before),
      message,
    )
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
  const clickSetting = (label) =>
    evaluate(
      `Array.from(document.querySelectorAll('.reader-settings button')).find(button => button.textContent.trim() === ${JSON.stringify(label)})?.click()`,
    )

  // Importa el archivo mediante el control real de la aplicación.
  await send("Page.navigate", { url: "http://127.0.0.1:8443/" })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate('Boolean(document.querySelector("input[type=file]"))'))
      break
    await delay(250)
  }
  const { root } = await send("DOM.getDocument")
  const { nodeId } = await send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "input[type=file]",
  })
  if (!nodeId) throw new Error("EPUB import control was not found")
  await send("DOM.setFileInputFiles", { nodeId, files: [epubPath] })
  await assertReadable("EPUB never rendered readable content")

  // Índice y navegación directa a un capítulo.
  const beforeToc = await state()
  await click('[aria-label="Índice de capítulos"]')
  const chapterCount = await evaluate(
    'document.querySelectorAll(".toc-entry").length',
  )
  if (!chapterCount) throw new Error("The book did not provide a chapter index")
  const isAsimov = path.basename(epubPath).includes("Asimov")
  const clicked = await evaluate(`(() => {
    const entries = [...document.querySelectorAll('.toc-entry')];
    const entry = ${
      isAsimov
        ? `entries.find(item => item.textContent.trim() === 'Matemático')`
        : `entries.find(item => /cap[ií]tulo|chapter|introducci[oó]n|prefacio/i.test(item.textContent)) || entries[Math.min(2, entries.length - 1)]`
    };
    if (!entry) return '';
    const label = entry.textContent.trim();
    entry.click();
    return label;
  })()`)
  if (!clicked) throw new Error("Could not select a chapter in the index")
  const chapter = await waitFor(
    (value) =>
      readable(value) &&
      (isAsimov
        ? value.text.toLocaleLowerCase().includes("matemático")
        : clicked === "Start" || position(value) !== position(beforeToc)),
    `Chapter ${clicked} did not render`,
  )
  if (isAsimov && !chapter.text.toLocaleLowerCase().includes("matemático"))
    throw new Error("Asimov index opened a different chapter")

  // Botones de página, rueda temprana y gesto táctil.
  await delay(300)
  const beforeNext = await state()
  await click('[aria-label="Página siguiente"]')
  const afterNext = await assertMoved(
    beforeNext,
    "Next-page button did not change the reading position",
  )
  await click('[aria-label="Página anterior"]')
  await assertMoved(
    afterNext,
    "Previous-page button did not change the reading position",
  )

  const beforeEarlyWheel = await state()
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 600,
    y: 450,
    deltaX: 0,
    deltaY: 420,
  })
  await assertMoved(
    beforeEarlyWheel,
    "Early mouse wheel did not advance the page",
  )

  const beforeSwipe = await state()
  await evaluate(`(() => {
    const target = document.querySelector('.epub-viewport');
    const start = new Touch({ identifier: 1, target, clientX: 800, clientY: 430 });
    const end = new Touch({ identifier: 1, target, clientX: 200, clientY: 430 });
    target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, changedTouches: [start], touches: [start] }));
    target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [end], touches: [] }));
  })()`)
  await assertMoved(beforeSwipe, "Touch swipe did not advance the page")

  // Preferencias visuales y transición entre flujo paginado y continuo.
  await click('[aria-label="Temas y configuraciones"]')
  const settingsOpen = await evaluate(
    'Boolean(document.querySelector(".reader-settings"))',
  )
  if (!settingsOpen) throw new Error("Reader settings did not open")
  await screenshot("settings")
  const animations = await evaluate(
    `['Deslizamiento', 'Ondulación', 'Fundido rápido', 'Desplazamiento continuo'].every(label => [...document.querySelectorAll('.reader-settings button')].some(button => button.textContent.trim() === label))`,
  )
  if (!animations)
    throw new Error(
      "Reader is missing the four animation options shown in sample books",
    )
  await clickSetting("Oscuro")
  if (
    !(await evaluate(
      'document.querySelector(".reader-shell")?.classList.contains("theme-dark")',
    ))
  )
    throw new Error("Dark theme did not apply")
  await assertStableReadable("Changing theme left the reader blank")
  await evaluate(
    'document.querySelector(".font-controls button:last-child")?.click()',
  )
  if (
    !(await evaluate(
      'document.querySelector(".font-controls button:last-child")?.classList.contains("active")',
    ))
  )
    throw new Error("Large font size did not apply")
  await assertStableReadable("Changing font size left the reader blank")
  await clickSetting("2")
  await assertStableReadable("Changing to two columns left the reader blank")
  await click(".reader-settings .switch")
  if (
    !(await evaluate(
      'document.querySelector(".reader-settings .switch")?.getAttribute("aria-pressed") === "true"',
    ))
  )
    throw new Error("Justification did not apply")
  await assertStableReadable("Justifying text left the reader blank")
  await clickSetting("1")
  await assertStableReadable("Returning to one column left the reader blank")
  await clickSetting("Desplazamiento continuo")
  const beforeContinuousScroll = await assertStableReadable(
    "Continuous mode left the reader blank",
  )
  if ((await state()).pageControls !== 0)
    throw new Error("Continuous mode kept page controls")
  const canScroll =
    beforeContinuousScroll.scrollHeight >
    beforeContinuousScroll.clientHeight + 40
  if (!canScroll && isAsimov)
    throw new Error(
      `Continuous mode did not create a scrollable chapter: ${JSON.stringify(beforeContinuousScroll)}`,
    )
  let continuousScrolled = false
  if (canScroll) {
    const direction =
      beforeContinuousScroll.scrollHeight -
        beforeContinuousScroll.clientHeight -
        beforeContinuousScroll.scrollTop >
      40
        ? 1
        : -1
    await evaluate(
      `document.querySelector('.epub-viewport iframe')?.contentDocument?.body?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: ${420 * direction} }))`,
    )
    await waitFor(
      (value) =>
        readable(value) &&
        (Math.abs(value.scrollTop - beforeContinuousScroll.scrollTop) > 10 ||
          Math.abs(
            value.iframeScrollTop - beforeContinuousScroll.iframeScrollTop,
          ) > 10),
      "Wheel did not scroll continuous content",
    )
    continuousScrolled = true

    const beforeTouchScroll = await state()
    await evaluate(`(() => {
      const target = document.querySelector('.epub-viewport');
      const start = new Touch({ identifier: 2, target, clientX: 500, clientY: 540 });
      const end = new Touch({ identifier: 2, target, clientX: 500, clientY: 160 });
      target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, changedTouches: [start], touches: [start] }));
      target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [end], touches: [] }));
    })()`)
    await waitFor(
      (value) =>
        readable(value) && value.scrollTop > beforeTouchScroll.scrollTop + 10,
      "Touch swipe did not scroll continuous content",
    )
    if (isAsimov) {
      await evaluate(
        `(() => { const scroller = document.querySelector('.epub-container'); scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight })()`,
      )
      await delay(350)
      const beforeChapterBoundary = await state()
      await evaluate(
        `document.querySelector('.epub-viewport iframe')?.contentDocument?.body?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 420 }))`,
      )
      await waitFor(
        (value) => readable(value) && value.text !== beforeChapterBoundary.text,
        "Continuous wheel did not advance to the next chapter at the bottom",
      )
    }
  }
  await clickSetting("Deslizamiento")
  await assertStableReadable("Returning to page mode left the reader blank")
  if ((await state()).pageControls < 2)
    throw new Error("Page mode did not restore page controls")
  await click('[aria-label="Temas y configuraciones"]')

  const beforeKeyboard = await state()
  await evaluate('document.querySelector(".epub-viewport iframe")?.focus()')
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  })
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  })
  await assertMoved(beforeKeyboard, "ArrowRight did not advance the page")

  const beforeWheel = await state()
  await evaluate(
    `document.querySelector('.epub-viewport iframe')?.contentDocument?.body?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 420 }))`,
  )
  await assertMoved(beforeWheel, "Mouse wheel did not advance the page")

  await delay(700)
  const edge = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.page-control')].find(item => !item.disabled);
    if (!button) return null;
    const bounds = button.getBoundingClientRect();
    return { label: button.getAttribute('aria-label'), x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`)
  if (!edge) throw new Error("No enabled page-edge control was available")
  const beforeEdge = await state()
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: edge.x,
    y: edge.y,
    button: "left",
    clickCount: 1,
  })
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: edge.x,
    y: edge.y,
    button: "left",
    clickCount: 1,
  })
  await assertMoved(
    beforeEdge,
    `${edge.label} did not respond to a physical edge click`,
  )

  // El pie debe terminar mostrando enteros coherentes de posición y total.
  const readFooter = () =>
    evaluate(`(() => {
    const element = document.querySelector('.reader-footer');
    const numbers = [...(element?.querySelectorAll('span') || [])].map(item => Number(item.textContent.trim()));
    return { numbers, progress: Boolean(element?.querySelector('.page-line')) };
  })()`)
  let footer
  for (let attempt = 0; attempt < 180; attempt++) {
    footer = await readFooter()
    if (
      footer.progress &&
      footer.numbers.length >= 2 &&
      Number.isInteger(footer.numbers[0]) &&
      Number.isInteger(footer.numbers.at(-1)) &&
      footer.numbers[0] >= 1 &&
      footer.numbers.at(-1) >= footer.numbers[0]
    )
      break
    await delay(250)
  }
  if (
    !footer?.progress ||
    footer.numbers.length < 2 ||
    !Number.isInteger(footer.numbers[0]) ||
    !Number.isInteger(footer.numbers.at(-1)) ||
    footer.numbers[0] < 1 ||
    footer.numbers.at(-1) < footer.numbers[0]
  ) {
    throw new Error(
      `Footer did not show a valid page counter within 45 seconds: ${JSON.stringify(footer)}`,
    )
  }

  await screenshot("reader")

  console.log(
    JSON.stringify(
      {
        epub: path.basename(epubPath),
        rendered: true,
        chapters: chapterCount,
        selectedChapter: clicked,
        next: true,
        previous: true,
        keyboard: true,
        wheel: true,
        touch: true,
        edgeClick: edge.label,
        continuousScrolled,
        settings: true,
        footer,
      },
      null,
      2,
    ),
  )
} catch (error) {
  if (browserExceptions.length)
    console.error(
      "Browser exceptions:",
      JSON.stringify(browserExceptions.slice(-8), null, 2),
    )
  throw error
} finally {
  // Solo se elimina el perfil si conserva el prefijo temporal creado arriba.
  socket?.close()
  browser.kill()
  if (
    profile.startsWith(tmpdir() + path.sep) &&
    path.basename(profile).startsWith("nubooks-epub-smoke-")
  ) {
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  }
}
