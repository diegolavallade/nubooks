# Nubooks

Lector y biblioteca de EPUB construido con React 19, TypeScript y Tailwind CSS 4.
Funciona en el navegador y como aplicación de escritorio con Tauri 2 (Rust).

Versión inicial del repositorio: **0.1.1**.

## Desarrollo

Requisitos: Node.js 22 y pnpm 10.34.3 (versiones declaradas en `.mise.toml`).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

La aplicación se sirve en `http://localhost:8443`. Si el servidor ya está activo,
utiliza esa instancia. La configuración `.figma/make/site.json` se incluye porque
Vite la importa para generar los metadatos del sitio.

## Compilación y comprobaciones

```sh
pnpm exec tsc --noEmit
pnpm build
pnpm preview
```

Con Vite activo y Microsoft Edge instalado puedes comprobar la persistencia:

```sh
node scripts/storage-smoke.mjs
```

Las pruebas `epub-smoke.mjs` y `library-smoke.mjs` requieren EPUB locales.
Consulta sus comentarios de uso; los libros no se distribuyen en este repositorio.

## Aplicación de escritorio

Instala Rust y los requisitos de Tauri de tu sistema. En Windows se necesitan
las herramientas de compilación de Visual Studio con C++ y Windows SDK.

```sh
pnpm desktop:dev
pnpm desktop:build
```

El modo de desarrollo reutiliza Vite en el puerto 8443 o lo inicia si hace falta.
Los instaladores se generan dentro de `src-tauri/target/release/bundle/`.

## Estructura y almacenamiento

- `src/`: interfaz, lector EPUB y adaptador de almacenamiento.
- `src-tauri/`: aplicación nativa y persistencia en Rust.
- `scripts/`: herramientas de desarrollo y pruebas de humo.
- `DOCUMENTACION.md`: arquitectura y comportamiento detallados.
- `src-tauri/README.md`: almacenamiento nativo y recuperación de datos.

En el navegador los libros se guardan en IndexedDB. En escritorio se utiliza el
directorio de datos de la aplicación. La biblioteca personal, los secretos,
dependencias y compilaciones están excluidos mediante `.gitignore`.

Los archivos `pnpm-lock.yaml` y `src-tauri/Cargo.lock` se versionan para reproducir
las dependencias. La rama principal es `main` y la primera versión se identifica
con la etiqueta `v0.1.1`.

## Licencia

MIT. Permite usar, modificar y redistribuir el proyecto, incluso comercialmente,
conservando el aviso de copyright y la licencia. Consulta [LICENSE](LICENSE).
