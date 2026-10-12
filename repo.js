// ============================================================
// LECTURA / INDEXACIÓN DE REPOSITORIOS (local o GitHub)
// ============================================================
//
// Una sola acción para "leer un repositorio":
//   - Si "ruta" es una URL git (https://github.com/usuario/repo.git,
//     git@github.com:usuario/repo.git), clona el repo a .repos/<nombre>
//     y lo indexa desde ahí.
//   - Si "ruta" es una carpeta local (F:\upc\algo), la indexa directo.
//
// Motor: tinyglobby (listar) + ignore (.gitignore) + tree-sitter
// (símbolos) + ripgrep (búsqueda) + chokidar (vigilancia).
//
// El indexado es INCREMENTAL: guarda un hash por archivo en .cache/ y solo
// vuelve a leer/parsear los archivos que cambiaron. La vigilancia mantiene el
// índice al día de forma automática cuando un archivo cambia.
//
// Es solo lectura: no modifica el repo.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import ignore from 'ignore';
import { glob } from 'tinyglobby';
import { rgPath } from '@vscode/ripgrep';
import chokidar from 'chokidar';
import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';

const execFileAsync = promisify(execFile);

const CWD = process.cwd();
const DIR_REPOS = path.join(CWD, '.repos');
const DIR_CACHE = path.join(CWD, '.cache');
const ARCHIVO_CACHE = path.join(DIR_CACHE, 'indice.json');

// Un parser por lenguaje. Solo JS por ahora; agregar acá = agregar soporte.
const PARSERS = {
  '.js': JavaScript,
  '.mjs': JavaScript,
  '.cjs': JavaScript,
  '.jsx': JavaScript
};

const TIPOS_SIMBOLO = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'method_definition'
]);

// Carpetas que nunca se indexan ni se vigilan.
const IGNORAR_ARBOL = new Set([
  'node_modules', '.git', '.repos', '.cache', '.hg', '.svn',
  'venv', '.venv', 'env', '.env', 'virtualenv', 'site-packages',
  'dist', 'build', 'out', 'output', '.next', '.nuxt', '.output',
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', 'bin', 'obj', '.gradle', '.idea', '.vscode-test',
  '.cache', 'tmp', 'temp', 'logs', 'log', '.tmp'
]);

const IGNORAR_SIEMPRE = ['**/node_modules/**', '**/.git/**', '**/.repos/**', '**/.cache/**'];

// ---------- Caché persistente (indexado incremental) ----------
let cache = null;

async function cargarCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(ARCHIVO_CACHE, 'utf8'));
  } catch {
    cache = { repos: {} };
  }
  if (!cache.repos) cache.repos = {};
  return cache;
}

async function guardarCache() {
  await fs.mkdir(DIR_CACHE, { recursive: true });
  await fs.writeFile(ARCHIVO_CACHE, JSON.stringify(cache));
}

function hashContenido(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function esUrlGit(ruta) {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(ruta) || /\.git$/i.test(ruta);
}

function nombreDesdeUrl(url) {
  const limpio = url.replace(/\/+$/, '').replace(/\.git$/i, '');
  const ultima = limpio.split(/[\/:]/).pop() || 'repo';
  return ultima.replace(/[^\w.-]/g, '_');
}

async function resolverCarpeta(ruta) {
  if (!esUrlGit(ruta)) {
    const abs = path.isAbsolute(ruta) ? path.resolve(ruta) : path.resolve(CWD, ruta);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) throw new Error(`No es una carpeta: ${ruta}`);
    return { dir: abs, origen: abs, clonado: false };
  }

  await fs.mkdir(DIR_REPOS, { recursive: true });
  const destino = path.join(DIR_REPOS, nombreDesdeUrl(ruta));
  const yaExiste = await fs.access(path.join(destino, '.git')).then(() => true).catch(() => false);

  if (yaExiste) {
    try {
      await execFileAsync('git', ['-C', destino, 'pull', '--depth', '1', '--ff-only'], { timeout: 60000 });
    } catch { /* se usa lo que ya está */ }
  } else {
    await execFileAsync('git', ['clone', '--depth', '1', ruta, destino], { timeout: 180000 });
  }

  return { dir: destino, origen: ruta, clonado: true };
}

async function cargarIgnore(dir) {
  const ig = ignore();
  for (const f of ['.gitignore', '.ignore', '.repomixignore']) {
    try {
      ig.add(await fs.readFile(path.join(dir, f), 'utf8'));
    } catch { /* no existe */ }
  }
  return ig;
}

function parserPara(ext) {
  const lang = PARSERS[ext];
  if (!lang) return null;
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

function extraerSimbolos(codigo, parser) {
  const out = [];
  let arbol;
  try {
    arbol = parser.parse(codigo);
  } catch {
    return out;
  }
  const visitar = (nodo) => {
    if (TIPOS_SIMBOLO.has(nodo.type)) {
      const nombre = nodo.childForFieldName('name');
      if (nombre) out.push(`${nodo.type.replace('_declaration', '').replace('_definition', '')} ${nombre.text}`);
    } else if (nodo.type === 'variable_declarator') {
      const valor = nodo.childForFieldName('value');
      if (valor && (valor.type === 'arrow_function' || valor.type === 'function_expression')) {
        const nombre = nodo.childForFieldName('name');
        if (nombre) out.push(`function ${nombre.text}`);
      }
    }
    for (const hijo of nodo.children) visitar(hijo);
  };
  visitar(arbol.rootNode);
  return out;
}

// Analiza un archivo y devuelve su entrada de índice.
async function analizarArchivo(abs, rel) {
  const buf = await fs.readFile(abs);
  const ext = path.extname(rel).toLowerCase();
  const parser = parserPara(ext);
  if (parser) {
    const codigo = buf.toString('utf8');
    return {
      hash: hashContenido(buf),
      size: buf.length,
      lines: codigo.split('\n').length,
      symbols: extraerSimbolos(codigo, parser),
      lenguaje: true
    };
  }
  return { hash: hashContenido(buf), size: buf.length, lines: 0, symbols: [], lenguaje: false };
}

// ---------- Indexado INCREMENTAL ----------
// Solo relee/parsea los archivos cuyo hash cambió. Devuelve un resumen.
export async function indexarIncremental(dir, { maxArchivos = 3000, maxSimbolos = 300 } = {}) {
  await cargarCache();
  const reg = cache.repos[dir] || (cache.repos[dir] = { archivos: {} });
  const previo = reg.archivos || {};

  const ig = await cargarIgnore(dir);
  const encontrados = await glob('**/*', {
    cwd: dir, dot: false, onlyFiles: true, ignore: IGNORAR_SIEMPRE
  });
  const archivos = encontrados.filter((rel) => !ig.ignores(rel)).slice(0, maxArchivos);

  const actual = {};
  let nuevos = 0, cambiados = 0, sinCambios = 0;

  for (const rel of archivos) {
    const abs = path.join(dir, rel);
    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }
    const h = hashContenido(buf);
    const prev = previo[rel];
    if (prev && prev.hash === h) {
      actual[rel] = prev;
      sinCambios++;
    } else {
      try {
        actual[rel] = await analizarArchivo(abs, rel);
        if (prev) cambiados++; else nuevos++;
      } catch { /* ilegible: se salta */ }
    }
  }

  let eliminados = 0;
  for (const rel of Object.keys(previo)) if (!(rel in actual)) eliminados++;

  reg.archivos = actual;
  reg.actualizado = Date.now();
  await guardarCache();

  // Resumen
  const porExt = new Map();
  const simbolos = [];
  let totalLineas = 0;
  let conCodigo = 0;

  for (const rel of archivos) {
    const e = actual[rel];
    if (!e) continue;
    const ext = path.extname(rel).toLowerCase() || '(sin extensión)';
    porExt.set(ext, (porExt.get(ext) || 0) + 1);
    totalLineas += e.lines || 0;
    if (e.lenguaje) conCodigo++;
    if (e.symbols && e.symbols.length && simbolos.length < maxSimbolos) {
      const libres = maxSimbolos - simbolos.length;
      simbolos.push({ archivo: rel, lista: e.symbols.slice(0, Math.min(12, libres)) });
    }
  }

  return {
    dir,
    archivos: archivos.length,
    detectados: encontrados.length,
    porExt: [...porExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    simbolos,
    totalLineas,
    conCodigo,
    nuevos, cambiados, sinCambios, eliminados
  };
}

// ---------- Vigilancia (reindexado automático) ----------
const VIGILANTES = new Map();

export function cerrarVigilantes() {
  const cierres = [];
  for (const w of VIGILANTES.values()) cierres.push(w.close());
  VIGILANTES.clear();
  return Promise.all(cierres);
}

// Observa 'dir' y mantiene el índice al día solo. onEvento recibe {tipo, archivo}.
export async function vigilarRepo(dir, onEvento) {
  if (VIGILANTES.has(dir)) return VIGILANTES.get(dir);

  await cargarCache();
  const ig = await cargarIgnore(dir);

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    ignored: (p) => IGNORAR_ARBOL.has(path.basename(p).toLowerCase())
  });

  const actualizar = async (abs, tipo) => {
    const rel = path.relative(dir, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return;
    if (tipo !== 'unlink' && ig.ignores(rel)) return;

    const reg = cache.repos[dir] || (cache.repos[dir] = { archivos: {} });
    reg.archivos = reg.archivos || {};

    if (tipo === 'unlink') {
      delete reg.archivos[rel];
    } else {
      try {
        const entrada = await analizarArchivo(abs, rel);
        const prev = reg.archivos[rel];
        if (prev && prev.hash === entrada.hash) return; // sin cambios reales
        reg.archivos[rel] = entrada;
      } catch {
        return;
      }
    }
    reg.actualizado = Date.now();
    await guardarCache();
    onEvento?.({ tipo, archivo: rel, dir });
  };

  watcher.on('add', (p) => actualizar(p, 'add'));
  watcher.on('change', (p) => actualizar(p, 'change'));
  watcher.on('unlink', (p) => actualizar(p, 'unlink'));

  VIGILANTES.set(dir, watcher);
  return watcher;
}

// ---------- Búsqueda por chunks (ripgrep) ----------
export async function buscarEnRepo(dir, consulta, { limite = 60 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(rgPath, [
      '--json', '-i',
      '-g', '!node_modules', '-g', '!.git',
      '--max-count', '3',
      '-e', String(consulta),
      dir
    ]);
    let salida = '';
    proc.stdout.on('data', (d) => { salida += d; });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const hits = [];
      let buffer = salida;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const linea = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!linea) continue;
        let m;
        try { m = JSON.parse(linea); } catch { continue; }
        if (m.type !== 'match') continue;
        const archivo = path.relative(dir, m.data.path.text).replace(/\\/g, '/');
        const txt = (m.data.lines?.text || '').trim().slice(0, 160);
        hits.push(`${archivo}:${m.data.line_number}: ${txt}`);
        if (hits.length >= limite) break;
      }
      resolve(hits);
    });
  });
}

// ---------- Resumen del proyecto (README + package.json) ----------
// Sirve para que el modelo pueda decir DE QUÉ TRATA el proyecto sin inventar.
export async function resumenProyecto(dir) {
  const lineas = [];

  // README (cualquier casing: README.md, readme.txt, Readme...)
  let readme = null;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const hit = entries.find((e) => e.isFile() && /^readme(\.|$)/i.test(e.name));
    if (hit) readme = hit.name;
  } catch { /* sin permiso */ }

  if (readme) {
    try {
      const txt = (await fs.readFile(path.join(dir, readme), 'utf8')).trim();
      const recorte = txt.length > 4000 ? txt.slice(0, 4000) + '\n...(recortado)' : txt;
      lineas.push(`README "${readme}":`);
      for (const l of recorte.split('\n').slice(0, 120)) lineas.push(`  ${l}`);
    } catch { /* ilegible */ }
  }

  // package.json
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    const partes = [];
    if (pkg.name) partes.push(`name=${pkg.name}`);
    if (pkg.version) partes.push(`version=${pkg.version}`);
    if (pkg.description) partes.push(`description=${pkg.description}`);
    if (pkg.type) partes.push(`type=${pkg.type}`);
    if (pkg.main) partes.push(`main=${pkg.main}`);
    if (partes.length) lineas.push(`package.json: ${partes.join('  ')}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length) {
      lineas.push(`scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    }
    const deps = Object.keys(pkg.dependencies || {});
    if (deps.length) lineas.push(`dependencies: ${deps.join(', ')}`);
  } catch { /* no hay package.json */ }

  return lineas;
}

// ---------- Lectura principal ----------
// Devuelve { dir, salida, resumen }. La salida es texto listo para el asistente.
export async function leerRepoConDir({ ruta, url, repo, buscar = null, maxArchivos = 3000, maxSimbolos = 300 }) {
  const objetivo = String(ruta || url || repo || '').trim();
  if (!objetivo) throw new Error('Falta el parámetro "ruta" (carpeta local o URL git).');

  const { dir, origen, clonado } = await resolverCarpeta(objetivo);
  const r = await indexarIncremental(dir, { maxArchivos, maxSimbolos });

  const lineas = [];
  lineas.push(`REPOSITORIO LEÍDO (indexado incremental)`);
  lineas.push(`Origen: ${origen}`);
  lineas.push(`Carpeta local: ${dir}${clonado ? '  (clonado)' : ''}`);
  lineas.push(`Archivos indexados: ${r.archivos} de ${r.detectados} detectados`);
  lineas.push(`Archivos con código analizable: ${r.conCodigo}  |  Líneas de código: ${r.totalLineas}`);
  lineas.push(`Tipos de archivo: ${r.porExt.map(([e, n]) => `${e}=${n}`).join('  ')}`);
  lineas.push(`Incremental: nuevos=${r.nuevos}  cambiados=${r.cambiados}  sin cambios=${r.sinCambios}  eliminados=${r.eliminados}`);

  const resumenProy = await resumenProyecto(dir);
  if (resumenProy.length) {
    lineas.push('');
    lineas.push('RESUMEN DEL PROYECTO (usalo para describir de qué trata):');
    for (const l of resumenProy) lineas.push(l);
  }

  if (r.simbolos.length) {
    lineas.push('');
    lineas.push(`SÍMBOLOS (funciones/clases/métodos), hasta ${maxSimbolos}:`);
    for (const { archivo, lista } of r.simbolos) {
      lineas.push(`  ${archivo}: ${lista.join(', ')}`);
    }
  }

  if (buscar) {
    const hits = await buscarEnRepo(dir, String(buscar));
    lineas.push('');
    lineas.push(`BÚSQUEDA "${buscar}" (${hits.length} coincidencias):`);
    for (const h of hits) lineas.push(`  ${h}`);
  }

  const salida = lineas.join('\n');
  return { dir, salida: salida.length > 30000 ? salida.slice(0, 30000) + '\n...(truncado)' : salida, resumen: r };
}

// Devuelve solo el texto (lo usa la acción leer_repo de acciones.js).
export async function leerRepo(params) {
  return (await leerRepoConDir(params)).salida;
}

// ---------- Árbol de carpetas / archivos (equivale a "tree /f") ----------
export async function arbolRepo({ ruta, profundidad = 10, ignorar = [] } = {}) {
  const objetivo = String(ruta || '').trim() || CWD;
  const dir = path.isAbsolute(objetivo) ? path.resolve(objetivo) : path.resolve(CWD, objetivo);
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error(`No es una carpeta: ${objetivo}`);

  const excluidas = new Set([...IGNORAR_ARBOL, ...ignorar.map(x => String(x).toLowerCase())]);
  const lineas = [dir];
  let totalDir = 0;
  let totalArch = 0;

  async function walk(current, prefijo, nivel) {
    if (nivel > profundidad) return;
    let items;
    try {
      items = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    items = items
      .filter(i => !(i.isDirectory() && excluidas.has(i.name.toLowerCase())))
      .sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const ultimo = i === items.length - 1;
      lineas.push(`${prefijo}${ultimo ? '└── ' : '├── '}${it.name}${it.isDirectory() ? '/' : ''}`);
      if (it.isDirectory()) {
        totalDir++;
        await walk(path.join(current, it.name), prefijo + (ultimo ? '    ' : '│   '), nivel + 1);
      } else {
        totalArch++;
      }
    }
  }

  await walk(dir, '', 1);

  const cabecera = `ESTRUCTURA DE CARPETAS Y ARCHIVOS (sin node_modules, .git, venv y similares)`;
  const pie = `\nDirectorios: ${totalDir}  Archivos: ${totalArch}`;
  const salida = `${cabecera}\n${lineas.join('\n')}${pie}`;
  return salida.length > 30000 ? salida.slice(0, 30000) + '\n...(truncado)' : salida;
}
