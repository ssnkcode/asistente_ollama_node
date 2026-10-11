import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Sherlock 0.16.x.
//
// Dos hallazgos de la implementación real (verificados con la 0.16.2):
//
// 1. `--json` NO es para la salida: es para cargar una lista de sitios. Para
//    datos estructurados está `--csv`.
// 2. El CSV con `-o` es inconsistente desde Node: con los mismos flags que
//    desde PowerShell, el archivo a veces no se escribe. Lo que SÍ es
//    confiable es stdout, que trae una línea por cuenta encontrada:
//
//      [*] Checking username torvalds on:
//      [+] GitHub: https://www.github.com/torvalds
//      [+] Reddit: https://www.reddit.com/user/torvalds
//      [*] Search completed with 3 results
//
//    Por eso se parsea stdout y no el archivo. Al final del stdout Sherlock
//    mete un promo con enlace ANSI, que se descarta al filtrar por "[+]".

const EXECUTABLE = process.platform === 'win32' ? 'sherlock.exe' : 'sherlock';

// Limpia los códigos ANSI (colores y enlaces OSC 8 del promo del final).
export function limpiarAnsi(s) {
  return String(s || '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')  // enlaces OSC 8
    .replace(/\x1B[@-_][0-9;]*[A-Za-z]/g, '');          // CSI y simples
}

export async function sherlockInstalado() {
  try {
    await execFileAsync(EXECUTABLE, ['--version'], { timeout: 20000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function versionSherlock() {
  return execFileAsync(EXECUTABLE, ['--version'], { timeout: 20000, windowsHide: true })
    .then(({ stdout }) => limpiarAnsi(stdout).trim())
    .catch(() => null);
}

// Formato real de stdout con un solo usuario:
//   [+] GitHub: https://www.github.com/torvalds
// Se ignoran las líneas "[-]" (no encontrado) y las de progreso "[*]".
export function parsearSalidaSherlock(salida) {
  const out = [];
  const vistos = new Set();

  for (const linea of limpiarAnsi(salida).split(/\r?\n/)) {
    const m = linea.trim().match(/^\[\+\]\s*(.+?):\s*(https?:\/\/\S+)$/);
    if (!m) continue;

    const plataforma = m[1].trim();
    const url = m[2].replace(/[,\s]+$/, '');
    if (vistos.has(url)) continue;
    vistos.add(url);
    out.push({ url, plataforma, dominio: plataformaDesdeUrl(url) });
  }
  return out;
}

export function plataformaDesdeUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'desconocido';
  }
}

/**
 * Busca cuentas públicas de un usuario.
 * @param {object} opts
 * @param {string} opts.usuario      usuario o @usuario
 * @param {number} opts.tiempo       segundos de timeout por sitio
 * @param {number} opts.limite       máximo de cuentas devueltas
 * @param {string[]} opts.sitios     opcional: filtrar con --site
 */
export async function buscarPorUsuario({
  usuario,
  tiempo = 15,
  limite = 40,
  sitios = null,
  timeoutTotal = 180000
} = {}) {
  const user = String(usuario || '').trim().replace(/^@/, '');
  if (!user) throw new Error('Falta el parámetro "usuario"');

  // Un usuario es un token alfanumérico. Se filtra porque el valor va como
  // argumento de execFile (no se concatena al shell), pero igual conviene
  // rechazar basura antes de gastar 400 requests.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    throw new Error(`"${usuario}" no parece un nombre de usuario válido`);
  }

  const args = [user, '--print-found', '--no-color', '--timeout', String(tiempo)];
  if (Array.isArray(sitios) && sitios.length > 0) {
    for (const s of sitios) args.push('--site', s);
  }

  let salida = '';
  try {
    const { stdout, stderr } = await execFileAsync(EXECUTABLE, args, {
      timeout: timeoutTotal,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 16
    });
    salida = `${stdout || ''}\n${stderr || ''}`;
  } catch (err) {
    // Un sitio caído no debe abortar todo: Sherlock escribe los "[+]" que sí
    // encontró antes de fallar. Sólo se corta si no se pudo ejecutar nada.
    if (err.code === 'ENOENT') {
      throw new Error('Sherlock no está instalado. Instalalo con: pipx install sherlock-project');
    }
    salida = `${err.stdout || ''}\n${err.stderr || ''}`;
    const hayAlgo = /\[\+\]/.test(limpiarAnsi(salida));
    if (!hayAlgo && (err.killed || err.signal === 'SIGTERM')) {
      return {
        usuario: user,
        cuentas: [],
        total: 0,
        truncado: false,
        errno: 'timeout',
        mensaje: `la búsqueda se cortó a los ${Math.round(timeoutTotal / 1000)}s`
      };
    }
  }

  const todas = parsearSalidaSherlock(salida);
  const cuentas = todas.slice(0, limite);
  return {
    usuario: user,
    cuentas,
    total: todas.length,
    truncado: todas.length > cuentas.length,
    errno: null,
    mensaje: null
  };
}

// Texto que ve el modelo. Si no hay nada, lo dice y prohíbe inventar.
export function formatearSherlock({ usuario, cuentas, total = cuentas.length, truncado = false, errno, mensaje }) {
  if (errno === 'timeout') {
    return `La búsqueda del usuario "${usuario}" se cortó por tiempo (${mensaje}) y puede estar incompleta.
No afirmes que no tiene cuentas: sólo que no se pudo terminar.`;
  }
  if (errno === 'error') {
    return `Falló la búsqueda del usuario "${usuario}": ${mensaje}`;
  }
  if (cuentas.length === 0) {
    return `Sherlock revisó ~400 plataformas para el usuario "${usuario}" y NO encontró ninguna cuenta pública confirmada con ese usuario.
Decí eso textualmente. No completes con cuentas parecidas ni con otros usuarios parecidos, y no afirmes datos personales: sólo se puede afirmar lo que esté en la lista de arriba.`;
  }

  const lineas = cuentas.map((c, i) => `${i + 1}. [${c.plataforma}] ${c.url}`);

  const encabezado = truncado
    ? `Cuentas públicas del usuario "${usuario}": se muestran ${cuentas.length} de ${total} confirmadas (~400 plataformas consultadas).`
    : `Cuentas públicas del usuario "${usuario}" (${cuentas.length} confirmadas de ~400 plataformas consultadas):`;

  const aviso = truncado
    ? `\n\n(Faltan ${total - cuentas.length}. No afirmes que no existen: no están en la lista de arriba.)`
    : '';

  return `${encabezado}\n\n${lineas.join('\n')}${aviso}`;
}