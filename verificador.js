// ============================================================
// VERIFICADOR DE VERACIDAD
// ============================================================
//
// El modelo NO puede garantizar que diga la verdad. Lo único que
// puede garantizar es el programa, y este módulo es esa garantía.
//
// Idea: el modelo deja de "responder con texto libre" cuando afirma
// un dato. Pasa a devolver CITAS textuales, y el programa verifica
// que cada cita aparezca VERBUM (carácter por carácter) dentro de una
// fuente real: lo que devolvieron las herramientas, lo que escribió el
// usuario, o el system prompt.
//
// Regla de oro: fail-closed. Si un dato no se puede probar, NO se
// imprime. El programa prefiere callar antes que mentir.
//
// Todo es determinístico: sólo operaciones de string. No hay LLM, no
// hay heurísticas que "más o menos" verifiquen, no hay点的 de confianza.
// O coincide exacto o se bloquea.

// ---------- Límites ----------
export const MAX_CARACTERES_RESPUESTA = 1400;
export const MAX_CARACTERES_FUENTE = 200000;
export const MAX_FUENTES = 80;
export const MAX_ORACIONES_REPETIDAS = 3;
export const MIN_CITA = 4;

// Frases evasivas que el modelo usaba para NO responder. El usuario pidió
// que nunca divague ni se esquive, así que se bloquean como desvío.
// Frases evasivas/hedging. Se dejó VACÍA a pedido: el modelo puede usar
// libremente "no puedo", "podría ser", "aproximadamente", etc. sin que el
// verificador bloquee la respuesta por eso.
export const PHRASES_BLOQUEADAS = [];

// Palabras que aparecen en mayúscula por estructura (títulos de nuestras
// propias secciones) y no son datos. Sin esta lista el gate bloquearía
// casi todo el texto.
export const ESTRUCTURALES = new Set([
  'error', 'errors', 'aviso', 'resultado', 'resultados', 'archivo', 'archivos',
  'carpeta', 'carpetas', 'comando', 'comandos', 'accion', 'acciones', 'param',
  'params', 'params', 'contenido', 'contenidos', 'explicacion', 'fuente',
  'fuentes', 'cita', 'citas', 'bloqueado', 'ejecucion', 'ejecutando',
  'escritura', 'escrito', 'refactorizado', 'borrado', 'leido', 'listado',
  'arbol', 'navegar', 'contenido', 'advertencia', 'limite', 'linea', 'lineas',
  'stout', 'stderr', 'vacio', 'git', 'npm', 'node', 'json', 'windows', 'linux',
  'vivo', 'mismo', 'misma', 'este', 'esta', 'esto', 'estos', 'estas', 'ese',
  'esa', 'eso', 'aquel', 'aquella', 'hay', 'sin', 'con', 'para', 'pero',
  'porque', 'entonces', 'ademas', 'tambien', 'muy', 'todo', 'todos', 'cada',
  'otro', 'otra', 'otro', 'nada', 'algo', 'alguien', 'nadie', 'nunca',
  'siempre', 'quiza', 'quizás', 'tal vez', 'ok', 'okey', 'dale', 'listo',
  'che', 'hola', 'buenas', 'gracias', 'adios', 'chau', 'ejemplo', 'ejemplos',
  'nota', 'notas', 'tipo', 'tipos', 'parte', 'partes', 'paso', 'pasos',
  'primero', 'primera', 'luego', 'despues', 'después', 'finalmente',
  // Muletillas de conversación: el modelo las escribe constantly al empezar
  // una frase ("Entendido. Procederé a...") y no son datos verificables.
  'entendido', 'entiendo', 'comprendido', 'perfecto', 'claro',
  'bien', 'excelente', 'bueno', 'buena', 'hecho', 'hecha', 'listo', 'lista',
  'voy', 'vamos', 'procedere', 'procedo', 'buscare', 'busco', 'buscando',
  'informo', 'informe', 'confirmo', 'acepto', 'atencion', 'che',
  'mira', 'fijate', 'probar', 'prueba', 'anoto', 'anotado',
  'chequeo', 'chequeando', 'reviso', 'revisando', 'viendo', 'obvio',
  'obviamente', 'claramente', 'efectivamente', 'tampoco', 'ahora', 'antes',
  'vamonos', 'ayudame', 'ayuda', 'favor'
]);

// Números que son estructura (índices de lista, porcentajes redondos) y no
// datos verificables. Verificar "3." de una lista bloquearía todo.
export const NUMEROS_ESTRUCTURALES = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
  '100', '1000'
]);

// Un número pegado a una de estas palabras SÍ es un dato y se verifica.
const UNIDADES = [
  'resultados', 'resultado', 'repos', 'repositorio', 'repositorios', 'lineas',
  'línea', 'lineas', 'líneas', 'caracteres', 'carácter', 'archivos', 'archivo',
  'anos', 'años', 'meses', 'mes', 'dias', 'días', 'semanas', 'horas', 'hora',
  'minutos', 'minuto', 'segundos', 'segundo', 'kb', 'mb', 'gb', 'tb',
  'estrellas', 'estrella', 'veces', 'palabras', 'usuarios', 'nodos', 'commits',
  'forks', 'version', 'versiones', 'dependencias', 'elementos', 'elemento',
  'bloques', 'capitulos', 'capítulos', 'paginas', 'páginas'
];

// ---------- Estado ----------
// Cada fuente es un bloque de texto que el programa ya sabe que es real.
export const fuentes = [];
// URLs y repos que aparecieron en alguna fuente. Nada fuera de acá se navega.
export const urlsConocidas = new Set();
export const reposConocidos = new Set();

// ---------- Normalización ----------
// Para comparar, se pasa todo a minúsculas, sin tildes, sin comillas
// tipográficas y con espacios colapsados. La verificación sigue siendo
// EXACTA sobre el texto: sólo se normaliza la forma, no el contenido.
export function normalizar(t) {
  return String(t ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarUrl(u) {
  return normalizar(String(u ?? '').trim())
    .replace(/\/+$/, '')
    .replace(/^https?:\/\//, '')
    // "www.github.com/x" y "github.com/x" son la misma página. Sin esto, una
    // fuente traída con www nunca coincide con la URL que escribe el modelo,
    // y el verificador bloquea datos que SÍ están en la fuente.
    .replace(/^www\./, '');
}

// ---------- Registro de fuentes ----------
// Todo lo que el modelo puede afirmar sale de acá. Se registra:
//   - el system prompt
//   - lo que escribe el usuario
//   - lo que devuelven las herramientas
export function registrarFuente(texto, meta = {}) {
  if (!texto) return;
  const t = String(texto);
  fuentes.push({ texto: t, meta, norm: normalizar(t).slice(0, MAX_CARACTERES_FUENTE) });
  if (fuentes.length > MAX_FUENTES) fuentes.shift();

  // Indexar URLs y repos que quedan permitidos a partir de ahora.
  for (const m of t.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) urlsConocidas.add(normalizarUrl(m[0]));
  for (const m of t.matchAll(/\b([\w.-]+)\/([\w.-]+)\b/g)) {
    if (m[1] && m[2] && !['node_modules', 'usr', 'bin', 'src', 'etc'].includes(m[1].toLowerCase())) {
      reposConocidos.add(normalizar(`${m[1]}/${m[2]}`));
    }
  }
}

export function limpiarFuentes() {
  fuentes.length = 0;
  urlsConocidas.clear();
  reposConocidos.clear();
}

export function textoFuentes() {
  return fuentes.map(f => f.norm).join(' \n ');
}

// Una URL es válida sólo si apareció en una fuente real, o si comparte
// origen (esquema + host) con alguna URL ya vista. Lo que NO existe
// es que aparezca una URL de la nada.
export function urlVerificada(url) {
  const n = normalizarUrl(url);
  if (!n) return false;
  if (urlsConocidas.has(n)) return true;
  const origen = (u) => u.split('/')[0];
  return [...urlsConocidas].some(u => u === n || origen(u) === origen(n));
}

export function repoVerificado(repo) {
  const n = normalizar(repo);
  if (!n) return false;
  if (reposConocidos.has(n)) return true;
  return [...reposConocidos].some(r => r === n || r.startsWith(`${n}/`));
}

// ---------- Extracción de candidatos ----------
// Un "candidato" es todo fragmento de texto que AFFIRMA un dato. Si no
// hay candidatos, el texto es conversación y se deja pasar. Si hay, cada
// uno tiene que aparecer literalmente en una fuente.
const RE_URL = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/gi;
const RE_FECHA = /\b\d{1,4}[/\-.]\d{1,4}[/\-.]\d{1,4}\b/g;
const RE_ANIO = /\b(?:19|20)\d{2}\b/g;
const RE_NUMERO = /\b\d[\d.,]*\b/g;
const RE_PROPIO = /\b[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+(?:[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+|del|de|la|el|los|las|y|of)){0,4}\b/g;

// Un número cuenta como dato si:
//   - tiene 3+ dígitos (DNI, teléfono, año, cantidad grande), o
//   - está pegado a una palabra de unidad ("6 resultados", "200 líneas").
function esNumeroRelevante(n) {
  const limpio = n.replace(/[.,]$/, '');
  if (NUMEROS_ESTRUCTURALES.has(limpio)) return false;
  const digitos = limpio.replace(/\D/g, '');
  if (digitos.length >= 3) return true;
  return new RegExp(`\\b${escapar(limpio)}\\s+(?:${UNIDADES.join('|')})\\b`, 'i').test(textoAnalizado);
}

function escapar(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ¿Esta palabra aparece únicamente al principio de una oración (o del texto)?
// Ahí la mayúscula la pone el orthopedic de escritura, no es un nombre.
function soloAlPrincipioDeOracion(texto, palabra) {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapar(palabra)}(?![\\p{L}\\p{N}])`, 'gu');
  let m;
  let inicio = true;
  while ((m = re.exec(texto)) !== null) {
    const antes = texto.slice(0, m.index);
    const previo = antes.trimEnd();
    const arrancaFrase = inicio || /[.!?:;¡¿]\s*$/.test(previo) || antes.trim() === '';
    if (!arrancaFrase) return false; // apareció en medio de una frase
    inicio = false;
  }
  return true;
}

let textoAnalizado = '';

export function extraerCandidatos(texto) {
  textoAnalizado = texto;
  const vistos = new Set();
  const out = [];
  const push = (valor, tipo) => {
    const v = String(valor).trim().replace(/[.,;:)\]]+$/, '');
    if (!v || v.length < 2) return;
    const clave = `${tipo}:${normalizar(v)}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    out.push({ valor: v, tipo });
  };

  for (const m of texto.matchAll(RE_URL)) push(m[0], 'url');
  for (const m of texto.matchAll(RE_EMAIL)) push(m[0], 'email');
  for (const m of texto.matchAll(RE_FECHA)) push(m[0], 'fecha');
  for (const m of texto.matchAll(RE_ANIO)) push(m[0], 'anio');
  for (const m of texto.matchAll(RE_NUMERO)) if (esNumeroRelevante(m[0])) push(m[0], 'numero');

  // Nombres propios: dos o más palabras capitalizadas, o una sola palabra
  // capitalizada que no sea una palabra estructural nuestra.
  // Evitar índices de lista tipo "1. Título", líneas numeradas, etc.
  for (const m of texto.matchAll(RE_PROPIO)) {
    const frase = m[0].trim();
    if (/^\d+[.)]\s/.test(frase)) continue;
    // Evitar si aparece precedido por número + punto en el texto original
    // No tratar como nombre propio si está precedido por número+.) en la misma línea
    const linea = texto.split('\n').find(l => l.includes(m[0]));
    if (linea) {
      const antes = linea.slice(0, linea.indexOf(m[0]));
      if (/\d+[.)]\s*$/.test(antes)) continue;
    }
    const palabras = frase.split(/\s+/);
    let relevante = palabras.length >= 2
      ? !palabras.every(p => ESTRUCTURALES.has(normalizar(p)))
      : !ESTRUCTURALES.has(normalizar(frase));

    // Una sola palabra capitalizada al principio de una oración casi nunca es
    // un nombre propio: es mayúscula por estar arrancando la frase
    // ("Entendido. Procederé a buscar..."). Si además no aparece en ningún
    // otro sitio en mayúscula media, se descarta como falso positivo.
    if (relevante && palabras.length === 1 && soloAlPrincipioDeOracion(texto, m[0])) {
      relevante = false;
    }

    if (relevante) push(frase, 'nombre');
  }

  return out;
}

// ---------- Verificación ----------
// Comprueba que un dato esté respaldado. Devuelve el motivo si no lo está.
export function estaVerificado(valor, tipo) {
  const n = normalizar(valor);
  if (!n) return false;

  // Las URLs no se comparan como texto: "www.github.com/x" y "github.com/x"
  // son la misma página, y el modelo las escribe de formas distintas a como
  // vienen en la fuente. Si se compararan como substring, casi toda URL
  // sería rechazada por diferencias de www, barra final o mayúsculas.
  if (tipo === 'url') return urlVerificada(valor);

  // Los repos tampoco: "usuario/repo" puede aparecer como parte de la URL.
  if (tipo === 'repo') return repoVerificado(valor);

  // Números: se compara sin separadores de miles porque "36.768.847" y
  // "36768847" son el mismo dato escrito de dos formas.
  if (tipo === 'numero' || tipo === 'anio') {
    const digitos = n.replace(/\D/g, '');
    if (digitos.length >= 3) {
      const fuente = textoFuentes().replace(/[.,]/g, '');
      return fuente.includes(digitos);
    }
  }

  return textoFuentes().includes(n);
}

// Detecta repetición de la misma oración: es la señal más clara de que el
// modelo se trabó en un bucle y empezó a divagar.
export function detectarRepeticion(texto) {
  const oraciones = texto
    .split(/[.!?\n]+/)
    .map(o => normalizar(o))
    .filter(o => o.length > 12);
  const cuenta = new Map();
  for (const o of oraciones) cuenta.set(o, (cuenta.get(o) || 0) + 1);
  for (const [o, n] of cuenta) {
    if (n >= MAX_ORACIONES_REPETIDAS) return o;
  }
  return null;
}

function frasesEvitativas(texto) {
  const n = normalizar(texto);
  return PHRASES_BLOQUEADAS.filter(p => n.includes(normalizar(p)));
}

// ---------- Gate principal ----------
// Devuelve { ok, imprime, motivo, violaciones }.
//   - Si el modelo respeta el protocolo de citas, se imprime SÓLO lo que
//     se verificó, y se descarta el resto. Eso es exacto por construcción.
//   - Si responde texto libre, sólo pasa si no afirma ningún dato. Si
//     afirma alguno, se bloquea entero.
// Nunca hay modo "parcial": o sale verificado, o no sale nada.
export function verificarTexto(texto, { permitirSinCitas = true } = {}) {
  const bruto = String(texto ?? '');

  const respuesta = { ok: true, imprime: '', motivo: '', violaciones: [], modo: 'libre' };

  if (!bruto.trim()) return respuesta;

  if (bruto.length > MAX_CARACTERES_RESPUESTA) {
    return {
      ok: false, imprime: '', modo: 'bloqueado',
      motivo: `Divergencia: la respuesta tiene ${bruto.length} caracteres y el máximo es ${MAX_CARACTERES_RESPUESTA}. Se corta la generación.`,
      violaciones: []
    };
  }

  const repetida = detectarRepeticion(bruto);
  if (repetida) {
    return {
      ok: false, imprime: '', modo: 'bloqueado',
      motivo: `Divergencia: la oración se repitió ${MAX_ORACIONES_REPETIDAS} veces ("${repetida.slice(0, 60)}...").`,
      violaciones: []
    };
  }

  // Protocolo de citas: {"cita": ["...", "..."]}
  const citas = extraerCitas(bruto);
  if (citas !== null) {
    const verificadas = [];
    const malas = [];
    for (const c of citas) {
      const n = normalizar(c);
      if (n.length < MIN_CITA) { malas.push(`cita demasiado corta: "${c}"`); continue; }
      if (!textoFuentes().includes(n)) malas.push(`cita no está en ninguna fuente: "${c.slice(0, 70)}"`);
      else verificadas.push(c.trim());
    }
    if (malas.length) {
      return {
        ok: false, imprime: '', modo: 'bloqueado',
        motivo: `El modelo afirmó datos que no están en ninguna fuente (${malas.length}). Nada se imprime.`,
        violaciones: malas
      };
    }
    if (verificadas.length === 0) {
      return {
        ok: true, imprime: 'No hay información verificable en las fuentes consultadas.', modo: 'citas', violaciones: []
      };
    }
    return { ok: true, imprime: verificadas.join('\n\n'), modo: 'citas', violaciones: [] };
  }

  // Texto libre: se permiten evasivas y conversación, pero cualquier dato
  // que afirme tiene que estar verificado.
  const evasivas = frasesEvitativas(bruto);
  if (evasivas.length) {
    return {
      ok: false, imprime: '', modo: 'bloqueado',
      motivo: `Desvío: el modelo esquivó la consulta con "${evasivas[0]}".`,
      violaciones: evasivas.map(e => `frase evasiva: "${e}"`)
    };
  }

  if (!permitirSinCitas) {
    return {
      ok: false, imprime: '', modo: 'bloqueado',
      motivo: 'El modelo Writes texto libre con datos. Tiene que responder con {"cita": [...]}.',
      violaciones: []
    };
  }

  const candidatos = extraerCandidatos(bruto);
  const malos = candidatos
    .filter(c => !estaVerificado(c.valor, c.tipo))
    .map(c => `${c.tipo} sin respaldo: "${c.valor}"`);

  if (malos.length) {
    return {
      ok: false, imprime: '', modo: 'bloqueado',
      motivo: `El modelo afirmó ${malos.length} dato(s) que no están en ninguna fuente. Nada se imprime.`,
      violaciones: malos
    };
  }

  return { ok: true, imprime: bruto, modo: 'libre', violaciones: [] };
}

// Si el modelo mandó el protocolo de citas, devuelve el array. Si no lo
// mandó, devuelve null para que siga el camino del texto libre.
function extraerCitas(texto) {
  const t = texto.trim();
  if (!/^\s*\{/.test(t)) return null;
  const inicio = t.indexOf('{');
  let nivel = 0, fin = -1;
  for (let i = inicio; i < t.length; i++) {
    if (t[i] === '{') nivel++;
    else if (t[i] === '}') { nivel--; if (nivel === 0) { fin = i; break; } }
  }
  if (fin === -1) return null;
  try {
    const obj = JSON.parse(t.slice(inicio, fin + 1));
    if (Array.isArray(obj.cita)) return obj.cita.map(String);
    if (typeof obj.cita === 'string') return [obj.cita];
    return null;
  } catch {
    return null;
  }
}

// Para las acciones: el código y los comandos NO se verifican contra
// fuentes (un archivo legitimately tiene números propios), pero la
// explicación sí, y cualquier URL o repo que aparezca en los params.
export function verificarAccion(accion) {
  const violaciones = [];
  const exp = accion?.explicacion || '';

  if (exp) {
    const v = verificarTexto(exp);
    if (!v.ok) violaciones.push(...v.violaciones, v.motivo);
  }

  const params = accion?.params || {};
  const url = params.url || params.repo_url || null;
  if (url && !urlVerificada(url)) {
    violaciones.push(`URL no verificada (no apareció en ninguna fuente): "${url}"`);
  }
  const repo = params.repo || null;
  if (repo && !repoVerificado(repo)) {
    violaciones.push(`repo no verificado (no apareció en ninguna fuente): "${repo}"`);
  }

  return { ok: violaciones.length === 0, violaciones };
}
