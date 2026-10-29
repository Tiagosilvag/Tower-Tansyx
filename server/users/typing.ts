// Remonta, das teclas que a página manda ao terminal interativo, as linhas que o usuário enviou (Enter). Serve só para
// o SenderLog saber quem escreveu cada prompt; não é perfeito (setas e edições no meio da linha não são seguidas) e uma
// linha que não bater com o transcript simplesmente fica sem marca.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const BUFFER_MAX = 8000;
const KEYS_MAX = 200;

export class TypedLines {
  private readonly buffers = new Map<string, { text: string; paste: boolean }>();

  /** Alimenta com o que chegou em `key` (usuário + terminal); devolve as linhas enviadas por esse trecho. */
  feed(key: string, data: string): string[] {
    let b = this.buffers.get(key);
    if (!b) {
      if (this.buffers.size >= KEYS_MAX) this.buffers.delete(this.buffers.keys().next().value as string);
      b = { text: '', paste: false };
      this.buffers.set(key, b);
    }
    const out: string[] = [];
    for (let i = 0; i < data.length; ) {
      if (data.startsWith(PASTE_START, i)) {
        b.paste = true;
        i += PASTE_START.length;
        continue;
      }
      if (data.startsWith(PASTE_END, i)) {
        b.paste = false;
        i += PASTE_END.length;
        continue;
      }
      const c = data[i]!;
      i++;
      if (c === '\x1b') {
        // sequência de escape (setas, teclas de função): pula até a letra final
        if (data[i] === '[' || data[i] === 'O') {
          i++;
          while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++;
          i++;
        } else i++;
        continue;
      }
      if (b.paste) {
        if (b.text.length < BUFFER_MAX) b.text += c === '\r' ? '\n' : c;
        continue;
      }
      if (c === '\r' || c === '\n') {
        if (b.text.trim()) out.push(b.text);
        b.text = '';
      } else if (c === '\x7f' || c === '\b') b.text = b.text.slice(0, -1);
      else if (c === '\x03' || c === '\x15') b.text = '';
      else if (c >= ' ' && b.text.length < BUFFER_MAX) b.text += c;
    }
    return out;
  }
}
