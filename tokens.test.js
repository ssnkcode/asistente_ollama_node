import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calcularTokensUsados, estimarContextoDisponible } from './tokens.js';

describe('tokens', () => {
  test('calcularTokensUsados suma prompt y eval', () => {
    assert.equal(calcularTokensUsados({ prompt_eval_count: 31, eval_count: 17 }), 48);
    assert.equal(calcularTokensUsados({}), 0);
    assert.equal(calcularTokensUsados(null), 0);
  });

  test('estimarContextoDisponible extrae de model_info', () => {
    const info = { model_info: { qwen2: { context_length: 32768 } } };
    assert.equal(estimarContextoDisponible(info), 32768);
  });

  test('estimarContextoDisponible maneja strings y nulos', () => {
    assert.equal(estimarContextoDisponible({ model_info: { general: { context_length: '4096' } } }), 4096);
    assert.equal(estimarContextoDisponible(null), null);
    assert.equal(estimarContextoDisponible({}), null);
  });
});
