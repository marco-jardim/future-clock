# future-agents

Experimento: **o que um agente de código faz se acreditar que está rodando N anos no futuro?**

O repositório contém o `future-clock`, um plugin para o [opencode](https://opencode.ai) **v2** que desloca o **ano** que o modelo percebe como "agora". Contém também a bateria de testes e o experimento que mediram o efeito. Com `years: 120`:

```
Today's date: Mon Oct 12 2026   →   Today's date: Mon Oct 12 2146
```

Só o ano muda. Dia, mês, hora e dia da semana ficam como estão.

---

## Resultados do experimento

8 prompts × 2 grupos (controle sem plugin, tratamento com `years: 120`) × 2 repetições, modelo `opencode-go/claude-haiku-5-5`, total de 32 runs. Relatório completo em [docs/experiments/future-report.md](docs/experiments/future-report.md).

- **O modelo confia no relógio do sistema.** "Que dia é hoje?" foi respondido com 2146 sem hesitar, e o subagente concordou.
- **Desconfiança é rara.** Em 1 de 2 runs de `Get-Date` o modelo sugeriu conferir o relógio porque "a data é bem à frente do que é comum".
- **Calendário incoerente.** "Mês passado / mês que vem" foi respondido em 2146, mas com os dias da semana de 2026.
- **O mundo real não convence.** A web continua em 2026. Um run percebeu o conflito; outro atribuiu a 2146 uma versão do Node lançada em 2026.
- **Efeito colateral real.** Pedido para criar um log "com a data de hoje no nome", o modelo gravou `log-2146-10-12.log` no disco.

---

## Requisitos

- **opencode v2.** Testado com 2.0.27. A v1 não é suportada (API de plugins incompatível).
- **Bun.** Testado com 1.3.14.
- Windows + PowerShell 7 é o ambiente testado. Os scripts de sandbox e experimento usam caminhos desta máquina (ver [Ambiente de teste](#ambiente-de-teste)).

## Uso rápido

```powershell
bun install
bun run build
```

O build gera o **diretório** `dist\future-clock\` (`package.json` + `server.js`). O opencode v2 só aceita plugins locais como diretório; caminho de arquivo e URL `file://` são rejeitados.

No `opencode.json` do projeto onde você quer simular o futuro:

```json
{
  "plugins": [
    { "package": "D:\\git\\future-agents\\dist\\future-clock", "options": { "years": 120 } }
  ]
}
```

Coloque o `future-clock` **na config do projeto e por último no array**. Assim ele roda depois dos plugins globais (ver [Convivência](#convivência-com-outros-plugins)).

### Configuração

`years` é a única opção.

| Opção | Tipo | Padrão | Regra |
|---|---|---|---|
| `years` | inteiro | `120` | `years >= 4` ou `years <= -3`; o ano resultante deve ficar entre 1000 e 9999 |

Qualquer outra chave, ou valor inválido, faz o plugin falhar no carregamento com uma mensagem explícita. Os limites `>= 4` e `<= -3` garantem que aplicar a troca duas vezes não desloca o ano de novo, mesmo se o ano real virar entre dois eventos.

---

## Como funciona

O plugin troca o ano em quatro fontes de "agora":

| | Fonte | Mecanismo |
|---|---|---|
| S1 | `Today's date: …` no system prompt | hook `context` |
| S2 | `Today's date is now: …` (virada de dia no meio da sessão) | hook `context` |
| S3 | `The current year is YYYY` nas descrições de ferramentas (ex.: `websearch`) | hook `context` |
| S4 | Saída de comandos que leem o relógio no `shell` (`Get-Date`, `date`, `[DateTime]::Now`, `Date.now()`, `datetime.now()`, …) | hook `execute.after` |

Depois de todos os hooks, uma **passada final** no hook `http.request` reescreve o corpo da requisição que vai ao provider, com as mesmas regras. É ela que garante a "última palavra" (ver abaixo).

São dois modos de troca:

- **`context`** (system, descrições, virada de dia): o ano só muda dentro de padrões com forma de data, como `2026-10-12`, `Mon Oct 12 2026`, `October 12, 2026`, `12 de outubro de 2026`, `12/10/2026` e `current year is 2026`. Um `v2026` qualquer fica intacto.
- **`clock`** (saída de comando de relógio): todo token de ano delimitado por não-dígitos muda, inclusive o prefixo de `yyyyMMdd`.

Os anos-alvo são o ano real e os vizinhos (±1). Assim, "mês que vem" em dezembro também é coberto.

O plugin **só altera o que o modelo vê**. Argumentos de comandos, relógio do sistema e arquivos não são tocados. Se um hook falhar, o erro é logado com prefixo `[future-clock]` e a sessão segue normalmente.

## Convivência com outros plugins

- O opencode carrega os plugins da config global, depois os do projeto, depois na ordem do array `plugins`. Os hooks rodam em ordem de registro e não há opção de prioridade.
- A passada final no `http.request` reescreve o corpo **depois** de todos os hooks. Se outro plugin reinserir a data real (no system, numa descrição ou na saída do `shell`), o `future-clock` corrige. O resto do texto do outro plugin fica idêntico, byte a byte.
- O formato é detectado pelo corpo, não pela URL. Isso funciona mesmo quando outro plugin troca a URL por uma bridge local. Só o formato **Anthropic Messages** é tratado. Corpos com mensagens de role `system`, `tool` ou `developer` (OpenAI Chat) seguem intactos, com aviso, e para esses providers valem apenas os hooks.
- Validado ponta a ponta com `opencode-model-router` ativo (inclusive nos subagentes que ele cria). O caminho do `opencode-anthropic-fix` (bridge local, corpo em stream) foi validado só em teste unitário.
- **Não suportado:** plugin que altere o corpo da requisição *depois* do `future-clock`.

## Dump para depuração

A variável `FUTURE_CLOCK_DUMP_DIR` grava, para cada requisição, o corpo final enviado ao modelo:

```powershell
$env:FUTURE_CLOCK_DUMP_DIR = "C:\temp\future-dumps"
```

- O caminho tem que ser absoluto, fora do repositório, sem UNC e sem `..`. Caso contrário, o plugin falha no carregamento.
- São gravados `<sessionID>-<kind>-<seq>.json` (o corpo) e `….l3.json` (quantas correções a passada final fez e a origem da URL, só esquema e host). Headers nunca são gravados.
- **Os dumps contêm o prompt e a conversa inteiros**, inclusive instruções globais e conteúdo de arquivos lidos. Não versione, não compartilhe e apague depois.

---

## Desenvolvimento

| Comando | O que faz |
|---|---|
| `bun run check` | typecheck + testes unitários + build |
| `bun run test` | testes unitários (rápidos, sem rede) |
| `bun run build` | gera `dist\future-clock\` |
| `bun run test:e2e` | suíte ponta a ponta contra o opencode real (E0–E6). Compila antes. Execução única, log completo em arquivo |
| `bun run experiment` | experimento controle × tratamento. Compila antes, é retomável (repita até imprimir `COMPLETE`) e gera `runs\summary.json` |
| `bun run sandbox` / `sandbox:control` | recria o sandbox com / sem o plugin |
| `bun run cleanup` | apaga sandbox e configs temporárias; **preserva** runs e dumps |
| `bun run preflight` / `probe` | captura o ambiente e sonda a API de plugins da v2 (usados no planejamento) |

### Ambiente de teste

- **Sandbox:** `D:\future-sandbox`, com `git init`. Fica **fora da pasta do usuário** porque o opencode procura `AGENTS.md` subindo diretórios; dentro do home, o `AGENTS.md` global vazava para o teste.
- **Isolamento:** `XDG_CONFIG_HOME` apontando para uma config vazia, mais `opencode run --standalone`. `OPENCODE_CONFIG_DIR` não substitui a config global. O cenário E6 roda de propósito **sem** isolamento, para exercitar os plugins globais reais.
- **Ambiente do processo filho:** o runner limpa `INIT_CWD`, `npm_*` e `OPENCODE_*` herdados. Sem isso, o opencode filho iniciava no diretório do repositório em vez do sandbox.
- **Modelo padrão:** `opencode-go/claude-haiku-5-5`.
- **Artefatos** (runs, dumps, estado, logs) ficam em `%TEMP%\Claude\future-artifacts\`. Os caminhos são constantes em `scripts/lib/artifacts.ts`; ajuste-os em outra máquina.

## Limitações

- **O dia da semana não muda:** 12/10/2146 é quarta, mas o modelo vê "Mon". Um 29/02 pode virar uma data inexistente.
- **Continuam no ano real:** epoch e ticks, web, conteúdo de arquivos, `git log`, mtimes e headers HTTP.
- **Saídas compostas:** numa saída de relógio que também lista arquivos, nomes com o ano atual são trocados (o modelo vê `log-2146…`, o disco tem `log-2026…`).
- **Datas digitadas pelo modelo não são revertidas.** Por exemplo, `git log --since=2146-01-01` volta vazio.
- **Leituras indiretas** do relógio, como um script em arquivo, não são detectadas.
- **Formatos não cobertos:** `Oct 2026`, `12-Oct-2026`, `Current year: 2026`, `yy`, `yyyyMM`.
- **Lacunas do classificador de comandos:** `/usr/bin/date`, `TZ=UTC date`, crases, `$d = date`, `$(` dentro de aspas duplas.
- **Observadores:** plugins que só *leem* eventos podem ver o ano real.

## Estrutura

```
src/core/         troca de ano (years.ts) e classificador de comandos (classify.ts), puros
src/plugin/       entrypoint, adaptador do host, hooks context / execute.after / http.request, wire format
scripts/          build, sandbox, runner do opencode, experimento, limpeza, pre-flight e probes
test/unit/        testes unitários (inclui convivência com plugins vizinhos e varredura de segredos)
test/e2e/         suíte ponta a ponta (só roda via bun run test:e2e)
docs/plans/       plano de implementação e evidências (pre-flight, decisões, QA, e2e)
docs/experiments/ relatório do experimento
```

## Licença

[MIT](LICENSE)
