// Janela de confirmação para apagar a última mensagem da conversa (botão "Excluir" do chat).
import { tr } from '../../../shared/i18n';
import { h } from './dom';

/** Abre a janela e responde true só se a pessoa clicar em "Apagar de vez". */
export function confirmDelete(): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = h('button', { class: 'ui-confirm__btn', type: 'button', text: tr('Cancelar') });
    const ok = h('button', { class: 'ui-confirm__btn ui-confirm__btn--danger', type: 'button', text: tr('Apagar de vez') });
    const dlg = h(
      'dialog',
      { class: 'ui-confirm', attrs: { 'aria-labelledby': 'ui-confirm-title' } },
      h('h2', { class: 'ui-confirm__title', text: tr('Apagar esta mensagem?'), attrs: { id: 'ui-confirm-title' } }),
      h('p', { class: 'ui-confirm__text', text: tr('A mensagem e a resposta do agente depois dela somem do chat de todos os sócios, e o Claude Code volta a conversa para antes dela. Não dá para desfazer.') }),
      h('div', { class: 'ui-confirm__actions' }, cancel, ok),
    ) as HTMLDialogElement;
    let answer = false;
    cancel.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', () => {
      answer = true;
      dlg.close();
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(answer);
    });
    document.body.append(dlg);
    dlg.showModal();
    cancel.focus();
  });
}
