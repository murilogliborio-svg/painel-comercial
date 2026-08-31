/**
 * Limitador de taxa em memória, com janela deslizante por chave. Idêntico
 * ao painel-comercial (server/src/http/limite.ts): correto para uma
 * instância única, que é o desenho deste serviço.
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
  readonly castigoMs: number;

  constructor(max: number, janelaMs: number, castigoMs = 0) {
    this.max = max;
    this.janelaMs = janelaMs;
    this.castigoMs = castigoMs;
  }

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
