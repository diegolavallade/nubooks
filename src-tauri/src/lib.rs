//! Backend nativo de Nubooks.
//!
//! Expone a la WebView una API Tauri equivalente a `src/storage.ts`. El índice
//! de la biblioteca se guarda como JSON con respaldo; los EPUB y las portadas
//! permanecen como archivos separados. Todas las rutas se derivan internamente
//! de identificadores validados para que el frontend nunca pueda elegir rutas
//! arbitrarias del equipo del usuario.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use std::{collections::HashSet, fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    AppHandle, Manager, State,
};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

const MAX_EPUB_BYTES: usize = 200 * 1024 * 1024;
const MAX_COVER_BYTES: usize = 3 * 1024 * 1024;

/// Mutex de proceso que serializa lecturas-modificaciones-escrituras del índice.
#[derive(Default)]
struct StoreLock(Mutex<()>);

/// Preferencias persistidas para un libro; usa camelCase al cruzar IPC.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReaderSettings {
    font_size: String,
    #[serde(default)]
    font_scale: Option<f64>,
    animation: String,
    theme: String,
    columns: String,
    justify: bool,
}

impl Default for ReaderSettings {
    fn default() -> Self {
        Self {
            font_size: "medium".into(),
            font_scale: None,
            animation: "slide".into(),
            theme: "light".into(),
            columns: "auto".into(),
            justify: false,
        }
    }
}

impl ReaderSettings {
    /// Rechaza valores inventados antes de escribirlos en el índice.
    fn valid(&self) -> bool {
        self.font_scale.is_none_or(|value| value.is_finite() && (70.0..=200.0).contains(&value))
            && ["small", "medium", "large"].contains(&self.font_size.as_str())
            && ["slide", "ripple", "fade", "continuous"].contains(&self.animation.as_str())
            && ["light", "dark"].contains(&self.theme.as_str())
            && ["1", "2", "auto"].contains(&self.columns.as_str())
    }
}

/// Posición y avance de lectura informados por epub.js.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookProgress {
    cfi: Option<String>,
    percent: f64,
    chapter: Option<String>,
    #[serde(default)]
    section: Option<u32>,
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    pages: Option<u32>,
    #[serde(default)]
    location: Option<u32>,
    #[serde(default)]
    total_locations: Option<u32>,
    updated_at: String,
}

/// Marcador dentro del EPUB, identificado por una posición CFI.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bookmark {
    id: String,
    cfi: String,
    label: String,
    created_at: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    chapter: Option<String>,
    #[serde(default)]
    percent: Option<f64>,
}

/// Metadatos completos de un libro; el binario y la portada viven aparte.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBook {
    id: String,
    title: String,
    author: String,
    file_name: String,
    #[serde(default)]
    cover_data_url: Option<String>,
    #[serde(default)]
    cover_mime: Option<String>,
    #[serde(default)]
    cover_key: Option<String>,
    added_at: String,
    #[serde(default)]
    last_opened_at: Option<String>,
    #[serde(default)]
    progress: Option<BookProgress>,
    #[serde(default)]
    settings: ReaderSettings,
    #[serde(default)]
    bookmarks: Vec<Bookmark>,
}

/// Parte del registro que puede consultar el lector sin recibir todo el catálogo.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookState {
    settings: ReaderSettings,
    progress: Option<BookProgress>,
    bookmarks: Vec<Bookmark>,
}

/// Actualización parcial del estado; distingue progreso ausente de progreso `null`.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookStatePatch {
    settings: Option<ReaderSettings>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    progress: Option<Option<BookProgress>>,
    bookmarks: Option<Vec<Bookmark>>,
}

/// Conserva la diferencia semántica entre “campo no enviado” y “borrar campo”.
fn deserialize_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

/// Preferencias generales de la biblioteca.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserProfile {
    name: String,
    library_view: String,
    #[serde(default = "default_true")]
    settings_per_book: bool,
    #[serde(default)]
    global_reader_settings: Option<ReaderSettings>,
}

fn default_true() -> bool { true }

impl Default for UserProfile {
    fn default() -> Self {
        Self {
            name: String::new(),
            library_view: "grid".into(),
            settings_per_book: true,
            global_reader_settings: None,
        }
    }
}

/// Campos opcionales aceptados al actualizar el perfil.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfilePatch {
    name: Option<String>,
    library_view: Option<String>,
    settings_per_book: Option<bool>,
    global_reader_settings: Option<ReaderSettings>,
}

/// Colección de referencias a libros existentes.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCollection {
    id: String,
    name: String,
    book_ids: Vec<String>,
    created_at: String,
    updated_at: String,
}

/// Documento raíz serializado en `library.json`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Database {
    version: u32,
    #[serde(default)]
    profile: UserProfile,
    #[serde(default)]
    books: Vec<StoredBook>,
    #[serde(default)]
    collections: Vec<StoredCollection>,
}

impl Default for Database {
    fn default() -> Self {
        Self {
            version: 1,
            profile: UserProfile::default(),
            books: vec![],
            collections: vec![],
        }
    }
}

/// Metadatos enviados en base64 junto al cuerpo binario de una importación.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadMetadata {
    id: String,
    title: String,
    author: String,
    file_name: String,
}

/// Genera marcas de tiempo UTC, ISO 8601 y con precisión de milisegundos.
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
/// Convierte errores internos a la representación textual que acepta Tauri.
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Retira caracteres de control, limita longitud Unicode y recorta extremos.
fn clean(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Un libro válido se identifica por los 64 dígitos hexadecimales de su SHA-256.
fn valid_book_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|ch| ch.is_ascii_hexdigit())
}
/// Convierte la validación booleana del identificador en un resultado explicativo.
fn check_book_id(id: &str) -> Result<(), String> {
    if valid_book_id(id) {
        Ok(())
    } else {
        Err("Identificador de libro inválido".into())
    }
}

/// Obtiene el directorio privado de la app y garantiza su estructura mínima.
fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(message)?;
    fs::create_dir_all(root.join("books")).map_err(message)?;
    fs::create_dir_all(root.join("covers")).map_err(message)?;
    Ok(root)
}

/// Construye la ruta de un EPUB solo después de validar su identificador.
fn book_file(root: &PathBuf, id: &str) -> Result<PathBuf, String> {
    check_book_id(id)?;
    Ok(root.join("books").join(format!("{id}.epub")))
}

/// Construye la ruta de una portada validando tanto SHA-256 como UUID.
fn cover_file(root: &PathBuf, id: &str, key: &str) -> Result<PathBuf, String> {
    check_book_id(id)?;
    Uuid::parse_str(key).map_err(message)?;
    Ok(root.join("covers").join(format!("{id}-{key}.cover")))
}

///
/// Escribe bytes mediante un archivo temporal sincronizado y un rename final.
/// Un fallo nunca deja un destino parcialmente escrito.
fn write_file_durable(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("new-{}", Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&temporary).map_err(message)?;
        file.write_all(bytes).map_err(message)?;
        file.sync_all().map_err(message)?;
        fs::rename(&temporary, path).map_err(message)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// Mueve un archivo a un nombre recuperable antes de confirmar su eliminación.
fn stage_for_delete(path: &PathBuf, extension: &str) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let staged = path.with_extension(format!("{extension}.pending-delete"));
    if staged.exists() {
        return Err("Hay una eliminación pendiente para este archivo".into());
    }
    fs::rename(path, &staged).map_err(message)?;
    Ok(Some(staged))
}

/// Revierte una eliminación preparada cuando el commit de metadatos falla.
fn restore_staged(staged: &Option<PathBuf>, original: &PathBuf) {
    if let Some(staged) = staged {
        let _ = fs::rename(staged, original);
    }
}

/// Descarta el archivo preparado después de confirmar el cambio del índice.
fn discard_staged(staged: Option<PathBuf>) {
    if let Some(staged) = staged {
        let _ = fs::remove_file(staged);
    }
}

///
/// Resuelve residuos de operaciones interrumpidas sin borrar datos ambiguos.
/// Solo actúa sobre nombres temporales creados por este módulo: una copia binaria
/// completa que no aparece en el índice se conserva para recuperación manual.
fn clean_orphan_files(root: &PathBuf, database: &Database) {
    // Nunca se asume que un EPUB o portada sin referencia sea desechable: un
    // respaldo restaurado puede ser anterior a esos binarios.
    let known_books: HashSet<_> = database.books.iter().map(|book| book.id.as_str()).collect();
    if let Ok(entries) = fs::read_dir(root.join("books")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(id) = name.strip_suffix(".epub.pending-delete") {
                if valid_book_id(id) {
                    let original = root.join("books").join(format!("{id}.epub"));
                    if known_books.contains(id) && !original.exists() {
                        let _ = fs::rename(entry.path(), original);
                    } else {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            } else if let Some((id, key)) = name.split_once(".new-") {
                if valid_book_id(id) && Uuid::parse_str(key).is_ok() {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    let known_covers: HashSet<_> = database
        .books
        .iter()
        .filter_map(|book| {
            book.cover_key
                .as_ref()
                .map(|key| format!("{}-{key}.cover", book.id))
        })
        .collect();
    if let Ok(entries) = fs::read_dir(root.join("covers")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(stem) = name.strip_suffix(".cover.pending-delete") {
                if let Some((id, key)) = stem.split_once('-') {
                    if valid_book_id(id) && Uuid::parse_str(key).is_ok() {
                        let original_name = format!("{stem}.cover");
                        let original = root.join("covers").join(&original_name);
                        if known_covers.contains(&original_name) && !original.exists() {
                            let _ = fs::rename(entry.path(), original);
                        } else {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            } else if let Some((stem, temporary_key)) = name.split_once(".new-") {
                if let Some((id, cover_key)) = stem.split_once('-') {
                    if valid_book_id(id)
                        && Uuid::parse_str(cover_key).is_ok()
                        && Uuid::parse_str(temporary_key).is_ok()
                    {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}

///
/// Lee y valida el índice, recuperándolo desde el respaldo cuando es posible.
/// Si hay binarios pero falta el índice, se informa el problema sin eliminarlos.
fn read_database(root: &PathBuf) -> Result<Database, String> {
    let path = root.join("library.json");
    let backup = root.join("library.json.bak");
    // Windows no ofrece un overwrite-rename portable. Si el proceso terminó
    // entre apartar el archivo anterior e instalar el nuevo, se restaura la
    // última copia completa antes de leer.
    if !path.exists() && backup.exists() {
        fs::rename(&backup, &path).map_err(message)?;
    }
    if !path.exists() {
        // La ausencia de metadatos no autoriza a eliminar archivos del usuario.
        let has_files = ["books", "covers"].iter().any(|folder| {
            fs::read_dir(root.join(folder))
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
        });
        if has_files {
            return Err("Falta el índice de la biblioteca; los EPUB y portadas se conservaron para recuperación".into());
        }
        return Ok(Database::default());
    }
    let bytes = fs::read(&path).map_err(message)?;
    let database: Database = match serde_json::from_slice(&bytes) {
        Ok(database) => database,
        Err(main_error) => {
            let backup_bytes = fs::read(&backup)
                .map_err(|_| format!("La biblioteca está dañada: {main_error}"))?;
            let recovered: Database = serde_json::from_slice(&backup_bytes)
                .map_err(|_| format!("La biblioteca y su respaldo están dañados: {main_error}"))?;
            if recovered.version != 1 {
                return Err("La versión del respaldo no es compatible".into());
            }
            // Conserva el archivo dañado para diagnóstico y restaura la última
            // instantánea completa sin tocar ningún EPUB.
            let damaged = root.join(format!("library.corrupt-{}.json", Uuid::new_v4()));
            fs::rename(&path, damaged).map_err(message)?;
            fs::copy(&backup, &path).map_err(message)?;
            recovered
        }
    };
    if database.version != 1 {
        return Err("La versión de la biblioteca no es compatible".into());
    }
    clean_orphan_files(root, &database);
    Ok(database)
}

///
/// Guarda el índice con secuencia temporal → sync → respaldo → rename.
/// Ante un fallo restaura el respaldo, por lo que siempre queda una copia completa.
fn save_database(root: &PathBuf, database: &Database) -> Result<(), String> {
    let destination = root.join("library.json");
    let backup = root.join("library.json.bak");
    let temporary = root.join(format!(".library-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(database).map_err(message)?;
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&temporary).map_err(message)?;
        file.write_all(&bytes).map_err(message)?;
        file.sync_all().map_err(message)?;
        if destination.exists() {
            // `read_database` ya validó el archivo actual; moverlo permite que
            // el siguiente rename funcione tanto en Windows como en Unix.
            if backup.exists() {
                fs::remove_file(&backup).map_err(message)?;
            }
            fs::rename(&destination, &backup).map_err(message)?;
        }
        if let Err(error) = fs::rename(&temporary, &destination) {
            if backup.exists() {
                let _ = fs::rename(&backup, &destination);
            }
            return Err(message(error));
        }
        // La instantánea completa anterior se conserva para recuperación.
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

/// Hidrata la portada separada como data URL antes de devolver un libro por IPC.
fn public_book(root: &PathBuf, book: &StoredBook) -> Result<StoredBook, String> {
    let mut result = book.clone();
    if let (Some(mime), Some(key)) = (&book.cover_mime, &book.cover_key) {
        result.cover_data_url = cover_file(root, &book.id, key)
            .ok()
            .and_then(|path| fs::read(path).ok())
            .map(|bytes| format!("data:{mime};base64,{}", BASE64.encode(bytes)));
    }
    Ok(result)
}

/// Busca un libro de forma inmutable después de validar el ID.
fn find_book<'a>(database: &'a Database, id: &str) -> Result<&'a StoredBook, String> {
    check_book_id(id)?;
    database
        .books
        .iter()
        .find(|book| book.id == id)
        .ok_or_else(|| "Libro no encontrado".into())
}

/// Busca un libro mutable después de validar el ID.
fn find_book_mut<'a>(database: &'a mut Database, id: &str) -> Result<&'a mut StoredBook, String> {
    check_book_id(id)?;
    database
        .books
        .iter_mut()
        .find(|book| book.id == id)
        .ok_or_else(|| "Libro no encontrado".into())
}

/// Busca una colección mutable o devuelve un error de dominio.
fn find_collection_mut<'a>(
    database: &'a mut Database,
    id: &str,
) -> Result<&'a mut StoredCollection, String> {
    database
        .collections
        .iter_mut()
        .find(|collection| collection.id == id)
        .ok_or_else(|| "Colección no encontrada".into())
}

///
/// Ejecuta una operación bajo exclusión mutua con el índice recién cargado.
/// Cada comando decide explícitamente si solo lee o llama también a `save_database`.
fn with_database<T>(
    app: &AppHandle,
    state: &State<'_, StoreLock>,
    action: impl FnOnce(&PathBuf, &mut Database) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = state.0.lock().map_err(message)?;
    let root = data_root(app)?;
    let mut database = read_database(&root)?;
    action(&root, &mut database)
}

/// Lista libros con portadas hidratadas y los más recientes primero.
#[tauri::command(async)]
fn list_books(app: AppHandle, state: State<'_, StoreLock>) -> Result<Vec<StoredBook>, String> {
    with_database(&app, &state, |root, database| {
        let mut books = database
            .books
            .iter()
            .map(|book| public_book(root, book))
            .collect::<Result<Vec<_>, _>>()?;
        books.sort_by(|a, b| {
            b.last_opened_at
                .as_ref()
                .unwrap_or(&b.added_at)
                .cmp(a.last_opened_at.as_ref().unwrap_or(&a.added_at))
        });
        Ok(books)
    })
}

///
/// Importa bytes EPUB recibidos como cuerpo IPC sin duplicar contenidos.
/// El frontend calcula el SHA-256; aquí se valida su forma y se usa como nombre seguro.
#[tauri::command(async)]
fn import_epub(
    app: AppHandle,
    state: State<'_, StoreLock>,
    request: Request,
) -> Result<StoredBook, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Se esperaba un EPUB binario".into());
    };
    if bytes.len() < 4
        || bytes.len() > MAX_EPUB_BYTES
        || !bytes.starts_with(&[0x50, 0x4b, 0x03, 0x04])
    {
        return Err("El archivo no parece un EPUB válido o supera 200 MB".into());
    }
    let header = request
        .headers()
        .get("X-Nubooks-Metadata")
        .ok_or("Faltan metadatos de importación")?;
    let decoded = BASE64
        .decode(header.to_str().map_err(message)?)
        .map_err(message)?;
    let metadata: UploadMetadata = serde_json::from_slice(&decoded).map_err(message)?;
    check_book_id(&metadata.id)?;
    if !metadata.file_name.to_lowercase().ends_with(".epub") {
        return Err("Selecciona un archivo .epub".into());
    }
    with_database(&app, &state, |root, database| {
        if let Some(existing) = database.books.iter().find(|book| book.id == metadata.id) {
            return public_book(root, existing);
        }
        let file = book_file(root, &metadata.id)?;
        write_file_durable(&file, bytes)?;
        let record = StoredBook {
            id: metadata.id.clone(),
            title: clean(&metadata.title, 200),
            author: clean(&metadata.author, 200),
            file_name: clean(&metadata.file_name, 240),
            cover_data_url: None,
            cover_mime: None,
            cover_key: None,
            added_at: now(),
            last_opened_at: None,
            progress: None,
            settings: ReaderSettings::default(),
            bookmarks: vec![],
        };
        database.books.push(record.clone());
        if let Err(error) = save_database(root, database) {
            let _ = fs::remove_file(file);
            return Err(error);
        }
        Ok(record)
    })
}

/// Devuelve el EPUB como respuesta binaria después de confirmar su registro.
#[tauri::command(async)]
fn read_epub(app: AppHandle, state: State<'_, StoreLock>, id: String) -> Result<Response, String> {
    with_database(&app, &state, |root, database| {
        find_book(database, &id)?;
        Ok(Response::new(
            fs::read(book_file(root, &id)?).map_err(message)?,
        ))
    })
}

///
/// Elimina libro, portada y membresías con una transacción recuperable.
/// Primero prepara los binarios, luego confirma el índice y finalmente los descarta.
#[tauri::command(async)]
fn remove_book(app: AppHandle, state: State<'_, StoreLock>, id: String) -> Result<(), String> {
    with_database(&app, &state, |root, database| {
        let old = find_book(database, &id)?.clone();
        let epub = book_file(root, &id)?;
        let cover = old
            .cover_key
            .as_ref()
            .map(|key| cover_file(root, &id, key))
            .transpose()?;
        let staged_epub = stage_for_delete(&epub, "epub")?;
        let staged_cover = match &cover {
            Some(path) => match stage_for_delete(path, "cover") {
                Ok(staged) => staged,
                Err(error) => {
                    restore_staged(&staged_epub, &epub);
                    return Err(error);
                }
            },
            None => None,
        };
        database.books.retain(|book| book.id != id);
        for collection in &mut database.collections {
            if collection.book_ids.iter().any(|book_id| book_id == &id) {
                collection.book_ids.retain(|book_id| book_id != &id);
                collection.updated_at = now();
            }
        }
        if let Err(error) = save_database(root, database) {
            restore_staged(&staged_epub, &epub);
            if let Some(cover) = &cover {
                restore_staged(&staged_cover, cover);
            }
            return Err(error);
        }
        // La eliminación ya está confirmada; cualquier residuo se limpiará en
        // la siguiente lectura mediante `clean_orphan_files`.
        discard_staged(staged_epub);
        discard_staged(staged_cover);
        Ok(())
    })
}

/// Cambia el título visible sin modificar el nombre ni los bytes del EPUB.
#[tauri::command(async)]
fn rename_book(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
    title: String,
) -> Result<StoredBook, String> {
    let title = clean(&title, 200);
    if title.is_empty() {
        return Err("Escribe un título para el libro".into());
    }
    with_database(&app, &state, |root, database| {
        let book = find_book_mut(database, &id)?;
        book.title = title;
        let book = book.clone();
        save_database(root, database)?;
        public_book(root, &book)
    })
}

/// Registra la apertura actual para ordenar y mostrar la lectura reciente.
#[tauri::command(async)]
fn mark_book_opened(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
) -> Result<StoredBook, String> {
    with_database(&app, &state, |root, database| {
        let book = find_book_mut(database, &id)?;
        book.last_opened_at = Some(now());
        let book = book.clone();
        save_database(root, database)?;
        public_book(root, &book)
    })
}

/// Obtiene preferencias, progreso y marcadores de un libro.
#[tauri::command(async)]
fn get_book_state(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
) -> Result<BookState, String> {
    with_database(&app, &state, |_root, database| {
        let book = find_book(database, &id)?;
        Ok(BookState {
            settings: book.settings.clone(),
            progress: book.progress.clone(),
            bookmarks: book.bookmarks.clone(),
        })
    })
}

/// Valida y aplica un parche parcial del estado de lectura.
#[tauri::command(async)]
fn update_book_state(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
    patch: BookStatePatch,
) -> Result<StoredBook, String> {
    with_database(&app, &state, |root, database| {
        let book = find_book_mut(database, &id)?;
        if let Some(settings) = patch.settings {
            if !settings.valid() {
                return Err("Configuración de lectura inválida".into());
            }
            book.settings = settings;
        }
        if let Some(progress) = patch.progress {
            if let Some(value) = &progress {
                if !value.percent.is_finite()
                    || !(0.0..=100.0).contains(&value.percent)
                    || value.cfi.as_ref().is_some_and(|cfi| cfi.len() > 4000)
                {
                    return Err("Progreso de lectura inválido".into());
                }
            }
            book.progress = progress;
        }
        if let Some(bookmarks) = patch.bookmarks {
            if bookmarks.len() > 10_000
                || bookmarks
                    .iter()
                    .any(|bookmark| bookmark.cfi.len() > 4000 || bookmark.label.len() > 200)
            {
                return Err("Marcadores inválidos".into());
            }
            book.bookmarks = bookmarks;
        }
        let book = book.clone();
        save_database(root, database)?;
        public_book(root, &book)
    })
}

///
/// Sustituye la portada con la misma estrategia preparada/confirmada del borrado.
/// La imagen nueva se escribe antes de apartar la anterior para no dejar el libro sin portada.
#[tauri::command(async)]
fn set_cover(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
    data_url: Option<String>,
) -> Result<StoredBook, String> {
    with_database(&app, &state, |root, database| {
        let old_key = find_book(database, &id)?.cover_key.clone();
        let (mime, image) = if let Some(data_url) = data_url {
            let (prefix, payload) = data_url
                .split_once(";base64,")
                .ok_or("Formato de portada inválido")?;
            let mime = prefix
                .strip_prefix("data:")
                .ok_or("Formato de portada inválido")?;
            if ![
                "image/jpeg",
                "image/png",
                "image/webp",
                "image/gif",
                "image/svg+xml",
            ]
            .contains(&mime)
                || payload.len() > (MAX_COVER_BYTES * 4 / 3) + 4
            {
                return Err("La portada debe ser una imagen de hasta 3 MB".into());
            }
            let image = BASE64.decode(payload).map_err(message)?;
            if image.is_empty() || image.len() > MAX_COVER_BYTES {
                return Err("Portada demasiado grande".into());
            }
            (Some(mime.to_owned()), Some(image))
        } else {
            (None, None)
        };
        let new_key = image.as_ref().map(|_| Uuid::new_v4().to_string());
        let new_path = new_key
            .as_ref()
            .map(|key| cover_file(root, &id, key))
            .transpose()?;
        if let (Some(image), Some(path)) = (&image, &new_path) {
            write_file_durable(path, image)?;
        }
        let old_path = old_key
            .as_ref()
            .map(|key| cover_file(root, &id, key))
            .transpose()?;
        let staged_old = match &old_path {
            Some(path) => match stage_for_delete(path, "cover") {
                Ok(staged) => staged,
                Err(error) => {
                    if let Some(new_path) = &new_path {
                        let _ = fs::remove_file(new_path);
                    }
                    return Err(error);
                }
            },
            None => None,
        };
        let book = find_book_mut(database, &id)?;
        book.cover_mime = mime;
        book.cover_key = new_key;
        let book = book.clone();
        if let Err(error) = save_database(root, database) {
            if let Some(path) = &new_path {
                let _ = fs::remove_file(path);
            }
            if let Some(path) = &old_path {
                restore_staged(&staged_old, path);
            }
            return Err(error);
        }
        discard_staged(staged_old);
        public_book(root, &book)
    })
}

/// Exporta una copia mediante un diálogo nativo; nunca acepta una ruta de la WebView.
#[tauri::command(async)]
fn export_epub(app: AppHandle, state: State<'_, StoreLock>, id: String) -> Result<bool, String> {
    let (source, suggested_name) = with_database(&app, &state, |root, database| {
        let book = find_book(database, &id)?;
        Ok((book_file(root, &id)?, clean(&book.file_name, 240)))
    })?;
    // El usuario elige el destino en un diálogo nativo; la WebView no puede
    // suministrar rutas arbitrarias.
    let selected = app
        .dialog()
        .file()
        .add_filter("EPUB", &["epub"])
        .set_file_name(suggested_name)
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(false);
    };
    let target = selected.into_path().map_err(message)?;
    if source == target
        || (target.exists() && fs::canonicalize(&source).ok() == fs::canonicalize(&target).ok())
    {
        return Err("Elige otra carpeta para exportar el archivo".into());
    }
    fs::copy(source, target).map_err(message)?;
    Ok(true)
}

/// Devuelve las preferencias generales de la biblioteca.
#[tauri::command(async)]
fn get_profile(app: AppHandle, state: State<'_, StoreLock>) -> Result<UserProfile, String> {
    with_database(&app, &state, |_root, database| Ok(database.profile.clone()))
}

/// Actualiza los campos enviados del perfil y conserva los demás.
#[tauri::command(async)]
fn update_profile(
    app: AppHandle,
    state: State<'_, StoreLock>,
    patch: ProfilePatch,
) -> Result<UserProfile, String> {
    with_database(&app, &state, |root, database| {
        if let Some(value) = patch.settings_per_book { database.profile.settings_per_book = value; }
        if let Some(settings) = patch.global_reader_settings {
            if !settings.valid() { return Err("Configuración global inválida".into()); }
            database.profile.global_reader_settings = Some(settings);
        }
        if let Some(name) = patch.name {
            database.profile.name = clean(&name, 80);
        }
        if let Some(view) = patch.library_view {
            if !["grid", "list", "carousel"].contains(&view.as_str()) {
                return Err("Vista de biblioteca inválida".into());
            }
            database.profile.library_view = view;
        }
        save_database(root, database)?;
        Ok(database.profile.clone())
    })
}

/// Lista las colecciones en su orden persistido.
#[tauri::command(async)]
fn list_collections(
    app: AppHandle,
    state: State<'_, StoreLock>,
) -> Result<Vec<StoredCollection>, String> {
    with_database(&app, &state, |_root, database| {
        Ok(database.collections.clone())
    })
}

/// Crea una colección vacía con UUID y fechas nuevas.
#[tauri::command(async)]
fn create_collection(
    app: AppHandle,
    state: State<'_, StoreLock>,
    name: String,
) -> Result<StoredCollection, String> {
    let name = clean(&name, 100);
    if name.is_empty() {
        return Err("Escribe un nombre para la colección".into());
    }
    with_database(&app, &state, |root, database| {
        let date = now();
        let collection = StoredCollection {
            id: Uuid::new_v4().to_string(),
            name,
            book_ids: vec![],
            created_at: date.clone(),
            updated_at: date,
        };
        database.collections.push(collection.clone());
        save_database(root, database)?;
        Ok(collection)
    })
}

/// Renombra una colección y actualiza su fecha de modificación.
#[tauri::command(async)]
fn rename_collection(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
    name: String,
) -> Result<StoredCollection, String> {
    let name = clean(&name, 100);
    if name.is_empty() {
        return Err("Escribe un nombre para la colección".into());
    }
    with_database(&app, &state, |root, database| {
        let collection = find_collection_mut(database, &id)?;
        collection.name = name;
        collection.updated_at = now();
        let collection = collection.clone();
        save_database(root, database)?;
        Ok(collection)
    })
}

/// Sustituye miembros, rechaza IDs inexistentes y elimina duplicados conservando orden.
#[tauri::command(async)]
fn set_collection_books(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
    book_ids: Vec<String>,
) -> Result<StoredCollection, String> {
    with_database(&app, &state, |root, database| {
        let known: HashSet<_> = database.books.iter().map(|book| book.id.as_str()).collect();
        if book_ids
            .iter()
            .any(|book_id| !known.contains(book_id.as_str()))
        {
            return Err("La colección contiene un libro inexistente".into());
        }
        let mut unique = HashSet::new();
        let filtered = book_ids
            .into_iter()
            .filter(|book_id| unique.insert(book_id.clone()))
            .collect();
        let collection = find_collection_mut(database, &id)?;
        collection.book_ids = filtered;
        collection.updated_at = now();
        let collection = collection.clone();
        save_database(root, database)?;
        Ok(collection)
    })
}

/// Elimina una colección sin borrar sus libros.
#[tauri::command(async)]
fn delete_collection(
    app: AppHandle,
    state: State<'_, StoreLock>,
    id: String,
) -> Result<(), String> {
    with_database(&app, &state, |root, database| {
        if !database
            .collections
            .iter()
            .any(|collection| collection.id == id)
        {
            return Err("Colección no encontrada".into());
        }
        database
            .collections
            .retain(|collection| collection.id != id);
        save_database(root, database)
    })
}

/// Construye la aplicación, registra estado, plugins y comandos IPC permitidos.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Un mutex local no protege `library.json` si la app se abre dos veces;
        // este plugin conserva una sola instancia y enfoca su ventana.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .manage(StoreLock::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_epub,
            read_epub,
            remove_book,
            rename_book,
            mark_book_opened,
            get_book_state,
            update_book_state,
            set_cover,
            export_epub,
            get_profile,
            update_profile,
            list_collections,
            create_collection,
            rename_collection,
            set_collection_books,
            delete_collection,
        ])
        .run(tauri::generate_context!())
        .expect("No se pudo iniciar Nubooks");
}
