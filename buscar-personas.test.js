import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extraerNombre,
  esConsultaDePersona,
  normalizarNombreParaBusqueda,
  consultaPorSitio,
  hostCoincide,
  palabrasClave,
  filtrarPorRelevancia,
  SITIOS_PERFIL,
  formatearPersona
} from './buscar.js';

// ---------- Detección de consulta de persona ----------

test('extrae nombre y apellido tal cual', () => {
  assert.equal(extraerNombre('Cristian Sasinka'), 'Cristian Sasinka');
  assert.equal(extraerNombre('Juan Perez Lopez'), 'Juan Perez Lopez');
});

test('ignora los verbos que agrega el modelo', () => {
  assert.equal(extraerNombre('buscar a Cristian Sasinka'), 'Cristian Sasinka');
  assert.equal(extraerNombre('quién es Juan Perez Lopez'), 'Juan Perez Lopez');
  assert.equal(extraerNombre('información sobre Maria Gomez'), 'Maria Gomez');
});

test('se queda con el nombre aunque la consulta tenga contexto de lugar', () => {
  assert.equal(
    extraerNombre('buscar a Cristian Sasinka en Cordoba Argentina'),
    'Cristian Sasinka'
  );
});

test('saca los verbos aunque estén en minúscula', () => {
  assert.equal(extraerNombre('buscar a Juan Perez'), 'Juan Perez');
  assert.equal(extraerNombre('coder de datos Juan Perez Lopez'), 'Juan Perez Lopez');
});

test('NO es persona si tiene un solo nombre', () => {
  assert.equal(esConsultaDePersona('Cristian'), false);
});

test('NO es persona si la consulta tiene dígitos', () => {
  assert.equal(esConsultaDePersona('DNI 36768847 Argentina titular'), false);
  assert.equal(esConsultaDePersona('Cristian 1980'), false);
});

test('NO es persona si es una pregunta general', () => {
  assert.equal(esConsultaDePersona('capital de Australia'), false);
  assert.equal(esConsultaDePersona('precio del dolar'), false);
  assert.equal(esConsultaDePersona(''), false);
});

test('es persona con y sin tilde, y con guion', () => {
  assert.equal(esConsultaDePersona('María José López'), true);
  assert.equal(esConsultaDePersona('Ana-María Ruiz'), true);
});

// ---------- Consulta con site: y comillas ----------

test('arma la consulta con site: y comillas exactas', () => {
  assert.equal(
    consultaPorSitio('Cristian Sasinka', 'github.com'),
    'site:github.com "Cristian Sasinka"'
  );
});

test('armilla consulta para cualquier plataforma de la lista', () => {
  for (const sitio of SITIOS_PERFIL) {
    assert.match(consultaPorSitio('Juan Perez', sitio.dominio), /^site:\S+ "Juan Perez"$/);
  }
});

test('la lista de sitios es genérica, sin nombres hardcodeados', () => {
  assert.ok(SITIOS_PERFIL.length >= 20, 'debería cubrir al menos 20 plataformas');
  const etiquetas = SITIOS_PERFIL.map(s => s.etiqueta).join(' ').toLowerCase();
  assert.ok(!etiquetas.includes('cristian'), 'no debe hardcodear nombres de ejemplo');
  assert.ok(!etiquetas.includes('sasinka'), 'no debe hardcodear el nombre del usuario');
});

// ---------- Validación del host (el bug de Bing ignorando site:) ----------

test('acepta el host exacto y los subdominios', () => {
  assert.equal(hostCoincide('https://github.com/torvalds', 'github.com'), true);
  assert.equal(hostCoincide('https://www.github.com/torvalds', 'github.com'), true);
  assert.equal(hostCoincide('https://es.wikipedia.org/wiki/Linus', 'wikipedia.org'), true);
  assert.equal(hostCoincide('https://gist.github.com/x', 'github.com'), true);
});

test('RECHAZA un host distinto, aunque la consulta fuera site:', () => {
  // Bing devolvió Wikipedia para site:github.com "Linus Torvalds".
  // Esto es lo que evita reportar "encontrado en GitHub" un link de Wikipedia.
  assert.equal(hostCoincide('https://es.wikipedia.org/wiki/Cristi%C3%A1n', 'github.com'), false);
  assert.equal(hostCoincide('https://supercristian.com.ar/', 'instagram.com'), false);
  assert.equal(hostCoincide('https://youtube.com/watch?v=x', 'linkedin.com'), false);
});

test('rechaza URLs inválidas en vez de devolver true', () => {
  assert.equal(hostCoincide('no es una url', 'github.com'), false);
  assert.equal(hostCoincide('', 'github.com'), false);
});

// ---------- Filtro de palabras clave y relevancia ----------

test('saca palabras vacías y stopwords de la búsqueda', () => {
  assert.deepEqual(palabrasClave('buscar a Cristian Sasinka en Cordoba'), ['cristian', 'sasinka', 'cordoba']);
  assert.deepEqual(palabrasClave('el mundo'), ['mundo'], '"el" es stopword, "mundo" no');
  assert.deepEqual(palabrasClave('de la'), [], 'todo stopword');
});

test('descarta páginas que sólo comparten un nombre', () => {
  const crudos = [
    { titulo: 'Supermercado Super Cristian', url: 'https://supercristian.com.ar/', snippet: 'Comprá online' },
    { titulo: 'Cristian Castro', url: 'https://es.wikipedia.org/wiki/Cristian_Castro', snippet: 'cantante' },
    { titulo: 'Cristiano Ronaldo', url: 'https://en.wikipedia.org/wiki/Cristiano_Ronaldo', snippet: 'futbolista' }
  ];
  const r = filtrarPorRelevancia(crudos, 'Cristian Sasinka', 6);
  assert.equal(r.length, 0, 'ninguna de esas páginas es sobre esa persona');
});

test('conserva páginas que mencionan el nombre completo', () => {
  const crudos = [
    { titulo: 'Cristian Sasinka', url: 'https://github.com/csasinka', snippet: 'perfil' },
    { titulo: 'Blog personal', url: 'https://csasinka.dev', snippet: 'sobre Cristian Sasinka' }
  ];
  assert.equal(filtrarPorRelevancia(crudos, 'Cristian Sasinka', 6).length, 2);
});

test('ordena por puntaje, el mejor resultado primero', () => {
  const crudos = [
    { titulo: 'Contacto', url: 'https://x.com/algo', snippet: 'escribile a Cristian Sasinka' },
    { titulo: 'Cristian Sasinka', url: 'https://github.com/csasinka', snippet: 'hola' }
  ];
  const r = filtrarPorRelevancia(crudos, 'Cristian Sasinka', 6);
  assert.equal(r[0].url, 'https://github.com/csasinka', 'el match exacto va primero');
});

// ---------- Formato de salida ----------

test('sin resultados, el texto lo dice y prohíbe inventar', () => {
  const txt = formatearPersona('Cristian Sasinka', { encontrados: [], vacios: ['GitHub', 'LinkedIn'] });
  assert.match(txt, /NINGÚN perfil público/);
  assert.match(txt, /NO completes con datos parecidos/);
  assert.match(txt, /GitHub, LinkedIn/);
  assert.doesNotMatch(txt, /plataformas con coincidencia:.*GitHub/);
});

test('con resultados, muestra la plataforma real de cada URL', () => {
  const txt = formatearPersona('Cristian Sasinka', {
    encontrados: [{ titulo: 'Cristian Sasinka', url: 'https://github.com/csasinka', plataforma: 'GitHub', dominio: 'github.com' }],
    vacios: ['LinkedIn']
  });
  assert.match(txt, /\[GitHub\]/);
  assert.match(txt, /github\.com\/csasinka/);
  assert.match(txt, /Plataformas sin coincidencia: LinkedIn/);
});