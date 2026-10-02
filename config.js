// ============================================================
// CONFIGURACIÓN DE COMANDOS
// ============================================================

export const COMANDOS_SEGUROS = [
  // --- Lectura / exploración ---
  /^dir(\s|$)/i,
  /^type\s/i,
  /^where\s/i,
  /^echo\s/i,
  /^cd(\s|$)/i,
  /^pwd$/i,
  /^tree(\s|$)/i,
  /^git\s+(status|log|diff|branch|show|clone|fetch|pull|stash|remote)/i,
  /^npm\s+(list|ls|view|outdated)/i,
  /^node\s+--version$/i,
  /^npm\s+--version$/i,
  /^ng\s+version$/i,
  /^python\s+--version$/i,
  /^ollama\s+list$/i,

  // --- Crear carpetas / archivos vacíos ---
  /^mkdir\s/i,
  /^md\s/i,
  /^echo\s+.*>\s/i,

  // --- Instalación de dependencias ---
  /^npm\s+install(\s|$)/i,
  /^npm\s+i(\s|$)/i,
  /^npm\s+ci(\s|$)/i,
  /^npm\s+run\s+/i,
  /^npx\s+/i,
  /^pnpm\s+/i,
  /^yarn(\s|$)/i,

  // --- Búsqueda en internet ---
  /^gh\s+(search|repo\s+view|repo\s+clone)\b/i,
  /^curl\.exe\s+/i,
  /^curl\s+/i,
  /^wget\s+/i,

  // --- Frameworks ---
  /^ng\s+(new|generate|g|build|serve|test|add|version|lint|e2e)(\s|$)/i,
  /^node\s+\S+\.js(\s|$)/i,

  // --- Otros inofensivos ---
  /^code\s/i
];

export const COMANDOS_PELIGROSOS = [
  /^git\s+(push|reset\s+--hard|clean\s+-fd|checkout\s+--)/i,
  /^npm\s+(uninstall|remove|publish)/i,
  /^del\s/i,
  /^erase\s/i,
  /^rmdir\s/i,
  /^rd\s/i,
  /^move\s/i,
  /^ren\s/i,
  /^rename\s/i,
  /^copy\s/i,
  /^xcopy\s/i,
  /^robocopy\s/i,
  /^taskkill\s/i,
  /^start\s/i,
  /^curl\s/i,
  /^wget\s/i,
  /^invoke-webrequest/i,
  /^iwr\s/i
];

export const COMANDOS_PROHIBIDOS = [
  /^format\s/i,
  /^shutdown\s/i,
  /^restart-computer/i,
  /^rm\s+-rf\s+\/(\s|$)/i,
  /^del\s+\/s\s+\/q\s+c:\\/i,
  /^rmdir\s+\/s\s+\/q\s+c:\\/i,
  /^reg\s+delete/i,
  /^bcdedit/i,
  /^diskpart/i,
  /^sfc\s/i,
  /^chkdsk\s.*\/f/i,
  /^takeown\s/i,
  /^icacls\s.*\/grant/i,
  /^runas\s/i,
  /^sudo\s/i,
  /^net\s+user/i,
  /^net\s+localgroup/i
];

// Clasificador
export function clasificarComando(cmd) {
  const limpio = cmd.trim();

  for (const patron of COMANDOS_PROHIBIDOS) {
    if (patron.test(limpio)) return 'prohibido';
  }
  for (const patron of COMANDOS_SEGUROS) {
    if (patron.test(limpio)) return 'seguro';
  }
  for (const patron of COMANDOS_PELIGROSOS) {
    if (patron.test(limpio)) return 'peligroso';
  }
  return 'desconocido';
}

// Si está en true, incluso los "seguros" se preguntan.
// Si está en false, los "seguros" corren directo.
export const SIEMPRE_CONFIRMAR = false;