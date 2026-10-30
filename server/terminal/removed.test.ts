import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../shared/types';
import { RemovedStore } from './removed';

const entry = (at: number): TerminalEntry => ({ id: String(at), kind: 'user', at, text: 'oi' }) as TerminalEntry;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('mensagens apagadas', () => {
  it('esconde só o que está na faixa e só daquela conversa', () => {
    const r = new RemovedStore(null);
    r.add('/a.jsonl', 100, 200);
    expect(r.hides('/a.jsonl', entry(99))).toBe(false);
    expect(r.hides('/a.jsonl', entry(100))).toBe(true);
    expect(r.hides('/a.jsonl', entry(200))).toBe(true);
    expect(r.hides('/a.jsonl', entry(201))).toBe(false);
    expect(r.hides('/b.jsonl', entry(150))).toBe(false);
    expect(r.hides(undefined, entry(150))).toBe(false);
  });

  it('ignora faixa inválida', () => {
    const r = new RemovedStore(null);
    r.add('/a.jsonl', 200, 100);
    r.add('/a.jsonl', Number.NaN, 100);
    expect(r.hides('/a.jsonl', entry(150))).toBe(false);
  });

  it('sobrevive a reiniciar (guarda em arquivo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'removed-'));
    dirs.push(dir);
    const file = join(dir, 'removed.json');
    new RemovedStore(file).add('/a.jsonl', 10, 20);
    const again = new RemovedStore(file);
    again.load();
    expect(again.hides('/a.jsonl', entry(15))).toBe(true);
  });
});
