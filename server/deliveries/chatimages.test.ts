import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../shared/types';
import { annotateImages, chatImage } from './chatimages';

const said = (text: string): TerminalEntry => ({ kind: 'assistant', id: 'a', at: 1, text });
const imagesOf = (e: TerminalEntry) => (e as { images?: Array<{ id: string; name: string }> }).images;

describe('annotateImages', () => {
  it('resposta com imagem em markdown ou caminho solto ganha miniaturas, sem expor o caminho', () => {
    const images = imagesOf(annotateImages(said('Veja ![modal](/tmp/x/modal.png) e também /tmp/x/outra.jpg.'))) ?? [];
    expect(images.map((i) => i.name)).toEqual(['modal.png', 'outra.jpg']);
    expect(chatImage(images[0].id)?.path).toBe('/tmp/x/modal.png');
    expect(JSON.stringify(images)).not.toContain('/tmp');
  });

  it('Write de imagem ganha miniatura', () => {
    const e = annotateImages({ kind: 'tool', id: 't', at: 1, tool: 'Write', title: 'Write(tela.webp)', file: '/tmp/x/tela.webp' });
    expect(imagesOf(e)).toHaveLength(1);
    expect('file' in e).toBe(false);
  });

  it('página do Artifact vira pré-visualização; o caminho não sai', () => {
    const e = annotateImages({ kind: 'tool', id: 't', at: 1, tool: 'Artifact', title: 'Artifact(mockups.html)', file: '/tmp/x/mockups.html' });
    const previews = (e as { previews?: Array<{ id: string; name: string }> }).previews ?? [];
    expect(previews.map((p) => p.name)).toEqual(['mockups.html']);
    expect(chatImage(previews[0].id)?.type).toContain('text/html');
    expect(JSON.stringify(e)).not.toContain('/tmp');
    // Write de HTML não vira pré-visualização, e segredo nunca.
    expect((annotateImages({ kind: 'tool', id: 'u', at: 1, tool: 'Write', title: 'Write(a.html)', file: '/tmp/a.html' }) as { previews?: unknown }).previews).toBeUndefined();
    expect((annotateImages({ kind: 'tool', id: 'v', at: 1, tool: 'Artifact', title: 'Artifact', file: '/tmp/.env.html' }) as { previews?: unknown }).previews).toBeUndefined();
  });

  it('ignora relativos, segredos, outros tipos e URLs', () => {
    expect(imagesOf(annotateImages(said('![](tela.png) /home/u/.ssh/a.png /tmp/a.pdf https://x.com/a.png')))).toBeUndefined();
    expect(imagesOf(annotateImages(said('/tmp/senha.png')))).toBeUndefined();
  });
});
