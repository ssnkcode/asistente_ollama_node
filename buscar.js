import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function curl(url, opciones = {}) {
  const flags = [
    '-s', '-m', '25',
    '-A', `"${UA}"`,
    '-H', '"Accept-Language: es-AR,es;q=0.9,en;q=0.8"',
    url
  ];
  if (opciones.post) flags.unshift('-X', 'POST', '-d', opciones.post);
  const { stdout } = await execAsync(`curl.exe ${flags.join(' ')}`, { maxBuffer: 1024 * 1024 * 20 });
  return stdout;
}

const ENTIDADES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&aacute;': 'á', '&eacute;': 'é',
  '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ',
  '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó',
  '&Uacute;': 'Ú', '&Ntilde;': 'Ñ', '&uuml;': 'ü', '&hellip;': '…',
  '&middot;': '·', '&laquo;': '«', '&raquo;': '»', '&copy;': '©',
  '&reg;': '®', '&deg;': '°', '&euro;': '€', '&quot;': '"', '&#x27;': "'"
};

function decodificar(texto) {
  return texto
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;|&#\d+;/gi, m => ENTIDADES[m.toLowerCase()] ?? m);
}

function quitarTags(html) {
  return decodificar(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Bing envuelve los links en bing.com/ck/a?...&u=a1<base64>
function destaparUrlBing(hrefCrudo) {
  if (!hrefCrudo) return null;
  const href = decodificar(hrefCrudo);
  const m = href.match(/[?&]u=a1([A-Za-z0-9+/=_-]+)/);
  if (!m) return href.startsWith('http') ? href : null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

function parsearBing(html, limite) {
  const resultados = [];
  const bloques = html.split('<li class="b_algo"').slice(1, limite + 1);

  for (const bloque of bloques) {
    const h2 = bloque.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;

    const hrefRaw = h2[1].match(/href="([^"]+)"/);
    const url = destaparUrlBing(hrefRaw ? hrefRaw[1] : null);
    const titulo = quitarTags(h2[1]);
    if (!url || !titulo) continue;

    const cita = bloque.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
    const parrafo = bloque.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      || bloque.match(/<div class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);

    resultados.push({
      titulo,
      url,
      dominio: cita ? quitarTags(cita[1]) : '',
      snippet: parrafo ? quitarTags(parrafo[1]) : ''
    });
  }
  return resultados;
}

function parsearWikipedia(json) {
  const out = [];
  if (json.AbstractText) {
    out.push({
      titulo: json.Heading || json.AbstractSource || 'Wikipedia',
      url: json.AbstractURL || '',
      snippet: json.AbstractText,
      fuente: 'wikipedia'
    });
  }
  for (const r of (json.RelatedTopics || []).slice(0, 5)) {
    if (!r.Text) continue;
    out.push({
      titulo: r.Text.split(' - ')[0],
      url: r.FirstURL || '',
      snippet: r.Text.split(' - ').slice(1).join(' - ') || r.Text,
      fuente: 'wikipedia-relacionado'
    });
  }
  return out;
}

function formatear(consulta, resultados, motor) {
  if (resultados.length === 0) {
    return `Sin resultados para "${consulta}" (motor: ${motor}). Probá reformular la consulta.`;
  }
  const lineas = resultados.map((r, i) => {
    const parts = [`${i + 1}. ${r.titulo}`];
    if (r.url) parts.push(`   URL: ${r.url}`);
    if (r.dominio) parts.push(`   Sitio: ${r.dominio}`);
    if (r.snippet) parts.push(`   ${r.snippet}`);
    return parts.join('\n');
  });
  return `Resultados de "${consulta}" (${motor}, ${resultados.length} resultados):\n\n${lineas.join('\n\n')}`;
}

// ---------- Búsqueda web general ----------
export async function buscarWeb({ consulta, limite = 6 }) {
  if (!consulta) throw new Error('Falta el parámetro "consulta"');
  const q = encodeURIComponent(consulta);

  // 1) Bing ( scrape del HTML ya parseado )
  try {
    const html = await curl(`"https://www.bing.com/search?q=${q}&count=${limite}&setlang=es"`);
    const resultados = parsearBing(html, limite);
    if (resultados.length > 0) return formatear(consulta, resultados, 'bing');
    throw new Error('Bing no devolvió resultados parseables');
  } catch (errBing) {
    // 2) Wikipedia como fallback
    try {
      const json = JSON.parse(await curl(`"https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(consulta)}"`));
      if (json.extract) {
        return `Resumen de Wikipedia sobre "${consulta}":\n\n${json.extract}\n\nFuente: ${json.content_urls?.desktop?.page || ''}`;
      }
    } catch { /* cae al último recurso */ }

    return `No se pudo buscar "${consulta}". Bing falló (${errBing.message}) y Wikipedia no tiene ese artículo.`;
  }
}

// GitHub exige que aparezcan TODAS las palabras, así que una consulta larga
// ("ecommerce html css javascript node.js") devuelve cero. Acá se sacan las
// palabras vacías y los lenguajes (que van como filtro --language), y se
// generan consultas cada vez más cortas hasta juntar resultados.
const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o',
  'en', 'con', 'para', 'por', 'que', 'es', 'son', 'al', 'a', 'the', 'of', 'and',
  'with', 'for', 'in', 'on', 'to', 'project', 'proyecto', 'app', 'aplicacion',
  'repositorio', 'repo', 'completo', 'full', 'basico', 'básico', 'simple'
]);

const LENGUAJES = [
  { re: /^(html|css)$/i, gh: null }, // html/css no tienen filtro directo, se ignoran
  { re: /^(javascript|js|node\.?js|node)$/i, gh: 'javascript' },
  { re: /^(typescript|ts)$/i, gh: 'typescript' },
  { re: /^react(\.js)?$/i, gh: 'javascript' },
  { re: /^vue(\.js)?$/i, gh: 'vue' },
  { re: /^angular$/i, gh: 'typescript' },
  { re: /^python$/i, gh: 'python' },
  { re: /^(php|laravel)$/i, gh: 'php' },
  { re: /^java$/i, gh: 'java' },
  { re: /^(c#|csharp|\.net)$/i, gh: 'c#' },
  { re: /^(go|golang)$/i, gh: 'go' },
  { re: /^rust$/i, gh: 'rust' }
];

function generarVariantes(consulta) {
  const palabras = consulta.replace(/["']/g, '').split(/\s+/).filter(Boolean);
  let lenguajes = [];

  for (const p of palabras) {
    const encontrado = LENGUAJES.find(l => l.re.test(p));
    if (encontrado && encontrado.gh && !lenguajes.includes(encontrado.gh)) {
      lenguajes.push(encontrado.gh);
    }
  }

  const clave = palabras.filter(p => !STOPWORDS.has(p.toLowerCase()) && !LENGUAJES.some(l => l.re.test(p)));
  // Si no quedó nada, usar todas menos las vacías
  const base = clave.length ? clave : palabras.filter(p => !STOPWORDS.has(p.toLowerCase()));

  const queries = [];
  if (clave.length === 0) {
    queries.push(palabras.join(' '));
  } else {
    queries.push(clave.join(' '));
    if (clave.length > 1) queries.push(clave.slice(0, 2).join(' '));
    queries.push(clave[0]);
  }

  // Combinar cada consulta con el filtro de lenguaje detectado
  const variantes = [];
  for (const q of queries) {
    if (lenguajes[0]) variantes.push({ q, lang: lenguajes[0] });
    variantes.push({ q, lang: null });
  }
  return variantes;
}

async function ghSearch(consulta, limite, lang = null) {
  const langFlag = lang ? ` --language=${JSON.stringify(lang)}` : '';
  const { stdout } = await execAsync(
    `gh search repos ${JSON.stringify(consulta)}${langFlag} --limit ${Number(limite) || 5} --json fullName,description,url,stargazersCount,language,updatedAt`,
    { maxBuffer: 1024 * 1024 * 10 }
  );
  return JSON.parse(stdout || '[]');
}

// Puntúa qué tan relevante es un repo para la consulta: primero por las
// palabras que pidió el usuario, después por estrellas. Sin esto, un repo de
// Django con 2361★ le gana a uno de Node.js de 800★ que sí era lo pedido.
function puntuar(repo, palabrasClave) {
  const nombre = (repo.fullName || '').toLowerCase();
  const desc = (repo.description || '').toLowerCase();
  const lang = (repo.language || '').toLowerCase();

  let puntos = 0;
  for (const p of palabrasClave) {
    const variantes = [p, p.replace(/\.js$/, ''), p.replace(/\.js$/, '') + 'js'];
    for (const v of variantes) {
      if (new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(nombre)) { puntos += 4; break; }
    }
    if (new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(desc)) puntos += 2;
    if (lang.includes(p.toLowerCase().replace(/\.js$/, ''))) puntos += 1;
  }
  return puntos * 1000 + (repo.stargazersCount || 0);
}

// ---------- Repos de GitHub ----------
export async function buscarGithub({ consulta, limite = 5 }) {
  if (!consulta) throw new Error('Falta el parámetro "consulta"');
  const tope = Number(limite) || 5;

  const palabras = consulta.replace(/["']/g, '').split(/\s+/).filter(Boolean);
  const clave = palabras.filter(p => !STOPWORDS.has(p.toLowerCase()) && !LENGUAJES.some(l => l.re.test(p)));

  const probadas = [];
  let repos = [];

  // Se prueba la consulta más específica y, si no da nada, se va relajando.
  // En cuanto una devuelve resultados, se usa ESA (no se mezclan varias).
  for (const { q, lang } of generarVariantes(consulta)) {
    probadas.push(lang ? `${q} (language:${lang})` : q);
    try {
      repos = await ghSearch(q, tope, lang);
    } catch {
      continue;
    }
    if (repos.length > 0) break;
  }

  if (repos.length === 0) {
    return `Sin repos para "${consulta}". Probé: ${probadas.join(' | ')}. Probá con menos palabras.`;
  }

  // Ordenar por relevancia a la consulta, no solo por estrellas
  const ordenados = [...repos]
    .sort((a, b) => puntuar(b, clave.length ? clave : palabras) - puntuar(a, clave.length ? clave : palabras))
    .slice(0, tope);

  const lineas = ordenados.map((r, i) =>
    `${i + 1}. ${r.fullName}  (${r.stargazersCount} ★, ${r.language || 'n/d'})\n` +
    `   ${r.url}\n` +
    `   ${r.description || '(sin descripción)'}`
  );
  return `Repos de GitHub para "${consulta}":\n\n${lineas.join('\n\n')}`;
}

export async function verRepo({ repo }) {
  if (!repo) throw new Error('Falta el parámetro "repo"');
  try {
    const { stdout } = await execAsync(
      `gh repo view ${JSON.stringify(repo)} --json nameWithOwner,description,url,stargazerCount,primaryLanguage,licenseInfo,pushedAt,homepageUrl`
    );
    const r = JSON.parse(stdout);
    return `Repo: ${r.nameWithOwner}
URL: ${r.url}
Web: ${r.homepageUrl || '(ninguna)'}
★: ${r.stargazerCount}  |  Lenguaje: ${r.primaryLanguage?.name || 'n/d'}  |  Licencia: ${r.licenseInfo?.spdxId || 'ninguna'}
Último push: ${r.pushedAt}
Descripción: ${r.description || '(ninguna)'}

Para clonarlo: git clone ${r.url}.git`;
  } catch (err) {
    return `Error consultando el repo: ${err.message}`;
  }
}

// ---------- Páginas de GitHub ----------
const RESERVADOS_GH = new Set([
  'orgs', 'users', 'topics', 'search', 'features', 'about', 'pricing',
  'marketplace', 'sponsors', 'settings', 'notifications', 'explore',
  'trending', 'collections', 'events', 'apps', 'login', 'signup', 'site'
]);

// github.com/usuario/repo → { owner, repo }  |  null si no es un repo
function parsearRepoGithub(url) {
  const m = url.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i);
  if (!m) return null;
  if (RESERVADOS_GH.has(m[1].toLowerCase())) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

// Saca badges, imágenes y HTML del markdown del README
function limpiarMarkdown(md) {
  return decodificar(
    md
      .replace(/<img[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // imágenes markdown
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ') // badges clickeables
      .replace(/^\s*\[[^\]]+\]:\s*\S+\s*$/gm, ' ')     // definiciones de link
      .replace(/^\s*[-=]{3,}\s*$/gm, '')
  )
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter(l => l && !/^(https?:\/\/\S+)$/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function leerRepoGithub(url, limite) {
  const { owner, repo } = parsearRepoGithub(url);

  const [infoRaw, readmeRaw] = await Promise.all([
    execAsync(`gh api repos/${owner}/${repo} --jq "{n:.full_name,d:.description,s:.stargazers_count,f:.forks_count,l:.language,u:.html_url,c:.clone_url,h:(.homepage//\\"\\"),lic:(.license.spdx_id//\\"ninguna\\"),p:.pushed_at}"`)
      .then(r => JSON.parse(r.stdout))
      .catch(() => null),
    execAsync(`gh api repos/${owner}/${repo}/readme -H "Accept: application/vnd.github.raw"`)
      .then(r => r.stdout)
      .catch(() => '')
  ]);

  const partes = [];
  if (infoRaw) {
    partes.push(
      `Repo: ${infoRaw.n}\n` +
      `URL: ${infoRaw.u}\n` +
      `★ ${infoRaw.s}  |  Forks: ${infoRaw.f}  |  Lenguaje: ${infoRaw.l || 'n/d'}  |  Licencia: ${infoRaw.lic}\n` +
      `Último push: ${infoRaw.p}\n` +
      `Descripción: ${infoRaw.d || '(ninguna)'}\n` +
      `Clonar: git clone ${infoRaw.c}`
    );
  }

  const readme = readmeRaw ? limpiarMarkdown(readmeRaw) : '';
  if (readme) {
    const recorte = readme.slice(0, Math.max(500, limite - 700));
    partes.push(`README:\n${recorte}${readme.length > recorte.length ? '\n[...readme recortado]' : ''}`);
  }

  if (partes.length === 0) {
    return `No se pudo leer el repo ${owner}/${repo} con gh. Verificá que exista y que estés logueado (gh auth login).`;
  }

  return `Contenido de ${url} (extraído limpio con gh, sin el HTML de GitHub):\n\n${partes.join('\n\n')}`;
}

// ---------- Leer una URL y devolver texto limpio ----------
export async function leerUrl({ url, limite = 4000 }) {
  if (!url) throw new Error('Falta el parámetro "url"');
  if (!/^https?:\/\//i.test(url)) return `URL inválida: ${url}`;

  // Los repos de GitHub se leen con la API, no scrapeando la página
  if (parsearRepoGithub(url)) {
    return leerRepoGithub(url, limite);
  }

  const html = await curl(`"${url}"`);

  // Si hay <main> o <article>, quedarse solo con eso (evita menús y footers)
  const cuerpo = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    || html;

  let texto = cuerpo
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]*>/g, '\n');

  texto = decodificar(texto)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  if (texto.length < 40) {
    return `AVISO: la página ${url} no tiene texto legible (cargó vacía o es dinámica/JavaScript).
No insistas con esta URL. Si ya tenés resultados de una búsqueda, respondé con ESA información.`;
  }

  const recortado = texto.slice(0, limite);
  const sufijo = texto.length > limite ? `\n\n[...recortado en ${limite} caracteres, el original tenía ${texto.length}]` : '';
  return `Contenido de ${url}:\n\n${recortado}${sufijo}`;
}