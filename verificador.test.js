import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  limpiarFuentes,
  registrarFuente,
  verificarTexto,
  verificarAccion,
  urlVerificada,
  repoVerificado,
  extraerCandidatos,
  fuentes,
  urlsConocidas,
  PHRASES_BLOQUEADAS
} from './verificador.js';

describe('verificador - protocolo de citas', () => {
  beforeEach(() => {
    limpiarFuentes();
  });

  test('acepta citas literales que existen en fuentes', () => {
    registrarFuente('Resultados de "DNI 36768847":\n1. Nombre: Juan Pérez\nURL: https://example.com/persona');
    const r = verificarTexto('{"cita": ["Juan Pérez", "https://example.com/persona"]}');
    assert.equal(r.ok, true);
    assert(r.imprime.includes('Juan Pérez'));
  });

  test('bloquea cita que NO está en fuentes', () => {
    registrarFuente('Resultados de "DNI 36768847":\n1. Nombre: Juan Pérez');
    const r = verificarTexto('{"cita": ["Pedro Gómez"]}');
    assert.equal(r.ok, false);
    assert(r.motivo.includes('no están en ninguna fuente'));
  });

  test('devuelve cita vacía cuando no hay datos verificables', () => {
    registrarFuente('Resultados vacíos');
    const r = verificarTexto('{"cita": []}');
    assert.equal(r.ok, true);
  });
});

describe('verificador - texto libre', () => {
  beforeEach(() => {
    limpiarFuentes();
  });

  test('bloquea nombre inventado en texto libre', () => {
    registrarFuente('El título es X');
    const r = verificarTexto('El título es Pedro Inventado');
    assert.equal(r.ok, false);
  });

  test('bloquea número inventado (DNI)', () => {
    registrarFuente('No hay datos');
    const r = verificarTexto('El DNI es 36768847');
    assert.equal(r.ok, false);
  });

  test('bloquea URL inventada', () => {
    registrarFuente('Resultados');
    const r = verificarTexto('Ver en https://fake.example.com/dato');
    assert.equal(r.ok, false);
  });

  test('bloquea fecha inventada', () => {
    registrarFuente('Info');
    const r = verificarTexto('Nació el 15/08/1990');
    assert.equal(r.ok, false);
  });

  test('permite conversación sin datos', () => {
    registrarFuente('Hola');
    const r = verificarTexto('Hola, ¿en qué puedo ayudarte?');
    assert.equal(r.ok, true);
  });

  test('ya NO bloquea frases evasivas (a pedido del usuario)', () => {
    registrarFuente('Resultados de búsqueda');
    const r = verificarTexto('No puedo acceder a esa información');
    assert.equal(r.ok, true);
    assert.equal(PHRASES_BLOQUEADAS.length, 0);
  });

  test('bloquea repetición de oraciones', () => {
    const r = verificarTexto('No aparece en los resultados. No aparece en los resultados. No aparece en los resultados.');
    assert.equal(r.ok, false);
    assert(r.motivo.includes('se repitió'));
  });
});

describe('verificador - URLs y repos', () => {
  beforeEach(() => {
    limpiarFuentes();
  });

  test('urlVerificada requiere que aparezca en fuente', () => {
    assert.equal(urlVerificada('https://example.com/x'), false);
    registrarFuente('URL: https://example.com/x');
    assert.equal(urlVerificada('https://example.com/x'), true);
    assert.equal(urlVerificada('http://example.com/x'), true);
  });

  // Regresión: las fuentes traen las URLs con "www." (así llegan de Bing y de
  // Sherlock) y el modelo las escribe sin "www". Antes se comparaban como
  // substring y el verificador rechazaba URLs que SÍ estaban en la fuente.
  test('una URL con www en la fuente valida la misma URL sin www', () => {
    limpiarFuentes();
    registrarFuente('Resultado: https://www.github.com/torvalds');
    assert.equal(urlVerificada('https://github.com/torvalds'), true);
    assert.equal(urlVerificada('https://www.github.com/torvalds'), true);
  });

  test('la barra final no invalida la URL', () => {
    limpiarFuentes();
    registrarFuente('URL: https://es.wikipedia.org/wiki/Node.js/');
    assert.equal(urlVerificada('https://es.wikipedia.org/wiki/Node.js'), true);
    assert.equal(urlVerificada('https://es.wikipedia.org/wiki/Node.js/'), true);
  });

  test('un texto con URL www en la fuente NO bloquea al modelo que la escribe sin www', () => {
    limpiarFuentes();
    registrarFuente('Resultados:\n1. Linus Torvalds - GitHub\nURL: https://www.github.com/torvalds');
    const r = verificarTexto('El perfil está en https://github.com/torvalds');
    assert.equal(r.modo, 'libre', `bloqueó: ${r.motivo}`);
  });

  test('una URL de un dominio que no está en ninguna fuente sigue bloqueada', () => {
    limpiarFuentes();
    registrarFuente('URL: https://www.github.com/torvalds');
    const r = verificarTexto('Mirá https://sitio-que-no-existe.example/x');
    assert.equal(r.modo, 'bloqueado');
  });

  test('repoVerificado requiere fuente', () => {
    assert.equal(repoVerificado('usuario/repo'), false);
    registrarFuente('Repo: usuario/repo');
    assert.equal(repoVerificado('usuario/repo'), true);
  });

  test('verificarAccion bloquea URL no verificada', () => {
    limpiarFuentes();
    const r = verificarAccion({ accion: 'leer_url', params: { url: 'https://hack.com' }, explicacion: 'Leo' });
    assert.equal(r.ok, false);
  });

  test('verificarAccion permite URL verificada', () => {
    registrarFuente('Resultados:\nURL: https://github.com/usuario/repo');
    const r = verificarAccion({ accion: 'leer_url', params: { url: 'https://github.com/usuario/repo' }, explicacion: 'leo' });
    assert.equal(r.ok, true);
  });
});

describe('verificador - extracción de candidatos', () => {
  beforeEach(() => limpiarFuentes());

  test('detecta DNI de 8 dígitos', () => {
    const c = extraerCandidatos('El DNI es 36768847');
    assert(c.some(x => x.valor.includes('36768847') && x.tipo === 'numero'));
  });

  test('no marca índices como datos', () => {
    const c = extraerCandidatos('1. Título\n2. Otro');
    assert.equal(c.length, 0);
  });

  test('marca cantidad con unidad', () => {
    const c = extraerCandidatos('Hay 200 líneas');
    assert(c.some(x => x.valor === '200'));
  });
});
