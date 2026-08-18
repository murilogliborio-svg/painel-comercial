/**
 * Limitador de taxa em memória, com janela deslizante por chave.
 *
 * Em memória é suficiente e correto para uma instância única — que é o
 * desenho deste sistema. Se um dia houver duas instâncias atrás de um
 * balanceador, este módulo precisa ser trocado por um contador compartilhado
 * (Redis ou uma tabela no banco), senão cada instância aplica o próprio teto
 * e o limite efetivo dobra. Está anotado no README como pré-condição de
 * escala horizontal.
 */

interface Janela {
  marcas: number[];
  bloqueadoAte: number;
}

export class LimitadorTaxa {
  #mapa = new Map<string, Janela>();
  #ultimaLimpeza = 0;

  readonly max: number;
  readonly janelaMs: number;
  /** Bloqueio extra após estourar o teto. Zero = apenas espera a janela. */
  readonly castigoMs: number;

  constructor(max: number, janelaMs: number, castigoMs = 0) {
    this.max = max;
    this.janelaMs = janelaMs;
    this.castigoMs = castigoMs;
  }

  /** Registra uma tentativa. Retorna quantos ms faltam se estiver barrado. */
  verificar(chave: string, agora = Date.now()): { permitido: boolean; esperarMs: number } {
    this.#limpar(agora);

    let j = this.#mapa.get(chave);
    if (!j) { j = { marcas: [], bloqueadoAte: 0 }; this.#mapa.set(chave, j); }

    if (j.bloqueadoAte > agora) {
      return { permitido: false, esperarMs: j.bloqueadoAte - agora };
    }

    const corte = agora - this.janelaMs;
    j.marcas = j.marcas.filter((t) => t > corte);

    if (j.marcas.length >= this.max) {
      if (this.castigoMs > 0) j.bloqueadoAte = agora + this.castigoMs;
      const espera = this.castigoMs > 0 ? this.castigoMs : (j.marcas[0]! + this.janelaMs) - agora;
      return { permitido: false, esperarMs: Math.max(espera, 0) };
    }

    j.marcas.push(agora);
    return { permitido: true, esperarMs: 0 };
  }

  /** Zera o contador de uma chave. Chamado após login bem-sucedido. */
  liberar(chave: string): void {
    this.#mapa.delete(chave);
  }

  #limpar(agora: number): void {
    if (agora - this.#ultimaLimpeza < 60_000) return;
    this.#ultimaLimpeza = agora;
    const corte = agora - this.janelaMs;
    for (const [k, j] of this.#mapa) {
      if (j.bloqueadoAte <= agora && (j.marcas.length === 0 || j.marcas[j.marcas.length - 1]! <= corte)) {
        this.#mapa.delete(k);
      }
    }
  }

  get tamanho(): number { return this.#mapa.size; }
}
