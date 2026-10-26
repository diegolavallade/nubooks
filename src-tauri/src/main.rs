#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Punto de entrada mínimo del ejecutable. La lógica vive en la biblioteca para
/// que Tauri pueda reutilizarla en las distintas plataformas compatibles.
fn main() {
    nubooks_lib::run()
}
