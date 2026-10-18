# mi-asistente

Asistente de desarrollo en terminal, **100% local**, que corre sobre **Ollama** en **Windows 11**.
No hay servidores, ni APIs de pago, ni cuentas: el modelo se ejecuta en tu propia máquina y el
agente tiene acceso directo a tu sistema de archivos, a `cmd.exe`, a internet y a GitHub.

La persona del asistente es **"Cristian HERMOSO"** (constante `NOMBRE` en `index.js`).

---

## Tabla de contenidos

- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Uso](#uso)
- [Arquitectura del proyecto](#arquitectura-del-proyecto)
- [Acciones disponibles](#acciones-disponibles)
- [Capacidades de búsqueda en internet](#capacidades-de-búsqueda-en-internet)
- [Seguridad y límites](#seguridad-y-límites)
- [Flujo de una acción](#flujo-de-una-acción)
- [Configuración](#configuración)
- [Variables y constantes](#variables-y-constantes)
- [Dependencias](#dependencias)
- [Limitaciones conocidas](#limitaciones-conocidas)
- [Solución de problemas](#solución-de-problemas)

---

## Requisitos

| Componente | Versión / detalle |
|---|---|
| Sistema operativo | **Windows 11** (el proyecto usa `cmd.exe` de forma explícita) |
| Node.js | **>= 22** (lo exige `chalk@6`; probado en v24.10.0) |
| npm | 11.x |
| [Ollama](https://ollama.com) | instalado y **corriendo** en background |
| GitHub CLI (`gh`) | solo para `buscar_github`, `ver_repo` y lectura de repos; requiere `gh auth login` |
| `curl.exe` | incluido en Windows 10/11 de fábrica; usado para todo el scraping web |
| [Sherlock](https://github.com/sherlock-project/sherlock) | opcional, solo para `buscar_usuario`; `pipx install sherlock-project` |

No hay variables de entorno ni archivos `.env`: toda la configuración está en el código.

### Modelo de Ollama recomendado

El asistente está pensado para un modelo con capacidad de **instrucciones y JSON estricto**.
Si no tenés ninguno instalado:

```cmd
ollama pull qwen2.5-coder:7b
```

Cualquier modelo local funciona; el selector del arranque te deja elegir entre los que tengas.

---

## Instalación

```cmd
npm install
npm start
```

`npm start` es simplemente `node index.js`. Los tests (con el runner nativo de Node) corren con:

```cmd
npm test
```

> El módulo `tree-sitter` compila binarios nativos al instalar; `package.json` autoriza sus
> scripts con `allowScripts`. La primera vez que se usa el RAG se descarga el modelo de embeddings
> (`Xenova/all-MiniLM-L6-v2`) a `.cache/modelos` y después corre 100% offline.

---

## Uso

Al arrancar, el asistente detecta los modelos instalados con `ollama list` y te pide elegir uno:

```
🔍 Detectando modelos Ollama instalados...

Modelos disponibles:

  1. qwen2.5-coder:7b
     Tamaño: 4.7 GB  |  Modificado: 2 days ago
  2. llama3.1:8b
     Tamaño: 4.9 GB  |  Modificado: 1 week ago

Elegí un modelo (1-2) [default: 1]:
```

Aceptás el **número**, el **nombre exacto** del modelo o **Enter** para el primero. Si la entrada no es
válida, vuelve a preguntar (no elige por vos).

Luego quedás en un REPL:

```
🤖 Cristian HERMOSO — Asistente IA local (Windows 11)
   Modelo: qwen2.5-coder:7b
   Directorio: F:\upc\mi-asistente
   Contexto estimado: 32768 tokens
   Escribí "salir" para terminar.

vos > creame un archivo hola.js que imprima hola
```

Al arrancar también se avisa que nada se indexa solo: la lectura de repos, archivos y carpetas
se pide explícitamente ("leé &lt;ruta&gt;", "analizá &lt;repo&gt;", "de qué trata &lt;archivo&gt;").

### Controles

| Tecla / palabra | Efecto |
|---|---|
| `salir` (o `exit`) | termina el programa (en realidad solo corta en `salir`) |
| **Esc Esc** (doble) | cancela la generación en curso (`ollama.abort()`) |
| `s` / `n` / `editar` | confirmar, rechazar o editar manualmente el JSON de la acción propuesta |

### Ejemplos de prompts

```
vos > listame los archivos de este proyecto
vos > leé el archivo package.json
vos > creame una carpeta src y dentro un index.js con un hola mundo
vos > corré npm test
vos > buscá un repo de ecommerce en node
vos > quién es Lionel Messi
vos > leé https://es.wikipedia.org/wiki/Node.js
```

---

## Arquitectura del proyecto

Módulos ESM planos, sin build, sin framework, sin transpilador. Node los carga nativamente.

```
mi-asistente/
├── package.json         # ESM ("type": "module"), deps + scripts start/test
├── index.js             # REPL, system prompt, loop de acciones, confirmaciones, RAG
├── acciones.js          # implementación de las acciones (archivos + shell)
├── buscar.js            # scraping de Bing, Wikipedia, GitHub CLI y búsqueda de personas
├── config.js            # clasificación de comandos (seguro/peligroso/prohibido)
├── modelos.js           # detección y selección de modelo de Ollama
├── repo.js              # indexación de repositorios (tree-sitter, ripgrep, chokidar)
├── vectores.js          # RAG local: embeddings (@xenova/transformers) + vectra
├── sherlock.js          # búsqueda de @usuario en ~400 plataformas (Sherlock)
├── tokens.js            # conteo de tokens vía API de Ollama
├── verificador.js       # gate de veracidad (citas obligatorias, fail-closed)
├── verificador.test.js  # tests del verificador (node --test)
├── sherlock.test.js     # tests del parser de Sherlock
├── tokens.test.js       # tests de cálculo de tokens
└── buscar-personas.test.js  # tests de la búsqueda de perfiles
```

### Lectura de repositorios SIN IA

Cuando el usuario pide "leé el repositorio ...", `index.js` detecta la orden y el **programa**
(o sea `repo.js`, sin intervención del modelo) indexa la carpeta local o clona la URL git a
`.repos/`, extrae archivos y símbolos (tree-sitter), y volca el índice al historial. La
vigilancia con `chokidar` mantiene el índice al día; el indexado es incremental (hash por
archivo en `.cache/`).

### RAG local (búsqueda vectorial)

`vectores.js` indexa los archivos del proyecto (texto y PDF, vía `pdf-parse`) en chunks y los
embebe offline con `Xenova/all-MiniLM-L6-v2` (`@xenova/transformers` + `vectra`). En cada
pregunta se recuperan los chunks más similares y se inyectan en el system prompt como única
fuente permitida. Se desactiva con `MI_ASISTENTE_RAG=0`.

### Flujo de datos

```
   stdin
     │
     ▼
┌──────────────┐  detectarIntencion()   ┌──────────────────┐
│  REPL (main) │ ─────────────────────► │ ¿hay verbo de    │
└──────┬───────┘                        │ acción?          │
       │                                └────────┬─────────┘
       │  historial[] (system + user +          │ sí
       │  assistant + resultados)               ▼
       ▼                                ┌──────────────────┐
┌──────────────┐                        │  hasta 3 intentos│
│ ollama.chat  │ ◄────────────────────► │  de obtener JSON │
│  (stream)    │                        └────────┬─────────┘
└──────┬───────┘                                 │ parsearAccion()
       │ texto plano  ────────────────────────────┘ (sin JSON → texto normal)
       ▼
┌──────────────────┐
│ confirmarYEjecutar│ ── config.js clasificarComando()
└────────┬─────────┘
         ▼
┌──────────────────┐
│  ejecutarAccion  │ ── acciones.js ──┬── filesystem (rutaSegura)
└────────┬─────────┘                   └── buscar.js ──┬── curl.exe (Bing/Wikipedia)
         │                                             └── gh CLI (GitHub)
         ▼
  resultado (string) → se inyecta en el historial como "Resultado de la acción ..."
         │
         └──────────────► vuelve al loop (hasta 15 iteraciones por turno)
```

---

## Acciones disponibles

El modelo no ejecuta código: **devuelve un JSON**. El programa lo parsea, lo muestra y lo ejecuta.

Formato exacto esperado:

```json
{ "accion": "NOMBRE_ACCION", "params": { }, "explicacion": "qué vas a hacer y por qué" }
```

| # | Acción | Params | Qué hace |
|---|---|---|---|
| 1 | `ejecutar_comando` | `{ "cmd": "..." }` | Ejecuta un comando en `cmd.exe` con `cwd` = raíz del proyecto. `maxBuffer` 20 MB |
| 2 | `leer_archivo` | `{ "ruta": "..." }` | Lee un archivo UTF-8. Si es una carpeta, avisa y lista su contenido |
| 3 | `escribir_archivo` | `{ "ruta": "...", "contenido": "..." }` | Crea/sobrescribe un archivo. Crea las carpetas intermedias automáticamente |
| 4 | `refactorizar_archivo` | `{ "ruta": "...", "contenido": "..." }` | Igual que escribir, pero **falla si el archivo no existe** |
| 5 | `borrar` | `{ "ruta": "..." }` | Borra archivo (`unlink`) o carpeta completa (`rm -rf`) |
| 6 | `listar` | `{ "ruta": "." }` | Lista el contenido de un directorio con etiquetas `[DIR]` / `[FILE]` |
| 7 | `navegar` | `{ "ruta": "..." }` | Valida que la ruta exista y sea una carpeta; devuelve la ruta absoluta |
| 8 | `arbol` | `{ "ruta": ".", "profundidad": 3 }` | Árbol recursivo. **Ignora `node_modules` y `.git`** |
| 9 | `buscar_web` | `{ "consulta": "...", "limite": 6 }` | Búsqueda en internet (Bing, fallback Wikipedia) |
| 10 | `buscar_github` | `{ "consulta": "...", "limite": 5 }` | Busca repositorios vía `gh search repos` |
| 11 | `ver_repo` | `{ "repo": "usuario/nombre-repo" }` | Ficha de un repo: estrellas, lenguaje, licencia, último push, URL de clonado |
| 12 | `leer_url` | `{ "url": "https://...", "limite": 4000 }` | Devuelve el texto limpio de una página (los repos de GitHub van por API) |
| 13 | `buscar_persona` | `{ "nombre": "Nombre y Apellido", "limite": 8 }` | Barrido de perfiles públicos: interroga plataformas con `site:` y comillas exactas |
| 14 | `buscar_usuario` | `{ "usuario": "usuario sin @", "limite": 40 }` | Busca un @usuario en ~400 plataformas con **Sherlock** (tarda 30-90 s; requiere `pipx install sherlock-project`) |
| 15 | `leer_repo` | `{ "ruta" \| "url": "..." }` | Indexa un repo local o una URL git (clona a `.repos/`). Solo lectura |

Una acción por respuesta. El bucle interno permite encadenar hasta **15 acciones** por turno (por
ejemplo `leer_archivo` → `refactorizar_archivo` → `ejecutar_comando`). Nota: la lectura de
repositorios que el usuario pide en lenguaje natural ("leé el repo ...") la intercepta el programa
antes de llegar al modelo (ver [Arquitectura del proyecto](#arquitectura-del-proyecto)).

---

## Capacidades de búsqueda en internet

No usa APIs de búsqueda de pago: **scraping directo con `curl.exe`**.

### `buscar_web`

1. **Bing** (`https://www.bing.com/search?q=...&setlang=es`): parsea los bloques `<li class="b_algo">`,
   saca título, `<cite>` (dominio) y el párrafo del snippet.
   Bing envuelve las URLs en un redirector `bing.com/ck/a?...&u=a1<base64>`: `destaparUrlBing()`
   decodifica ese base64 (con ajuste de alphabet URL-safe y padding) para obtener la URL real.
2. **Wikipedia** como fallback: `es.wikipedia.org/api/rest_v1/page/summary/<consulta>`.
3. Si ambos fallan, devuelve un mensaje explícito con el error de Bing.

### `buscar_github`

GitHub exige que aparezcan **todas** las palabras, así que una consulta larga devuelve cero. Por eso:

- Se eliminan **stopwords** (`STOPWORDS`: de, la, proyecto, app, full, simple, of, the...).
- Se detectan **lenguajes** (`LENGUAJES`: javascript, typescript, vue, python, php, java, c#,
  go, rust, angular, react) y se convierten en filtro `--language=`.
- `generarVariantes()` arma consultas progresivamente más cortas (todas → primeras dos → primera),
  cada una con y sin filtro de lenguaje, y se prueba hasta obtener resultados.
- `puntuar()` **reordena por relevancia real** a la consulta, no solo por estrellas: cada palabra
  clave aporta +4 si aparece en el nombre, +2 en la descripción, +1 en el lenguaje, y las estrellas
  solo se suman como desempate (`puntos * 1000 + estrellas`).

### `buscar_persona` / `buscar_usuario`

- **`buscar_persona`** (`buscar.js` → `buscarPorSitios`): barrido de perfiles públicos de una
  persona (nombre y apellido). Interroga cada plataforma de `SITIOS_PERFIL` con `site:` y comillas
  exactas vía Bing, y descarta los resultados que no mencionen el nombre completo
  (`hostCoincide` + presencia del nombre en el snippet).
- **`buscar_usuario`** (`sherlock.js`): dado un @usuario, corre **Sherlock** (~400 plataformas)
  y parsea su stdout (`[+] Plataforma: url`). Tarda entre 30 y 90 s. Requiere Sherlock instalado.

### `leer_url`

- Si la URL es un repo de GitHub, usa la API (`gh api repos/...` + README crudo) y devuelve
  metadata + README **sin el HTML de la interfaz de GitHub**.
- Si es una web normal, recorta a `<main>` o `<article>`, elimina `script/style/noscript/nav/header/
  footer/aside/svg`, desarma los tags y decodifica entidades HTML.
- Si la página es dinámica y queda menos de 40 caracteres, avisa que no hay texto legible en vez de
  devolver basura.

---

## Seguridad y límites

El asistente tiene **cuatro capas de protección**, todas locales.

### 1. Lista negra de comandos (`config.js` → `COMANDOS_PROHIBIDOS`)

Se evalúan **primero** y no se pueden confirmar, ni siquiera editando el JSON:
`format`, `shutdown`, `restart-computer`, `rm -rf /`, `del /s /q c:\`, `rmdir /s /q c:\`,
`reg delete`, `bcdedit`, `diskpart`, `sfc`, `chkdsk /f`, `takeown`, `icacls /grant`, `runas`,
`sudo`, `net user`, `net localgroup`.

### 2. Lista de comandos peligrosos (`COMANDOS_PELIGROSOS`)

Requieren confirmación obligatoria: `git push`, `git reset --hard`, `git clean -fd`,
`npm uninstall|remove|publish`, `del`, `erase`, `rmdir`, `rd`, `move`, `ren`, `copy`, `xcopy`,
`robocopy`, `taskkill`, `start`, `curl`, `wget`, `Invoke-WebRequest`, `iwr`.

### 3. Lista de comandos seguros (`COMANDOS_SEGUROS`)

Corren **sin preguntar** mientras `SIEMPRE_CONFIRMAR === false` (valor actual en `config.js:109`):
`dir`, `type`, `where`, `echo`, `cd`, `pwd`, `tree`, `git status|log|diff|branch|show|clone|fetch|pull|stash|remote`,
`npm list|ls|view|outdated`, `npm install|ci|run`, `npx`, `pnpm`, `yarn`, `mkdir`, `md`, `ng *`,
`node archivo.js`, `ollama list`, `gh search`, `code`.

> **Orden de chequeo:** `prohibido` → `seguro` → `peligroso` → `desconocido`.
> Como `curl` y `wget` están en **las dos** listas (`config.js:37-40` y `config.js:65-66`), gana la
> regla de "seguro" y se ejecutan directo. Ver [Limitaciones conocidas](#limitaciones-conocidas).

### 4. Aislamiento de rutas (`acciones.js` → `rutaSegura`)

Todas las acciones de filesystem pasan por `rutaSegura()`, que resuelve la ruta contra `CWD`
(el directorio desde donde se lanzó el programa) y **lanza error si sale del proyecto**.

### Otras defensas

- **Límite de 200 líneas por escritura** (`LIMITE_LINEAS`): `escribir_archivo` y
  `refactorizar_archivo` **no escriben nada** si el contenido excede el límite; devuelven un aviso
  pidiéndole al modelo que parta el trabajo en trozos. Motivo: por encima de ese tamaño los modelos
  locales suelen truncar, inventar código o corromper el archivo.
- **Máximo 15 iteraciones** por turno de usuario.
- **Máximo 3 intentos** de obtener un JSON válido si detectaste que el usuario pidió una acción.
- **Máximo 2 búsquedas** por pregunta (regla del system prompt).
- Doble `Esc` aborta el stream en cualquier momento.

### Verificador de veracidad (fail-closed)

El proyecto incluye un **gate determinístico** (`verificador.js`) que garantiza: **nada llega a pantalla sin estar respaldado por una fuente real**.

- **Registro de fuentes**: `registrarFuente()` guarda el system prompt, la entrada del usuario y todo resultado de acciones (`buscar_web`, `leer_url`, `buscar_github`, `ver_repo`, etc.). Solo lo que está ahí puede usarse para afirmar un dato.
- **Protocolo de citas obligatorio**: cuando el modelo afirma un dato (número, fecha, año, nombre, URL, repo, cantidad...), debe responder exclusivamente con `{"cita": ["fragmento literal exacto de la fuente", "..."]}`. Cada fragmento debe aparecer **carácter por carácter** en alguna fuente registrada.
- **Texto libre solo sin datos**: respuestas conversacionales sin afirmaciones pasan, pero cualquier candidato factual (extraído con `extraerCandidatos`) que no exista en las fuentes **bloquea toda la respuesta**.
- **Bloqueo de evasivas y repetición**: frases como *"no puedo", "no estoy seguro", "podría ser", "te sugiero..."* se detectan y bloquean (`PHRASES_BLOQUEADAS`). También se bloquea si una oración se repite 3 o más veces.
- **Validación de URLs/repos**: `urlVerificada()` y `repoVerificado()` solo permiten usar URLs/repos que **aparecieron previamente** en alguna fuente. Esto evita que el modelo invente enlaces desde cero.
- **Fail-closed**: si no se puede probar, **no se imprime**. Nunca completa de memoria ni "más o menos". Toda verificación es determinística (string match literal, sin heurística).
- **Bufferización del stream**: `index.js` acumula toda la respuesta del modelo **sin imprimir token por token**; solo se muestra después de pasar el verificador. Si falla, el texto nunca llega a stdout.

### Conteo de tokens

El asistente muestra, después de cada respuesta, cuántos tokens se usaron y cuántos quedan disponibles:

```
[asistente] Hola
   [tokens: 48 usados / 32720 restantes (contexto 32768)]
```

- **Fuente de datos**: Ollama devuelve `prompt_eval_count` (tokens de entrada) y `eval_count` (tokens de salida) en `/api/chat` con `stream:false` (`tokens.js` → `chatConStats`).
- **Cálculo**: `tokens usados = prompt_eval_count + eval_count`.
- **Contexto disponible**: se intenta leer del modelo vía `api/show` (`tokens.js` → `obtenerInfoModelo`) buscando campos como `qwen2.context_length`, `llama.context_length` o `general.context_length`. Si no se puede determinar, solo muestra los tokens usados: `[tokens: 48 usados]`.
- **Nota**: al usar `stream:false` para obtener las estadísticas, el tiempo de respuesta puede variar ligeramente respecto a `stream:true`, pero se gana trazabilidad exacta de consumo por turno.

### System prompt

`construirSystemPrompt()` (`index.js:108`) define la personalidad, el formato JSON obligatorio, las
acciones con sus parámetros, las reglas de refactorizado, las de búsqueda, el **Protocolo de
Veracidad** (obligatorio con `{"cita": [...]}`), las reglas de RAG/repositorios y varios
ejemplos. También fuerza explícitamente al modelo a **no negarse a buscar** y a **no inventar
datos**.

---

## Flujo de una acción

1. El modelo responde con un JSON.
2. `parsearAccion()` (`index.js:239`) busca el primer `{`, hace balanceo de llaves y valida que
   existan las claves `accion` y `params`. Es tolerante: acepta JSON rodeado de texto o markdown.
3. `confirmarYEjecutar()` (`index.js:264`) clasifica el comando si es `ejecutar_comando`:
   - `prohibido` → se imprime en rojo y **no se ejecuta**.
   - `seguro` + `SIEMPRE_CONFIRMAR=false` → se ejecuta directo.
   - cualquier otra acción (leer, escribir, borrar, buscar...) → **siempre** pide confirmación.
4. Se muestra la propuesta con un badge de color: `[SEGURO]` verde, `[PELIGROSO]` rojo,
   `[DESCONOCIDO]` amarillo, junto con los params en JSON y la `explicacion` del modelo.
5. Respondés `s` (ejecuta), `n` (rechaza, se informa al modelo como "el usuario RECHAZÓ esta
   acción") o `editar` (pegás tu propio JSON a mano).
6. `ejecutarAccion()` ejecuta y devuelve un string. Si empieza con `ERROR`, se marca `ok: false`.
7. El resultado se inyecta en el historial como un mensaje `user` con prefijo
   `Resultado de la acción "<nombre>":`, y el loop vuelve a darle el turno al modelo.

---

## Configuración

No hay archivo de configuración externo. Los puntos de ajuste son constantes en el código:

| Qué | Dónde | Actual |
|---|---|---|
| Nombre/persona del asistente | `index.js` → `NOMBRE` | `Cristian HERMOSO` |
| Iteraciones por turno | `index.js` → `MAX_ITERACIONES` | `15` |
| Reintentos para obtener JSON | `index.js` → `MAX_INTENTOS_ACCION` | `3` |
| Verbos que disparan el modo "acción" | `index.js` → `VERBOS_ACCION` | ~70 formas (voseo rioplatense) |
| RAG (búsqueda vectorial) | `index.js` → `RAG_ACTIVO` | activo (`MI_ASISTENTE_RAG=0` lo desactiva) |
| Chunks RAG recuperados por pregunta | `index.js` → `RAG_TOP_K` | `6` |
| Límite de líneas por escritura | `acciones.js` → `LIMITE_LINEAS` | `200` |
| Buffer máx. de `exec` | `acciones.js` | 20 MB |
| Confirmar siempre los seguros | `config.js` → `SIEMPRE_CONFIRMAR` | `false` |
| Prompt del sistema | `index.js` → `construirSystemPrompt()` | ver archivo |
| User-Agent / idioma de scraping | `buscar.js` → `UA` y header `Accept-Language` | Chrome 120, `es-AR` |
| Timeout de `curl` | `buscar.js` | 25 s |
| Modelo de embeddings | `vectores.js` → `MODELO` | `Xenova/all-MiniLM-L6-v2` (384 dims) |

### Detección de intención

`detectarIntencion()` (`index.js:349`) busca verbos de acción en el mensaje con un regex que exige
frontera de palabra (incluye tildes y `ñ`). Si encuentra uno pero el modelo contesta en texto plano,
se le repregunta hasta 3 veces con `RECORDATORIO_ACCION`. Es una garantía determinística: no depende
de que el modelo "se porte bien". Además, las órdenes de leer repositorios, archivos y carpetas se
interceptan **antes** de llegar al modelo y se resuelven con código determinístico (`repo.js`,
lectura local, `navegá a ...`).

---

## Dependencias

| Paquete | Versión | Para qué |
|---|---|---|
| [`ollama`](https://www.npmjs.com/package/ollama) | `^0.6.4` | Cliente HTTP + streaming de `chat()` y `abort()` |
| [`chalk`](https://www.npmjs.com/package/chalk) | `^6.0.1` | Colores en terminal (ESM puro, exige Node >= 22) |
| [`@xenova/transformers`](https://www.npmjs.com/package/@xenova/transformers) | `^2.17.2` | Embeddings locales para el RAG (`all-MiniLM-L6-v2`) |
| [`vectra`](https://www.npmjs.com/package/vectra) | `^0.15.0` | Vector store local (índice en `.cache/vectores`) |
| [`tinyglobby`](https://www.npmjs.com/package/tinyglobby) | `^0.2.17` | Glob de archivos para indexar repos y vectores |
| [`ignore`](https://www.npmjs.com/package/ignore) | `^7.0.12` | Respeta los `.gitignore` al indexar |
| [`tree-sitter`](https://www.npmjs.com/package/tree-sitter) + [`tree-sitter-javascript`](https://www.npmjs.com/package/tree-sitter-javascript) | `^0.25.x` | Extracción de símbolos (funciones, clases...) en la indexación de repos |
| [`@vscode/ripgrep`](https://www.npmjs.com/package/@vscode/ripgrep) | `^1.18.0` | Búsqueda de texto en repos indexados |
| [`chokidar`](https://www.npmjs.com/package/chokidar) | `^5.0.0` | Vigilancia de cambios para reindexado incremental |
| [`pdf-parse`](https://www.npmjs.com/package/pdf-parse) | `^2.4.5` | Extracción de texto de PDFs para el RAG |

`ollama` arrastra `whatwg-fetch@^3.6.20` como dependencia transitiva.

Todo lo demás es biblioteca estándar de Node (`child_process`, `fs/promises`, `path`, `readline`,
`util`, `crypto`) o binarios del sistema (`curl.exe`, `gh`, y `sherlock` opcional para
`buscar_usuario`).

---

## Limitaciones conocidas

- **Solo Windows.** `shell: 'cmd.exe'` está hardcodeado en `acciones.js`, `modelos.js` y el
  `UA`/`curl` de `buscar.js` asumen Windows. En Linux/macOS no funciona sin cambios.
- **Sin persistencia.** El `historial` vive en memoria: al reiniciar, el asistente no recuerda nada.
- **El historial crece sin podar.** No hay ventana de contexto ni resumen; en sesiones largas el
  prompt puede desbordar la capacidad del modelo.
- **`curl` / `wget` clasificados dos veces.** Aparecen en `COMANDOS_SEGUROS` y en
  `COMANDOS_PELIGROSOS`. Como los seguros se evalúan primero, ejecutan sin confirmar. Moverlos a
  solo `PELIGROSOS` si querés que siempre pregunten.
- **`rutaSegura()` valida por prefijo de string.** `normalizada.startsWith(CWD)` acepta un hermano
  como `F:\upc\mi-asistente-backup`. Para robustez real alcanza con comparar el separador de ruta:
  `normalizada === CWD || normalizada.startsWith(CWD + path.sep)`.
- **`editar` no revalida.** Después de editar el JSON a mano, la acción se ejecuta sin volver a
  clasificar ni a pedir confirmación. El control queda en vos.
- **Sin permisos ni auditoría.** No hay registro de acciones ejecutadas, ni sandbox, ni usuario sin
  privilegios. No lo uses como root ni en carpetas de datos críticos.
- **El scraping de Bing es frágil.** Depende del HTML de `bing.com`. Si Bing cambia sus clases
  (`b_algo`, `b_lineclamp`, `b_caption`), la búsqueda web cae al fallback de Wikipedia.
- **Páginas con JavaScript no se leen.** Sin navegador headless, el contenido generado en el cliente
  no existe en el HTML descargado. El asistente lo detecta y avisa, pero no lo resuelve.
- **Tests mínimos.** `npm test` corre `node --test` sobre los archivos `*.test.js`
  (`verificador`, `sherlock`, `tokens`, `buscar-personas`). No hay tests de integración del REPL
  ni de `index.js`.
- **Los `.env` / secretos están expuestos.** El modelo lee cualquier archivo del directorio de
  trabajo; no lo lances en repos con credenciales.

---

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `No se pudo ejecutar "ollama list"` | Ollama no está corriendo | `ollama serve` y dejalo en background |
| `No hay modelos instalados` | Sin modelos locales | `ollama pull qwen2.5-coder:7b` |
| `Sin repos para "..."` al buscar en GitHub | `gh` no instalado o sin sesión, o consulta demasiado larga | `gh auth login`, o `gh --version`, o Simplificar la consulta |
| `AVISO: la página ... no tiene texto legible` | Web dinámica (SPA) | Usar los resultados de `buscar_web` o leer la URL vía API |
| `AVISO: "... tendría N líneas y el límite es 200` | Contenido demasiado largo | El modelo debe partir el archivo en trozos; si insiste, subí `LIMITE_LINEAS` |
| `ERROR ejecutando "...": ENOENT` | Ruta inexistente o fuera del proyecto | Verificar con `navegar` o `listar` |
| `BLOQUEADO: comando prohibido por configuración.` | Comando en la lista negra | Ninguna: es intencional |
| Se cuelga o tarda | Modelo grande en CPU | Probar un modelo más chico o usar GPU |
| No corta el streaming | Un solo `Esc` no alcanza | Presionar `Esc Esc` (doble) |
| El modelo no devuelve JSON | Modelo chico que no sigue instrucciones | Usar un modelo con mejores capacidades de instrucción (Qwen2.5-Coder, Llama 3.1, Mistral Nemo) |
