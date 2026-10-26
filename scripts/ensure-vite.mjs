import { spawn } from "node:child_process"
import path from "node:path"

/**
 * Adaptador de arranque para `beforeDevCommand` de Tauri.
 *
 * Reutiliza el Vite que Figma Make mantiene en el puerto 8443 solo si responde
 * con esta aplicación. En un checkout normal inicia el Vite local y reenvía las
 * señales de cierre para no dejar procesos huérfanos.
 */
const url = "http://127.0.0.1:8443/"
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
  const source = await fetch(new URL("/src/storage.ts", url), {
    signal: AbortSignal.timeout(1500),
  })
  if (
    response.ok &&
    (await response.text()).includes("/src/main.tsx") &&
    source.ok &&
    (await source.text()).includes("nubooks-library")
  ) {
    console.log(`Using existing Vite server at ${url}`)
    process.exit(0)
  }
  throw new Error(`Port 8443 is occupied by another application: ${url}`)
} catch (error) {
  if (error instanceof Error && error.message.includes("occupied")) throw error
}

// No hay servidor compatible: se inicia el ejecutable Vite instalado localmente.
const vite = path.resolve("node_modules/vite/bin/vite.js")
const child = spawn(process.execPath, [vite, "--port", "8443"], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, PORT: "8443" },
})
child.on("error", (error) => {
  console.error("Could not start Vite:", error)
  process.exitCode = 1
})
child.on("exit", (code) => {
  process.exitCode = code ?? 1
})

// Tauri controla la vida de este script; las señales se propagan al hijo real.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}
