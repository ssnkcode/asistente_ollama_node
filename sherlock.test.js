import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsearSalidaSherlock,
  limpiarAnsi,
  plataformaDesdeUrl,
  formatearSherlock,
  sherlockInstalado,
  versionSherlock
} from './sherlock.js';

// Salida REAL capturada de Sherlock v0.16.2 (con los links ANSI del promo).
const SALIDA_REAL = `[*] Checking username torvalds on:


[+] GitHub: https://www.github.com/torvalds
[+] Reddit: https://www.reddit.com/user/torvalds
[+] Docker Hub: https://hub.docker.com/u/torvalds/

[*] Search completed with 3 results

Go deeper than a username. Explore public profiles and export your findings.
Try OSINTSearch: \x1B]8;;https://osintsearch.org/go/sherlock\x1B\\https://osintsearch.org\x1B]8;;\x1B\\`;

test('parsea las líneas [+] de la salida real', () => {
  const r = parsearSalidaSherlock(SALIDA_REAL);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], {
    url: 'https://www.github.com/torvalds',
    plataforma: 'GitHub',
    dominio: 'github.com'
  });
  assert.equal(r[1].plataforma, 'Reddit');
  assert.equal(r[2].url, 'https://hub.docker.com/u/torvalds/');
});

test('ignora las líneas de progreso [*] y el promo del final', () => {
  const r = parsearSalidaSherlock(SALIDA_REAL);
  assert.ok(!r.some(c => c.url.includes('osintsearch')));
  assert.ok(!r.some(c => c.plataforma.includes('OSINT')));
  assert.ok(!r.some(c => c.plataforma.includes('Checking')));
});

test('ignora las líneas [-] de "no encontrado"', () => {
  const salida = SALIDA_REAL + '\n[-] Twitter: Not Found!\n[-] Instagram: Not Found!';
  assert.equal(parsearSalidaSherlock(salida).length, 3);
});

test('no duplica la misma URL', () => {
  const salida = '[+] GitHub: https://github.com/x\n[+] GitHub: https://github.com/x\n[+] GitLab: https://gitlab.com/x';
  assert.equal(parsearSalidaSherlock(salida).length, 2);
});

test('devuelve vacío si no encuentra nada', () => {
  const salida = '[*] Checking username zx9qw3 on:\n\n[*] Search completed with 0 results';
  assert.deepEqual(parsearSalidaSherlock(salida), []);
});

test('limpia los códigos ANSI y los enlaces OSC 8', () => {
  const sucio = '\x1B[1m\x1B[32mtexto\x1B[0m \x1B]8;;https://x.com\x1B\\link\x1B]8;;\x1B\\';
  assert.equal(limpiarAnsi(sucio), 'texto link');
});

test('extrae el dominio sin www', () => {
  assert.equal(plataformaDesdeUrl('https://www.github.com/torvalds'), 'github.com');
  assert.equal(plataformaDesdeUrl('https://x.com/a'), 'x.com');
  assert.equal(plataformaDesdeUrl('basura'), 'desconocido');
});

// ---------- Formato para el modelo ----------

test('sin resultados, lo dice y prohíbe inventar', () => {
  const txt = formatearSherlock({ usuario: 'zNobody9', cuentas: [], total: 0 });
  assert.match(txt, /NO encontró ninguna cuenta/);
  assert.match(txt, /No completes con cuentas parecidas/);
  assert.match(txt, /sólo se puede afirmar lo que esté en la lista/);
});

test('con resultados, lista plataforma y URL', () => {
  const txt = formatearSherlock({
    usuario: 'torvalds',
    cuentas: [{ url: 'https://github.com/torvalds', plataforma: 'GitHub', dominio: 'github.com' }],
    total: 1
  });
  assert.match(txt, /\[GitHub\] https:\/\/github\.com\/torvalds/);
  assert.match(txt, /1 confirmadas/);
});

test('si truncó, lo dice en vez de callar los que faltan', () => {
  const txt = formatearSherlock({
    usuario: 'torvalds',
    cuentas: [{ url: 'https://github.com/torvalds', plataforma: 'GitHub' }],
    total: 9,
    truncado: true
  });
  assert.match(txt, /se muestran 1 de 9/);
  assert.match(txt, /Faltan 8/);
  assert.match(txt, /No afirmes que no existen/);
});

test('por timeout NO dice que no tiene cuentas', () => {
  const txt = formatearSherlock({
    usuario: 'alguien', cuentas: [], total: 0,
    errno: 'timeout', mensaje: 'la búsqueda se cortó a los 180s'
  });
  assert.match(txt, /se cortó por tiempo/);
  assert.match(txt, /No afirmes que no tiene cuentas/);
  assert.doesNotMatch(txt, /NO encontró ninguna cuenta/);
});

// ----------整合 con el verificador ----------

test('las URLs que devuelve Sherlock pasan el verificador', async () => {
  const v = await import('./verificador.js');
  v.limpiarFuentes();
  const cuentas = parsearSalidaSherlock(SALIDA_REAL);

  // index.js registra la salida de la acción antes de verificar al modelo.
  v.registrarFuente(formatearSherlock({ usuario: 'torvalds', cuentas, total: cuentas.length }));

  // Sherlock devuelve las URLs con "www." (github.com/torvalds). El modelo
  // normalmente las escribe sin "www". El verificador tiene que tolerarlo.
  const r = v.verificarTexto('El usuario tiene un perfil en https://github.com/torvalds');
  assert.equal(r.modo, 'libre', `debería dejar pasar la URL de Sherlock, bloqueó: ${r.motivo}`);
});

test('una URL que Sherlock NO devuelve sigue bloqueada', async () => {
  const v = await import('./verificador.js');
  v.limpiarFuentes();
  const cuentas = parsearSalidaSherlock(SALIDA_REAL);
  v.registrarFuente(formatearSherlock({ usuario: 'torvalds', cuentas, total: cuentas.length }));

  const r = v.verificarTexto('Mirá https://github.com/alguien-que-no-existe-12345');
  assert.equal(r.modo, 'bloqueado');
});

// ---------- El binario está instalado ----------

test('Sherlock está instalado y responde', async () => {
  assert.equal(await sherlockInstalado(), true, 'Sherlock no está en el PATH');
  const v = await versionSherlock();
  assert.match(v, /Sherlock v\d+\.\d+/);
});