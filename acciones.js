import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { buscarWeb, buscarGithub, verRepo, leerUrl } from './buscar.js';

const execAsync = promisify(exec);

export const CWD = process.cwd();

// Límite de líneas por escritura. Más allá de esto el modelo pierde
// precisión y suele romper/corruptar el archivo que devuelve.
export const LIMITE_LINEAS = 200;

function contarLineas(texto) {
  return texto.split('\n').length;
}

function avisoPorTamano(accion, ruta, contenido) {
  const lineas = contarLineas(contenido);
  return `AVISO: no se escribió nada. "${ruta}" tendría ${lineas} líneas y el límite es ${LIMITE_LINEAS}.
A partir de ese tamaño podés empezar a inventar código, perder partes del archivo o romperlo.
Partí el trabajo en trozos más chicos: escribí las primeras ${LIMITE_LINEAS} líneas, verificá que
funcionen con "ejecutar_comando", y después usá "leer_archivo" + "${accion}" para agregar el resto por partes.
NO mandes el archivo entero de una.`;
}

// Validación de rutas: nunca salir del proyecto
function rutaSegura(p) {
  const abs = path.isAbsolute(p) ? p : path.join(CWD, p);
  const normalizada = path.normalize(abs);
  if (!normalizada.startsWith(CWD)) {
    throw new Error(`Ruta fuera del proyecto: ${p}`);
  }
  return normalizada;
}

export const acciones = {
  // ---------- Comandos shell (Windows 11) ----------
  async ejecutar_comando({ cmd }) {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: CWD,
      maxBuffer: 1024 * 1024 * 20,
      shell: 'cmd.exe'
    });
    return `STDOUT:\n${stdout || '(vacío)'}\nSTDERR:\n${stderr || '(vacío)'}`;
  },

  // ---------- Archivos ----------
  async leer_archivo({ ruta }) {
    const abs = rutaSegura(ruta);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const items = await fs.readdir(abs, { withFileTypes: true });
      const listado = items.map(i => `${i.isDirectory() ? '[DIR] ' : '[FILE]'} ${i.name}`).join('\n');
      return `AVISO: "${ruta}" es una CARPETA, no un archivo. Para recorrerla usá la acción "listar" o "arbol".\nContenido de ${ruta}:\n${listado || '(vacío)'}`;
    }
    const contenido = await fs.readFile(abs, 'utf-8');
    return `Contenido de ${ruta}:\n\n${contenido}`;
  },

  async escribir_archivo({ ruta, contenido }) {
    const abs = rutaSegura(ruta);
    if (contarLineas(contenido) > LIMITE_LINEAS) {
      return avisoPorTamano('escribir_archivo', ruta, contenido);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contenido, 'utf-8');
    return `Archivo escrito: ${ruta} (${contenido.length} caracteres, ${contarLineas(contenido)} líneas)`;
  },

  async refactorizar_archivo({ ruta, contenido }) {
    const abs = rutaSegura(ruta);
    if (contarLineas(contenido) > LIMITE_LINEAS) {
      return avisoPorTamano('refactorizar_archivo', ruta, contenido);
    }
    const existe = await fs.access(abs).then(() => true).catch(() => false);
    if (!existe) throw new Error(`No existe el archivo a refactorizar: ${ruta}`);
    await fs.writeFile(abs, contenido, 'utf-8');
    return `Archivo refactorizado: ${ruta} (${contenido.length} caracteres, ${contarLineas(contenido)} líneas)`;
  },

  async borrar({ ruta }) {
    const abs = rutaSegura(ruta);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
      return `Carpeta borrada: ${ruta}`;
    } else {
      await fs.unlink(abs);
      return `Archivo borrado: ${ruta}`;
    }
  },

  // ---------- Internet ----------
  async buscar_web({ consulta, limite = 6 }) {
    return buscarWeb({ consulta, limite });
  },

  async buscar_github({ consulta, limite = 5 }) {
    return buscarGithub({ consulta, limite });
  },

  async ver_repo({ repo }) {
    return verRepo({ repo });
  },

  async leer_url({ url, limite = 4000 }) {
    return leerUrl({ url, limite });
  },

  async listar({ ruta = '.' }) {
    const abs = rutaSegura(ruta);
    const items = await fs.readdir(abs, { withFileTypes: true });
    const lineas = items.map(i => `${i.isDirectory() ? '[DIR] ' : '[FILE]'} ${i.name}`);
    return `Contenido de ${ruta}:\n${lineas.join('\n') || '(vacío)'}`;
  },

  async navegar({ ruta }) {
    const abs = rutaSegura(ruta);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) throw new Error(`No es una carpeta: ${ruta}`);
    return `Ruta válida: ${abs} (usá esta ruta en los próximos comandos)`;
  },

  async arbol({ ruta = '.', profundidad = 3 }) {
    const abs = rutaSegura(ruta);
    const salida = [];

    async function walk(dir, nivel) {
      if (nivel > profundidad) return;
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name === 'node_modules' || item.name === '.git') continue;
        const sangria = '  '.repeat(nivel);
        salida.push(`${sangria}${item.isDirectory() ? '📁' : '📄'} ${item.name}`);
        if (item.isDirectory()) {
          await walk(path.join(dir, item.name), nivel + 1);
        }
      }
    }

    await walk(abs, 0);
    return `Árbol de ${ruta}:\n${salida.join('\n')}`;
  }
};

export async function ejecutarAccion(nombre, params) {
  if (!acciones[nombre]) {
    return `ERROR: acción desconocida "${nombre}". Válidas: ${Object.keys(acciones).join(', ')}`;
  }
  try {
    return await acciones[nombre](params);
  } catch (err) {
    return `ERROR ejecutando "${nombre}": ${err.message}`;
  }
}