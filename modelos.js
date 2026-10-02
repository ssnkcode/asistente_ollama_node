import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Detecta los modelos instalados en la máquina corriendo "ollama list"
export async function detectarModelos() {
  try {
    const { stdout } = await execAsync('ollama list', { shell: 'cmd.exe' });
    const lineas = stdout.split('\n').filter(l => l.trim());

    // La primera línea es el header: NAME  ID  SIZE  MODIFIED
    // Las siguientes son los modelos
    const modelos = lineas.slice(1).map(linea => {
      const partes = linea.trim().split(/\s+/);
      return {
        nombre: partes[0],
        id: partes[1] || '',
        tamano: partes[2] || '',
        modificado: partes.slice(3).join(' ') || ''
      };
    }).filter(m => m.nombre);

    return modelos;
  } catch (err) {
    throw new Error(`No se pudo ejecutar "ollama list". ¿Está Ollama instalado y corriendo?\n${err.message}`);
  }
}

// Muestra el menú y devuelve el modelo elegido
export async function elegirModelo(preguntar, chalk) {
  console.log(chalk.cyan('\n🔍 Detectando modelos Ollama instalados...\n'));

  let modelos;
  try {
    modelos = await detectarModelos();
  } catch (err) {
    console.log(chalk.red(err.message));
    process.exit(1);
  }

  if (modelos.length === 0) {
    console.log(chalk.red('No hay modelos instalados. Corré: ollama pull qwen2.5-coder:7b'));
    process.exit(1);
  }

  console.log(chalk.cyan.bold('Modelos disponibles:\n'));
  modelos.forEach((m, i) => {
    console.log(chalk.white(`  ${i + 1}. ${chalk.bold(m.nombre)}`));
    console.log(chalk.gray(`     Tamaño: ${m.tamano}  |  Modificado: ${m.modificado}`));
  });

  // Reintenta hasta que la elección sea un número válido, un nombre de la
  // lista o Enter (default 1). Si no, NO elige nada por vos.
  while (true) {
    const resp = (await preguntar(chalk.green(`\nElegí un modelo (1-${modelos.length}) [default: 1]: `))).trim();

    if (resp === '') return modelos[0].nombre;

    const idx = Number(resp);
    if (Number.isInteger(idx) && idx >= 1 && idx <= modelos.length) {
      return modelos[idx - 1].nombre;
    }

    // También acepta el nombre exacto del modelo
    const porNombre = modelos.find(m => m.nombre.toLowerCase() === resp.toLowerCase());
    if (porNombre) return porNombre.nombre;

    console.log(chalk.yellow(`\n"${resp}" no es una opción válida.`));
    console.log(chalk.gray(`Escribí un número del 1 al ${modelos.length}, el nombre del modelo, o Enter para el 1.`));
  }
}