// Fachada estable del lector: permite cambiar su implementación interna sin
// obligar a los consumidores a actualizar sus importaciones.
export { default } from "./ReliableEpubReader"
export type { ImportedBook } from "./ReliableEpubReader"
