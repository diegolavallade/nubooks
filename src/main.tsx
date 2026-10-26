import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

// Punto de entrada del frontend. StrictMode ayuda a detectar efectos sin una
// limpieza correcta durante el desarrollo; no duplica montajes en producción.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
