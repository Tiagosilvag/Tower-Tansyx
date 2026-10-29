import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { sendFile } from './app';

function headersOf(type: string): Record<string, string | number> {
  let sent: Record<string, string | number> = {};
  const res = { writeHead: (_status: number, h: Record<string, string | number>) => (sent = h), end: () => undefined } as unknown as ServerResponse;
  sendFile(res, Buffer.from('x'), type, 'a.bin');
  return sent;
}

describe('sendFile: cache', () => {
  it('página e SVG são reescritos no mesmo caminho: o navegador sempre confere de novo', () => {
    expect(headersOf('text/html; charset=utf-8')['Cache-Control']).toBe('private, no-cache');
    expect(headersOf('image/svg+xml')['Cache-Control']).toBe('private, no-cache');
  });

  it('imagem comum continua podendo ficar 5 min no cache', () => {
    expect(headersOf('image/png')['Cache-Control']).toBe('private, max-age=300');
  });

  it('página segue isolada pela política de segurança', () => {
    expect(String(headersOf('text/html')['Content-Security-Policy'])).toMatch(/^sandbox; default-src 'none'/);
  });
});
