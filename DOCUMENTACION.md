# Nubooks: guía de arquitectura y mantenimiento

Nubooks es un lector de EPUB que funciona tanto como aplicación de escritorio
Tauri como dentro del preview web de Vite/Figma Make. El mismo frontend React
se ejecuta en ambos casos; únicamente cambia la implementación de persistencia.

## Mapa del proyecto

| Área | Archivo o carpeta | Responsabilidad |
| --- | --- | --- |
| Arranque web | `src/main.tsx` | Monta React y carga los estilos globales. |
| Orquestación | `src/App.tsx` | Carga biblioteca, importa archivos, serializa guardados y abre/cierra el lector. |
| Biblioteca | `src/components/LibraryUI.tsx` | Componentes visuales sin dependencia de Tauri o IndexedDB. |
| Lector | `src/ReliableEpubReader.tsx` | Integra epub.js, navegación, índice, preferencias, recuperación y progreso. |
| Metadatos | `src/epubMetadata.ts` | Obtiene título, autor y convierte portadas a data URLs reducidas. |
| Ciclo EPUB | `src/epubLifecycle.ts` | Evita destruir epub.js mientras procesa recursos asíncronos. |
| Persistencia | `src/storage.ts` | API común para Tauri e IndexedDB. |
| Backend nativo | `src-tauri/src/lib.rs` | Comandos IPC, archivos binarios, índice JSON y recuperación. |
| Pruebas de humo | `scripts/*.mjs` | Automatización CDP con Edge y un perfil temporal. |
| Build | `vite.config.ts`, `src-tauri/tauri.conf.json` | Vite/Figma Make y empaquetado Tauri. |

## Flujo principal

```text
Selección de .epub
        |
        v
App valida firma ZIP y extrae metadatos/portada
        |
        v
storage.importBook(file, metadata)
   | navegador                    | escritorio
   v                              v
IndexedDB (registro + Blob)       comando Tauri -> EPUB en disco + library.json
        |                              |
        +------------ misma API -------+
                       |
                       v
App abre bytes del EPUB -> ReliableEpubReader -> eventos de progreso
                       |
                       v
App agrupa escrituras (500 ms) -> storage.updateBookState
```

## Persistencia y datos

### Identidad e importación

- El identificador de un libro es el SHA-256 de sus bytes.
- Importar de nuevo el mismo archivo es idempotente: conserva progreso, ajustes
  y colecciones existentes.
- Se acepta un archivo `.epub` de hasta 200 MB cuya cabecera comience por la
  firma ZIP `PK\x03\x04`. Esta comprobación es rápida; epub.js hace después la
  interpretación real del contenido.

### Navegador

La base `nubooks-library` de IndexedDB tiene cuatro almacenes:

| Store | Clave | Contenido |
| --- | --- | --- |
| `books` | `id` | Metadatos, portada, progreso, ajustes y marcadores. |
| `files` | `id` | Blob binario del EPUB. |
| `collections` | `id` | Colecciones y sus IDs de libro. |
| `meta` | `profile` | Nombre del perfil y modo de vista. |

Las mutaciones que afectan a varias entidades usan una transacción `readwrite`.
Al borrar un libro también se retira su ID de todas las colecciones.

### Escritorio

Tauri guarda los datos bajo su directorio de datos de aplicación:

```text
<app-data>/
  library.json          índice actual
  library.json.bak      última copia completa anterior
  books/<sha256>.epub   binarios importados
  covers/<sha256>-<uuid>.cover
```

El backend escribe primero archivos temporales sincronizados con disco y luego
los renombra. La actualización de `library.json` conserva un respaldo para
recuperar cortes entre operaciones, particularmente en Windows. Las
eliminaciones pasan antes por `*.pending-delete`: si no se pudo confirmar el
índice, el archivo puede restaurarse. No se borran binarios completos sin una
marca explícita, pues un respaldo puede ser anterior a ellos.

## Lector EPUB

`ReliableEpubReader` separa la sesión React de `EpubCanvas`, el adaptador
imperativo de epub.js. Esto es importante porque epub.js crea iframes y mantiene
una cola asíncrona propia.

- Las preferencias de fuente, tema, columnas y justificación se inyectan en la
  rendition, dentro del documento EPUB.
- El modo continuo reconstruye la rendition porque cambia el flujo de epub.js;
  los cambios estrictamente visuales se aplican sin reconstruirla.
- La navegación normalizada funciona con botones, teclado, rueda y gestos.
- Los enlaces del índice se validan contra el spine; los externos no se abren.
- El progreso usa ubicaciones CFI exactas si están disponibles. De otro modo
  estima posiciones con el tamaño de cada sección, dejando claro que es una
  aproximación.
- Ante errores de display intenta recuperar hasta dos veces la última posición
  legible y después ofrece reintentar desde el inicio.

La aplicación padre conserva una cola de escrituras y agrupa los eventos de
progreso por 500 ms. También vacía esa cola al cerrar el lector o cuando el
documento se oculta para reducir pérdidas del último avance.

## Seguridad y límites

- El frontend no entrega rutas de sistema al backend; usa IDs validados.
- El backend valida el hash SHA-256, UUID de portada, límites de tamaño, MIME y
  data URLs antes de tocar el disco.
- Exportar en escritorio abre un diálogo nativo: la WebView no controla el
  destino.
- Las portadas se reducen a un máximo de 900 px por lado y 2 MB durante la
  extracción; la capa de almacenamiento permite como máximo 3 MB codificados.
- Los textos introducidos por usuarios se limpian de caracteres de control y se
  acotan en longitud.

## Desarrollo, build y verificación

El servidor de Vite del entorno ya se encuentra en ejecución. Los comandos
definidos en `package.json` son:

```bash
pnpm build           # Comprueba TypeScript implícitamente y genera dist/
pnpm format          # Formatea archivos compatibles con oxfmt
pnpm desktop:dev     # Inicia Tauri y reutiliza Vite o lo arranca
pnpm desktop:build   # Empaqueta la aplicación de escritorio
```

Las pruebas de humo requieren Edge y Vite en el puerto 8443:

```bash
node scripts/storage-smoke.mjs
node scripts/library-smoke.mjs
node scripts/epub-smoke.mjs ebooks/ebook.epub
```

Cada script crea y elimina un perfil temporal de Edge. `storage-smoke` valida
la API IndexedDB; `library-smoke` recorre el flujo de la interfaz; y
`epub-smoke` estresa los métodos de navegación y las preferencias del lector.

## Convenciones para cambios futuros

- Mantener paridad entre `src/storage.ts` y los comandos de `src-tauri/src/lib.rs`.
- Tratar los binarios EPUB como datos de gran tamaño: cargarlos solo para abrir,
  importar o exportar, nunca en el estado general de React.
- Todo efecto que registre listeners de epub.js, `window` o `document` debe
  retirar esos listeners al desmontarse.
- Preferir comentarios que expliquen una restricción, una garantía o una
  decisión; los nombres y JSX evidentes deben seguir siendo concisos.
- Los JSON de configuración no llevan comentarios porque JSON no los admite;
  esta guía describe su papel y los comentarios de `vite.config.ts` cubren los
  plugins que sí contienen lógica.
