// ============================================================
// RAG LOCAL / VECTOR STORE — BÚSQUEDA SEMÁNTICA INCREMENTAL
// ============================================================
//
// Todo esto es OFFLINE y NO usa Ollama:
//   - Embeddings: @xenova/transformers (transformers.js) con el modelo
//     all-MiniLM-L6-v2 (384 dims). Se descarga UNA vez a .cache/modelos y
//     después corre 100% offline.
//   - Vector store: vectra (LocalIndex, archivos en .cache/vectores).
//
// El indexado es INCREMENTAL: se guarda un hash por archivo en
// .cache/vectores/manifest.json y solo se re-embeben los archivos que
// cambiaron (se borran sus chunks viejos y se insertan los nuevos).
//
// Ollama NO participa acá: este módulo solo produce los chunks relevantes.
// El modelo de chat únicamente redacta la respuesta a partir de ellos.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline, env } from '@xenova/transformers';
import { LocalIndex } from 'vectra';
import { glob } from 'tinyglobby';
import ignore from 'ignore';

const CWD = process.cwd();
const DIR_VECTORES = path.join(CWD, '.cache', 'vectores');
const DIR_MODELOS = path.join(CWD, '.cache', 'modelos');
const ARCHIVO_MANIFEST = path.join(DIR_VECTORES, 'manifest.json');
const MODELO = 'Xenova/all-MiniLM-L6-v2';

// Modelo local, cacheado en el proyecto: 100% offline después de la 1ª vez.
env.cacheDir = DIR_MODELOS;
env.allowLocalModels = true;
env.allowRemoteModels = true;

// Extensiones de texto/código que tiene sentido vectorizar.
const EXTENSIONES = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.php', '.java', '.kt', '.swift', '.cs', '.go', '.rs',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.m', '.scala', '.lua', '.r',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.md', '.markdown', '.txt', '.rst', '.tex',
  '.sh', '.bash', '.ps1', '.psm1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.xml', '.csv', '.tsv'
]);

const IGNORAR_SIEMPRE = ['**/node_modules/**', '**/.git/**', '**/.repos/**', '**/.cache/**'];

// PDF: no es texto plano, así que se le extrae el texto antes de vectorizar.
const EXT_PDF = new Set(['.pdf']);

const MAX_ARCHIVO_BYTES = 150000;
const MAX_ARCHIVO_PDF_BYTES = 20000000;
const MAX_ARCHIVOS = 2000;
const MAX_CHUNKS_POR_ARCHIVO = 300;
const MAX_CHARS_CHUNK = 500;
const SOLAPE_CHARS = 80;

// Subir esto fuerza a reindexar todo (cambió el formato de metadata/chunking).
const VERSION_INDICE = 3;

// ---------- Embeddings locales ----------
let extractorPromise = null;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODELO, { quantized: true });
  }
  return extractorPromise;
}

export async function embed(texto) {
  const extractor = await getExtractor();
  const salida = await extractor(String(texto), { pooling: 'mean', normalize: true });
  return Array.from(salida.data);
}

// ---------- PDF -> texto (offline, pdf-parse v2 / pdfjs) ----------
let pdfModPromise = null;

async function extraerTextoPdf(buf) {
  if (!pdfModPromise) pdfModPromise = import('pdf-parse');
  const { PDFParse } = await pdfModPromise;
  const parser = new PDFParse({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useWasm: false
  });
  try {
    const res = await parser.getText({ pageJoiner: '\n' });
    return res.text || '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ---------- Chunking ----------
// Corta por líneas juntando hasta MAX_CHARS_CHUNK caracteres, con solape.
export function chunkearTexto(contenido) {
  const lineas = String(contenido).replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let buf = [];
  let bufChars = 0;
  let inicio = 1;

  const cerrar = (fin) => {
    if (!buf.length) return;
    const texto = buf.join('\n').trim();
    if (texto) chunks.push({ texto, inicio, fin });
    // Solape: conservar las últimas líneas hasta cubrir SOLAPE_CHARS.
    let acc = 0;
    const solape = [];
    for (let i = buf.length - 1; i >= 0 && acc < SOLAPE_CHARS; i--) {
      solape.unshift(buf[i]);
      acc += buf[i].length + 1;
    }
    buf = solape;
    bufChars = solape.reduce((a, l) => a + l.length + 1, 0);
    inicio = Math.max(1, fin - solape.length + 1);
  };

  for (let i = 0; i < lineas.length; i++) {
    buf.push(lineas[i]);
    bufChars += lineas[i].length + 1;
    if (bufChars >= MAX_CHARS_CHUNK) cerrar(i + 1);
    if (chunks.length >= MAX_CHUNKS_POR_ARCHIVO) break;
  }
  if (buf.length && chunks.length < MAX_CHUNKS_POR_ARCHIVO) {
    const texto = buf.join('\n').trim();
    if (texto) chunks.push({ texto, inicio, fin: lineas.length });
  }
  return chunks;
}

// ---------- Índice vectorial (vectra) ----------
let indexPromise = null;

function getIndex() {
  if (!indexPromise) {
    indexPromise = (async () => {
      await fs.mkdir(DIR_VECTORES, { recursive: true });
      const index = new LocalIndex(DIR_VECTORES, undefined, undefined, undefined, {
        // Para el modo híbrido (BM25): devuelve el texto del chunk a partir de su id.
        docReader: async (id) => {
          const it = await index.getItem(id).catch(() => null);
          return it?.metadata?.texto || '';
        }
      });
      if (!(await index.isIndexCreated())) {
        await index.createIndex({ version: 1 });
      }
      return index;
    })();
  }
  return indexPromise;
}

// ---------- Manifest (indexado incremental) ----------
let manifest = null;

async function cargarManifest() {
  if (manifest) return manifest;
  try {
    manifest = JSON.parse(await fs.readFile(ARCHIVO_MANIFEST, 'utf8'));
  } catch {
    manifest = {};
  }
  return manifest;
}

async function guardarManifest() {
  await fs.mkdir(DIR_VECTORES, { recursive: true });
  await fs.writeFile(ARCHIVO_MANIFEST, JSON.stringify(manifest));
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

function idChunk(dir, rel, i) {
  return `${dir.replace(/\\/g, '/')}::${rel}::${i}`;
}

// ---------- Indexado INCREMENTAL ----------
// Solo re-embebe los archivos cuyo hash cambió. Devuelve un resumen.
export async function indexarVectores(dir, { onProgreso } = {}) {
  await cargarManifest();

  // Si cambió el formato del índice, se borra todo y se reindexa de cero.
  if ((manifest.__version || 0) !== VERSION_INDICE) {
    await fs.rm(DIR_VECTORES, { recursive: true, force: true });
    manifest = { __version: VERSION_INDICE };
    indexPromise = null;
  }

  const index = await getIndex();
  const reg = manifest[dir] || (manifest[dir] = { archivos: {} });
  const previo = reg.archivos;

  const ig = await cargarIgnore(dir);
  const encontrados = await glob('**/*', {
    cwd: dir, dot: false, onlyFiles: true, ignore: IGNORAR_SIEMPRE
  });

  const archivos = [];
  for (const rel of encontrados) {
    if (ig.ignores(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!EXTENSIONES.has(ext) && !EXT_PDF.has(ext)) continue;
    archivos.push(rel);
    if (archivos.length >= MAX_ARCHIVOS) break;
  }

  await index.beginUpdate();
  let nuevos = 0, cambiados = 0;
  const vistos = new Set();

  for (const rel of archivos) {
    const abs = path.join(dir, rel);
    const esPdf = EXT_PDF.has(path.extname(rel).toLowerCase());
    let buf;
    try {
      buf = await fs.readFile(abs);
    } catch {
      continue;
    }
    if (buf.length > (esPdf ? MAX_ARCHIVO_PDF_BYTES : MAX_ARCHIVO_BYTES)) continue;
    vistos.add(rel);

    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    const prev = previo[rel];
    if (prev && prev.hash === hash) {
      reg.archivos[rel] = prev;
      continue;
    }

    // Borrar los chunks viejos de este archivo.
    if (prev && Array.isArray(prev.ids) && prev.ids.length) {
      await index.deleteItems(prev.ids);
    }

    let texto;
    if (esPdf) {
      try {
        texto = await extraerTextoPdf(buf);
      } catch {
        reg.archivos[rel] = { hash, ids: [], chunks: 0 };
        continue;
      }
    } else {
      texto = buf.toString('utf8');
      if (texto.includes('\u0000')) { // binario
        reg.archivos[rel] = { hash, ids: [], chunks: 0 };
        continue;
      }
    }

    const chunks = chunkearTexto(texto);
    const ids = [];
    for (let i = 0; i < chunks.length; i++) {
      const id = idChunk(dir, rel, i);
      const textoChunk = chunks[i].texto;
      const vector = await embed(textoChunk);
      await index.upsertItem({
        id,
        vector,
        metadata: {
          dir,
          ruta: rel,
          inicio: chunks[i].inicio,
          fin: chunks[i].fin,
          texto: textoChunk,
          // Requerido por el modo híbrido BM25 de vectra:
          documentId: id,
          startPos: 0,
          endPos: textoChunk.length - 1
        }
      });
      ids.push(id);
    }
    reg.archivos[rel] = { hash, ids, chunks: ids.length };
    if (prev) cambiados++; else nuevos++;
    onProgreso?.({ ruta: rel, total: Object.keys(previo).length, hechos: nuevos + cambiados });
  }

  let eliminados = 0;
  for (const rel of Object.keys(previo)) {
    if (vistos.has(rel)) continue;
    const prev = previo[rel];
    if (prev && Array.isArray(prev.ids) && prev.ids.length) {
      await index.deleteItems(prev.ids);
    }
    delete previo[rel];
    eliminados++;
  }

  await index.endUpdate();
  reg.actualizado = Date.now();
  await guardarManifest();

  return { dir, archivos: Object.keys(reg.archivos).length, nuevos, cambiados, sinCambios: 0, eliminados, totalChunks: Object.values(reg.archivos).reduce((a, x) => a + (x.chunks || 0), 0) };
}

// ---------- Indexado de UN archivo suelto (por ruta) ----------
// Sirve para "leé F:\carpeta\documento.pdf" aunque no esté en el directorio de trabajo.
// Acepta PDF (extrae texto) y archivos de texto/código.
export async function indexarArchivoVectores(ruta) {
  await cargarManifest();

  if ((manifest.__version || 0) !== VERSION_INDICE) {
    await fs.rm(DIR_VECTORES, { recursive: true, force: true });
    manifest = { __version: VERSION_INDICE };
    indexPromise = null;
  }

  const abs = path.isAbsolute(ruta) ? path.resolve(ruta) : path.resolve(CWD, ruta);
  const dir = path.dirname(abs);
  const rel = path.basename(abs);
  const esPdf = EXT_PDF.has(path.extname(rel).toLowerCase());

  const buf = await fs.readFile(abs);
  if (buf.length > (esPdf ? MAX_ARCHIVO_PDF_BYTES : MAX_ARCHIVO_BYTES)) {
    throw new Error('El archivo es demasiado grande para indexar.');
  }

  const index = await getIndex();
  const reg = manifest[dir] || (manifest[dir] = { archivos: {} });
  const prev = reg.archivos[rel];
  const hash = crypto.createHash('sha1').update(buf).digest('hex');

  if (prev && prev.hash === hash) {
    return { ruta: abs, chunks: prev.chunks || 0, sinCambios: true };
  }

  if (prev && Array.isArray(prev.ids) && prev.ids.length) {
    await index.deleteItems(prev.ids);
  }

  let texto;
  if (esPdf) {
    texto = await extraerTextoPdf(buf);
  } else {
    texto = buf.toString('utf8');
    if (texto.includes('\u0000')) throw new Error('No es un archivo de texto.');
  }
  if (!texto.trim()) throw new Error('No se pudo extraer texto del archivo.');

  const chunks = chunkearTexto(texto);
  const ids = [];
  await index.beginUpdate();
  for (let i = 0; i < chunks.length; i++) {
    const id = idChunk(dir, rel, i);
    const textoChunk = chunks[i].texto;
    const vector = await embed(textoChunk);
    await index.upsertItem({
      id,
      vector,
      metadata: {
        dir,
        ruta: rel,
        inicio: chunks[i].inicio,
        fin: chunks[i].fin,
        texto: textoChunk,
        documentId: id,
        startPos: 0,
        endPos: textoChunk.length - 1
      }
    });
    ids.push(id);
  }
  await index.endUpdate();

  reg.archivos[rel] = { hash, ids, chunks: ids.length };
  reg.actualizado = Date.now();
  await guardarManifest();

  return { ruta: abs, chunks: ids.length, sinCambios: false };
}

// ---------- Búsqueda híbrida (vector + BM25) ----------
function metaDe(r) {
  return {
    dir: r.item.metadata.dir,
    ruta: r.item.metadata.ruta,
    inicio: r.item.metadata.inicio,
    fin: r.item.metadata.fin,
    texto: r.item.metadata.texto
  };
}

export async function buscarSimilares(consulta, { topK = 8, minScore = 0.15 } = {}) {
  const index = await getIndex();
  if (!(await index.isIndexCreated())) return [];
  const stats = await index.getIndexStats().catch(() => null);
  if (!stats || !stats.items) return [];

  const vector = await embed(consulta);
  // isBm25 = true → agrega coincidencias por palabra clave además de las semánticas.
  // Si el índice es muy chico, vectra/wink-bm25 puede fallar: caemos a solo-vector.
  let res;
  try {
    res = await index.queryItems(vector, String(consulta), topK, undefined, true);
  } catch {
    res = await index.queryItems(vector, String(consulta), topK);
  }

  const vistos = new Set();
  const out = [];
  const push = (r, esBm25) => {
    if (vistos.has(r.item.id)) return;
    vistos.add(r.item.id);
    out.push({ ...metaDe(r), score: r.score, bm25: esBm25 });
  };

  const semanticos = res.filter((r) => !r.item.metadata?.isBm25 && r.score >= minScore);
  const bm25 = res.filter((r) => r.item.metadata?.isBm25);

  // Reservamos la mitad de los cupos para coincidencias por palabra clave
  // (nombres de funciones, "Esc", etc.) y el resto para similitud semántica.
  const cupoSem = topK - Math.ceil(topK / 2);
  for (const r of semanticos) {
    if (out.length >= cupoSem) break;
    push(r, false);
  }
  for (const r of bm25) {
    if (out.length >= topK) break;
    push(r, true);
  }
  for (const r of semanticos) {
    if (out.length >= topK) break;
    push(r, false);
  }

  return out.slice(0, topK);
}

export async function statsVectores() {
  const index = await getIndex();
  if (!(await index.isIndexCreated())) return { items: 0 };
  return index.getIndexStats().catch(() => ({ items: 0 }));
}
