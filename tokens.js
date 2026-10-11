import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const UA = 'mi-asistente/1.0';

function parseJsonSafe(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function obtenerInfoModelo(nombre) {
  if (!nombre) return null;
  try {
    const body = JSON.stringify({ name: nombre });
    const { stdout } = await execAsync(
      `curl.exe -s -X POST "http://localhost:11434/api/show" -H "Content-Type: application/json" -d ${JSON.stringify(body)}`,
      { maxBuffer: 1024 * 1024 * 5 }
    );
    return parseJsonSafe(stdout);
  } catch {
    return null;
  }
}

export function estimarContextoDisponible(infoModelo) {
  if (!infoModelo) return null;
  const ctx = infoModelo?.model_info?.qwen2?.context_length
    || infoModelo?.model_info?.['qwen2.context_length']
    || infoModelo?.model_info?.llama?.context_length
    || infoModelo?.model_info?.general?.context_length
    || infoModelo?.model_info?.['general.context_length']
    || infoModelo?.parameters?.context_length
    || infoModelo?.details?.context_length
    || infoModelo?.model_info?.['gpt2.context_length'];
  if (typeof ctx === 'number') return ctx;
  if (typeof ctx === 'string' && /^\d+$/.test(ctx)) return parseInt(ctx, 10);
  return null;
}

export function calcularTokensUsados(stats) {
  if (!stats) return 0;
  const prompt = stats.prompt_eval_count || 0;
  const evalCount = stats.eval_count || 0;
  return prompt + evalCount;
}

export async function chatConStats({ model, messages }) {
  if (!model) throw new Error('Falta model');
  const body = JSON.stringify({ model, messages, stream: false });
  const { stdout } = await execAsync(
    `curl.exe -s -X POST "http://localhost:11434/api/chat" -H "Content-Type: application/json" -d ${JSON.stringify(body)}`,
    { maxBuffer: 1024 * 1024 * 20 }
  );
  const data = parseJsonSafe(stdout);
  if (!data) throw new Error('Respuesta inválida de Ollama');
  return {
    content: data.message?.content || '',
    stats: {
      prompt_eval_count: data.prompt_eval_count || 0,
      eval_count: data.eval_count || 0,
      prompt_eval_duration: data.prompt_eval_duration || 0,
      eval_duration: data.eval_duration || 0,
      total_duration: data.total_duration || 0,
      done_reason: data.done_reason || null
    }
  };
}
