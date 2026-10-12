# future-clock

Plugin do opencode v2 que faz o modelo perceber o **ano** atual como `ano real + N`. Só o ano muda: dia, mês, hora e dia da semana ficam como estão (`Today's date: Mon Oct 12 2026` vira `Today's date: Mon Oct 12 2146` com `years: 120`).

## Requisito

- **Apenas opencode v2.** Testado com 2.0.27. A v1 não é suportada.
- Bun (para instalar e compilar). Testado com 1.3.14.

## Instalação e configuração

```powershell
bun install
bun run build
```

O build gera o **diretório** `dist\future-clock` (`package.json` + `server.js`). O opencode v2 exige um diretório: caminho de arquivo ou URL `file://` é rejeitado.

Em `opencode.json`:

```json
{
  "plugins": [
    { "package": "D:\\git\\future-agents\\dist\\future-clock", "options": { "years": 120 } }
  ]
}
```

### Opção

| Opção | Tipo | Padrão | Regra |
|---|---|---|---|
| `years` | inteiro | `120` | `years >= 4` ou `years <= -3`, e o ano resultante em [1000, 9999]. Valor inválido gera erro claro no `setup`. |

É a única opção. Os limites `>= 4` / `<= -3` garantem idempotência quando o ano real vira entre dois eventos.

## O que é deslocado

| Id | Fonte | Onde |
|---|---|---|
| S1 | Linha `Today's date: …` no system | hook `context` |
| S2 | Linha `Today's date is now: …` (virada de dia) no histórico | hook `context` |
| S3 | `The current year is YYYY` nas descrições de tools (ex.: `websearch`) | hook `context` |
| S4 | Saída de comandos que leem o relógio no tool `shell` (`Get-Date`, `date`, `[DateTime]::Now`, `Date.now()`, `datetime.now()` …) | hook `execute.after` |

Além dos hooks, há uma **passada final** no hook `http.request`: o body já serializado é reescrito aplicando as mesmas regras a system, descrições, linha de virada e tool results de `shell` classificados. Em mensagens do usuário só são deslocadas as linhas que começam com `Today's date is now:`; o texto do assistente nunca é alterado.

Nos modos `context` (system, descrições) o ano só é trocado em padrões com forma de data (linha `Today's date`, `current year is`, ISO `YYYY-MM-DD`, `Mon Oct 12 YYYY`, `October 12, YYYY`, `12 de outubro de YYYY`, `dd/mm/YYYY`). No modo `clock` (saída do `shell` classificada) qualquer token de ano delimitado por não-dígitos é trocado, e o prefixo de sequências compactas `yyyyMMdd…`.

## Convivência com outros plugins e "última palavra"

- O opencode carrega os plugins da config global primeiro, depois a do projeto, depois pela posição no array `plugins`. Os hooks rodam na ordem de registro. Não há opção de prioridade.
- Use o `future-clock` na config do projeto, por último no array.
- A passada final em `http.request` reescreve o body que realmente vai ao provider. Ela detecta o formato pelo body, não pela URL: JSON com array `messages`, nenhuma mensagem com role `system`/`tool`/`developer` e `system` ausente, string ou array (bodies OpenAI Chat ficam intocados, com aviso). Preserva URL, método, headers e `signal`. Assim, o que outros plugins injetarem antes (texto, datas, URL de bridge) é corrigido no ano e o resto do texto deles fica idêntico.
- Testado com formas de `opencode-model-router` (hooks `context`/`execute.*`, sem `http.request`) e `opencode-anthropic-fix` (troca a URL por uma bridge local e usa body em streaming).
- **Não suportado:** plugin que mute o body **depois** do `future-clock`.
- Hooks nunca derrubam a sessão: erros são logados (`[future-clock] …`) e o evento segue intacto.

## Dump para depuração

A env `FUTURE_CLOCK_DUMP_DIR` liga o dump na fronteira `http.request`.

```powershell
$env:FUTURE_CLOCK_DUMP_DIR = "C:\Users\<voce>\Temp\future-dumps"
```

- O caminho deve ser **absoluto**, fora do repositório, sem UNC, sem caminho relativo à raiz e sem `..`. Caso contrário o plugin falha no `setup` com mensagem explícita.
- Grava **somente bodies** (`<sessionID>-<kind>-<seq>.json`, mais um `.l3.json` lateral com o número de correções e a **origem** da URL da requisição: esquema + host, sem path nem query). Não grava headers.
- **Atenção:** o body contém o seu prompt e a conversa completos (system, mensagens, resultados de tools, conteúdo de arquivos lidos). Trate os arquivos como sensíveis, não os versione nem os compartilhe, e apague-os depois do uso.

## Scripts

| Comando | Função |
|---|---|
| `bun run check` | typecheck + testes unitários + build |
| `bun run build` | gera `dist\future-clock` |
| `bun run sandbox` / `sandbox:control` | recria o sandbox com / sem o plugin |
| `bun run test:e2e` | suíte ponta a ponta, execução única (não retomável); log completo em `%TEMP%\Claude\future-artifacts\state\e2e-*.log` |
| `bun run experiment` | compila primeiro; bateria controle × tratamento retomável; grava `runs\summary.json` ao final |
| `bun run cleanup` | apaga `D:\future-sandbox`, `D:\future-probe`, a config isolada e `probe\dist`; preserva `runs` e `dumps` |

### Sandbox e isolamento

- O sandbox fica em `D:\future-sandbox`, **fora do home**: o opencode procura `AGENTS.md` subindo os diretórios, e um sandbox sob o home herda o `AGENTS.md` global.
- O isolamento é `XDG_CONFIG_HOME` apontando para uma config vazia, mais `opencode run --standalone`. `OPENCODE_CONFIG_DIR` não substitui a config global.
- Modelo padrão: `opencode-go/claude-haiku-5-5`.
- `e2e` e `experiment` chamam o opencode real e criam sessões no diretório de dados dele (não isolado).
- **E6 usa a config global real:** carrega os plugins globais e seus dumps contêm o seu `AGENTS.md` global. Trate esses dumps como sensíveis.
- Os caminhos sob `%TEMP%\Claude` são o layout desta máquina (constantes em `artifacts.ts`); ajuste-os em outras máquinas.
- `bun run cleanup` **preserva** `runs` e `dumps`, que são a evidência do relatório. Para apagá-los manualmente: `%TEMP%\Claude\future-artifacts\runs` e `%TEMP%\Claude\future-artifacts\dumps`. Os dumps têm o mesmo caráter sensível descrito acima.

## Limitações

- **Dia da semana permanece:** com 2146, 12/10 continua "Mon" mesmo sendo quarta. Um 29/02 pode virar uma data inexistente.
- Epoch/ticks, web, arquivos, `git log`, mtimes e cabeçalhos HTTP continuam no ano real. Em saída classificada, nomes de arquivo com o ano atual também são trocados (o modelo pode ver `log-2146…` enquanto o disco tem `log-2026…`).
- Datas digitadas pelo modelo não são invertidas.
- Leituras indiretas do relógio (script em arquivo) não são detectadas. Saídas de outros tools que não `shell` não passam pelo classificador.
- **Formatos não cobertos:** `Oct 2026`, `12-Oct-2026`, `2026/10/12`, `Current year: 2026`, `yy`, `yyyyMM`. No modo `clock`, `HHmm` entre 20:25 e 20:27 pode ser deslocado em `yyyyMMdd-HHmm`.
- **Lacunas do classificador de comandos:** `/usr/bin/date`, `TZ=UTC date`, crases (backticks), `$d = date`, `$(` dentro de aspas duplas e `'` desbalanceado em comentários `#` podem gerar falso negativo ou positivo.
- Na fronteira só o formato **Anthropic Messages** é tratado. Para outros providers (inclusive OpenAI Chat) vale apenas o que os hooks (`context`, `execute.after`) cobrem; body desconhecido segue intacto, com aviso.
- Plugins que só leem eventos podem ver o ano real.

## Relatório do experimento

Comparação controle × tratamento em [docs/experiments/future-report.md](docs/experiments/future-report.md).
