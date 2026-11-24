# Agenda PWA — Funcionamiento offline, notificaciones y publicación

PWA para administrar **actividades y recordatorios personales**. Funciona sin conexión, guarda los datos en **IndexedDB**, envía **notificaciones locales** (Notifications API) y **notificaciones Push** (Push API + backend Node con VAPID), y **sincroniza** los cambios hechos offline cuando vuelve la conexión.

## Cumplimiento de la actividad

| # | Requisito | Dónde está |
|---|-----------|------------|
| 1 | PWA de actividades y recordatorios | `public/index.html`, `public/manifest.webmanifest`, íconos en `public/icons/` |
| 2 | CRUD (registrar, consultar, modificar, eliminar) | `public/js/app.js` → `onSubmit`, `refresh/render`, `startEdit`, `removeActivity`, `toggleDone` |
| 3 | IndexedDB | `public/js/db.js` (stores `activities`, `outbox`, `meta`) |
| 4 | Estrategias de caché con Service Worker | `public/sw.js`: precaché del *app shell*, **Network First** para páginas y `/api`, **Stale‑While‑Revalidate** para CSS/JS/imágenes, `offline.html` de respaldo |
| 5 | Notifications API + Push API con backend | Local: `showLocalNotification` y `checkLocalReminders` en `app.js`. Push: `togglePush`/`testPush` (cliente), evento `push` en `sw.js`, `/api/subscribe`, `/api/notify` y programador de recordatorios en `server.js` (librería `web-push`) |
| 6 | Sincronización al recuperar conexión | Cola **outbox** en IndexedDB + **Background Sync** (`sync-activities` en `sw.js`) + respaldo con el evento `online`. El servidor resuelve conflictos con *last‑write‑wins* (`/api/sync`) |
| 7 | Publicación con HTTPS | `render.yaml` (Render.com, HTTPS automático). Instrucciones abajo |
| 8 | Lighthouse y correcciones | `entregables/lighthouse-local.report.html`. Sección "Correcciones Lighthouse" abajo |

## Estructura

```
server.js                 Backend Express: estáticos, API de sync, suscripciones y envío Push
render.yaml               Despliegue en Render (HTTPS)
scripts/generate-vapid.js Genera llaves VAPID para producción
scripts/make-icons.ps1    Genera los íconos PNG
public/
  index.html  offline.html  manifest.webmanifest  robots.txt  sw.js
  css/styles.css
  js/db.js   (IndexedDB, compartido con el Service Worker)
  js/app.js  (UI, CRUD, notificaciones, Push, sincronización)
  icons/
```

## Ejecutar localmente

Requiere Node.js 18+.

```powershell
npm install
npm start
```

Abre http://localhost:3000 (en `localhost` los Service Workers y Push funcionan sin HTTPS). Las llaves VAPID se generan solas la primera vez en `data/vapid.json`.

## Publicar en Render (HTTPS gratis)

1. Sube el proyecto a un repositorio de GitHub (la carpeta `node_modules/` y `data/` están ignoradas):
   ```powershell
   git init
   ```
   ```powershell
   git add .
   ```
   ```powershell
   git commit -m "Agenda PWA"
   ```
   Crea el repo vacío en github.com y luego:
   ```powershell
   git branch -M main
   ```
   ```powershell
   git remote add origin https://github.com/TU_USUARIO/agenda-pwa.git
   ```
   ```powershell
   git push -u origin main
   ```
2. Genera llaves VAPID fijas (para que las suscripciones Push no se invaliden en cada reinicio):
   ```powershell
   npm run vapid
   ```
3. En https://render.com → **New → Blueprint** → elige el repositorio (usa `render.yaml`). Cuando pida las variables, pega `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` del paso 2.
   *(Alternativa: New → Web Service, Build `npm install`, Start `npm start`, y agrega las variables manualmente.)*
4. Render te da una URL `https://agenda-pwa-xxxx.onrender.com` con HTTPS. Esa es la **URL pública** a entregar.

> Nota: en el plan gratuito de Render el servicio "duerme" tras 15 min sin uso y el disco se reinicia en cada despliegue; los datos del servidor (`data/db.json`) son de demostración. Los datos del usuario siempre viven en IndexedDB y se vuelven a sincronizar.

## Correcciones Lighthouse

Primera auditoría (local, móvil): Performance 77 · Accesibilidad 100 · Buenas prácticas 100 · SEO 92.

| Problema detectado | Corrección |
|--------------------|------------|
| `robots.txt` inválido (el *fallback* SPA devolvía HTML) | Se agregó `public/robots.txt` |
| CLS 0.68: la lista de actividades crecía al cargar y empujaba la tarjeta de notificaciones | Se reordenó el HTML (lista al final en móvil) y se reservó altura mínima para la lista |
| CLS 0.24: el botón "Instalar app" aparecía después de cargar y cambiaba la altura del encabezado | El botón reserva su espacio con `visibility: hidden` |

Resultado final (local): **Performance 100 · Accesibilidad 100 · Buenas prácticas 100 · SEO 100** (CLS 0.005).

Otras buenas prácticas ya incluidas: `lang="es"`, meta description, `theme-color`, etiquetas `<label>` en todos los campos, áreas táctiles de 44 px, contraste AA, modo oscuro, ícono *maskable*, compresión gzip y cabeceras de seguridad (CSP, `nosniff`, COOP).

**Para el reporte final**, ejecuta Lighthouse sobre la URL pública: Chrome → F12 → pestaña *Lighthouse* → *Analyze page load*, y guarda el reporte (⋮ → *Save as HTML*). O desde terminal:

```powershell
npx lighthouse https://TU-APP.onrender.com --output html --output-path ./entregables/lighthouse-produccion.html
```

## Guion para capturas offline y video demostrativo

1. Abrir la URL pública, mostrar el candado HTTPS e **instalar la app** (botón "Instalar app" o ícono en la barra de direcciones).
2. **CRUD**: crear 2 actividades (una con recordatorio "5 minutos antes" o "A la hora"), editar una, marcarla como completada, buscar y filtrar, eliminar otra.
3. **IndexedDB**: F12 → *Application* → *IndexedDB* → `agenda-pwa` → `activities` y `outbox`.
4. **Service Worker y caché**: F12 → *Application* → *Service Workers* (activo) y *Cache Storage* (`agenda-shell-*`, `agenda-runtime-*`, `agenda-api-*`).
5. **Offline** 📸: *Application → Service Workers → Offline* (o *Network → Offline*). Recargar: la app sigue cargando, el indicador muestra "Sin conexión". Crear/editar una actividad: aparece "Sin sincronizar" y "1 cambio(s) pendiente(s)"; mostrar la `outbox` en IndexedDB.
6. **Sincronización**: quitar *Offline* → aviso "Conexión recuperada: sincronizando…", el contador vuelve a "Sincronizado"; abrir `https://TU-APP/api/activities` para mostrar que el servidor ya tiene el cambio.
7. **Notificaciones**: "Activar notificaciones" → "Probar notificación local". Luego "Suscribirse a Push" → "Enviar Push de prueba". Cerrar la pestaña y esperar el recordatorio programado: llega como Push desde el servidor; al hacer clic se abre la app.
8. **Lighthouse**: mostrar el reporte y las correcciones de la tabla anterior.
