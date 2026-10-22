# Pesquisa: @hallaxius/skills — alterações desde o npm 1.0.0

**Data da pesquisa:** 17 de outubro de 2026  
**Autor do relatório:** pesquisador externo (read-only)  
**Dono do pacote/repositório:** airshakur88 (GitHub Hallaxius/skills)  
**Projeto consumidor:** @hallaxius/omo-beta (pasta atual)

---

## 1. Sumário executivo

Desde o lançamento 1.0.0 do @hallaxius/skills (npm, 24 set 2026), houve uma unica nova versao publicada: 1.1.0 (npm, 17 out 2026, latest). O repositorio GitHub tem apenas a tag/release v1.0.0; nao existe release nem tag v1.1.0 no GitHub, embora o HEAD de main contenha o commit de versao 1.1.0. A mudanca funcional e a adicao de gerenciamento local de skills (instalar/atualizar/remover/listar/verificar skills em diretorios canonicos .agents/skills), mantendo todos os 5 tools de descoberta existentes. Nao ha alteracao de dependencias, engines, autenticacao de discovery, CLI de execução ou transporte MCP.

---

## 2. versoes e datas observadas (npm registry)

Fonte: https://registry.npmjs.org/@hallaxius/skills e versoes individuais.

| Campo | 1.0.0 | 1.1.0 |
|---|---|---|
| versao | 1.0.0 | 1.1.0 |
| dist-tags.latest | - | 1.1.0 |
| Publicacao (npm time) | 2026-09-24T03:23:55.485Z | 2026-10-17T22:09:46.381Z |
| created / modified (pacote) | created: 2026-09-24T03:23:55.212Z | modified: 2026-10-17T22:09:46.563Z |
| dist.tarball | .../skills-1.0.0.tgz | .../skills-1.1.0.tgz |
| dist.shasum | 603a81de...510b | a76eeca0...ad |
| dist.integrity | sha512-hdWMdtoz+... | sha512-X2iUOoTg262tVM471p/+8Hy450u... |
| dist.fileCount | 4 | 4 |
| dist.unpackedSize | 61848 bytes | 124961 bytes (aprox +102 pct / aprox +63 KB) |
| dist.signatures | 1 assinatura | 2 assinaturas (mesma keyid SHA256:DhQ8wR5APBvFHLF/...) |
| _npmUser | airshakur88 / airshakur88@gmail.com | idem |
| _npmVersion | 10.8.3 | 10.8.3 |
| _nodeVersion | 26.3.0 | 26.3.0 |
| maintainers | airshakur88 | airshakur88 |
| publishConfig.access | public | public |

Citacoes (permalink):
- Pacote completo: https://registry.npmjs.org/@hallaxius/skills
- 1.0.0: https://registry.npmjs.org/@hallaxius/skills/1.0.0
- 1.1.0: https://registry.npmjs.org/@hallaxius/skills/1.1.0
- Tarball 1.0.0: https://registry.npmjs.org/@hallaxius/skills/-/skills-1.0.0.tgz
- Tarball 1.1.0: https://registry.npmjs.org/@hallaxius/skills/-/skills-1.1.0.tgz

Limite observado: os tarballs sao application/octet-stream e nao puderam ser lidos como texto pelo fetcher; portanto o conteudo exato dos arquivos dist/ publicados nao foi inspecionado diretamente. Toda a analise de codigo abaixo vem do repositorio GitHub (tag v1.0.0 e HEAD de main), nao do tarball publicado.



## 3. Consistencia GitHub vs npm

| Item | GitHub | npm | Consistente? |
|---|---|---|---|
| Versao publicada | - | 1.1.0 (latest) | - |
| Tag GitHub existente | v1.0.0 apenas | - | v1.1.0 NAO existe |
| Release GitHub existente | v1.0.0 (id 395276660, publicado 2026-09-24T03:04:42Z) | - | Release v1.1.0 NAO existe (404 ao consultar tag v1.1.0) |
| Tag v1.0.0 commit | 48633b31c058f18da3b1808445a9207f584f12da (Initial commit) | - | - |
| HEAD de main | commit b76fc6b1 (Update package.json, 2026-10-17T22:02:15Z) | versao 1.1.0 | Coerente: versao bump 7 min antes da publicacao npm |
| Commit funcional principal | dddcef92 (Add local GitHub skill management tools, 2026-10-17T21:33:50Z) | - | 2594 adicoes / 38 delecoes |

Conclusao de consistencia: o npm 1.1.0 reflete o HEAD de main (commit b76fc6b1 apos dddcef92), mas nao ha tag nem release GitHub correspondente. Qualquer verificacao tag corresponde a versao publicada falharia para 1.1.0. Isso e um gap de rastreabilidade: nao ha como vincular criptograficamente o tarball 1.1.0 a um commit/tag GitHub imutavel.

Permalinks GitHub:
- Repositorio: https://github.com/Hallaxius/skills
- Tag v1.0.0: https://github.com/Hallaxius/skills/releases/tag/v1.0.0
- Commit v1.0.0: https://github.com/Hallaxius/skills/commit/48633b31c058f18da3b1808445a9207f584f12da
- Commit funcional dddcef92: https://github.com/Hallaxius/skills/commit/dddcef92f2f9c5b1bcdab4bce0d90e180d6449a8
- Commit versao b76fc6b1: https://github.com/Hallaxius/skills/commit/b76fc6b15decd0312bcdd2385a1c1a07b50be608
- package.json em v1.0.0: https://github.com/Hallaxius/skills/blob/v1.0.0/package.json
- package.json em main: https://github.com/Hallaxius/skills/blob/main/package.json
- README em v1.0.0: https://github.com/Hallaxius/skills/blob/v1.0.0/README.md
- README em main: https://github.com/Hallaxius/skills/blob/main/README.md



## 4. package.json — antes vs depois

Antes (v1.0.0, tag 48633b31): versao 1.0.0; bin skills-sh-mcp ./dist/index.js (com ./); devDependencias identicas.

Depois (main, HEAD b76fc6b1): versao 1.1.0; bin skills-sh-mcp dist/index.js (sem ./); tudo o mais identico.

Diff exato de package.json (apenas a linha da versao e a do bin):

- versao: 1.0.0
+ versao: 1.1.0
- skills-sh-mcp: ./dist/index.js
+ skills-sh-mcp: dist/index.js

Campos inalterados: name, description, keywords, license, author, homepage, bugs, repository, type module, files [dist], engines { node: >=18 }, scripts, publishConfig.access public, dependencias { @modelcontextprotocol/sdk: ^1.30.1, zod: ^4.6.5 }, devDependencias { @types/bun: latest, publint: ^0.3.24, typescript: ^7.0.2 }.

Verificacao de compatibilidade de dependencias: nenhuma dependencia mudou; ^1.30.1 e ^4.6.5 permanecem ranges menores (nao exatos), portanto versoes de patch/minor dos upstreams podem ser resolvidas no install. Isso nao e uma alteracao introduzida pelo 1.1.0, mas permanece como risco de reprodutibilidade preexistente.



## 5. Mudanca funcional: gerenciamento local de skills (novo em 1.1.0)

O commit dddcef92 adiciona 5 tools mutaveis (todos com preview read-only por padrao e confirmacao explicita para gravacao) e remove a limitacao apenas descoberta. Resumo dos tools (do README de main):

| Tool | Escopo | Gravacao? | Token necessario |
|---|---|---|---|
| list_installed_skills | projeto ou global (.agents/skills) | Nao (leitura) | Nao |
| check_skill_updates | projeto ou global | Nao (leitura) | Opcional (GitHub) |
| install_skill | projeto ou global | Sim (preview p/ confirmacao) | Opcional (GitHub) |
| update_skill | projeto ou global | Sim (preview p/ confirmacao) | Opcional (GitHub) |
| remove_skill | projeto ou global | Sim (preview p/ confirmacao) | Nao |

Novos arquivos-fonte (commit dddcef92, 2594 adicoes):
- src/services/github-skills.ts (212 linhas) — árvores/git blobs do GitHub
- src/services/local-skills.ts (460 linhas) — leitura/gravacao local .agents/skills
- src/tools/local-skills.tool.ts (215 linhas) — registro dos 5 tools
- src/types/local-skills.ts (73 linhas) — tipos de lock/estado
- src/utils/skill-files.ts (189 linhas) — staging, hashing, CRLF, bounds

Arquivos modificados: README.md (+135/−17), package.json (+1/−1), scripts/mcp-smoke.ts (+45/−10), src/config.ts (+26), src/errors.ts (+6/−1), src/server.ts (+27/−3), src/tools/register.ts (+8/−1), src/utils/install.ts (+1/−1).

Novos testes: tests/github-skills.test.ts (160), tests/local-config.test.ts (23), tests/local-skills.test.ts (624), tests/tools.e2e.test.ts (+389/−4).

Modelo de seguranca dos tools mutaveis:
- SKILLS_ALLOW_MUTATIONS=true exigido no ambiente do servidor para execução; prévias funcionam sem ele.
- confirmation_token (SHA-256) vincula operacao, escopo, caminho, lock e snapshot upstream — e freshness, nao autenticacao nem prova de consenso (o cliente MCP impõe aprovacao).
- Downloads verificados contra hashes de blob Git imutáveis e tamanho antes da gravacao.
- Nao executa scripts, git, npm, shell ou comandos do OpenCode; usa Node built-ins + GitHub Git Data API.
- Snapshots limitados: 256 arquivos, 2 MiB/arquivo, 16 MiB total, caminhos <= 500 chars / 20 componentes; symlinks, junctions, submodules, caminhos colidentes, device names Windows, arquivos especiais e .git/node_modules sao recusados.
- Nao e transacao de filesystem crash-atomic; .agents/.skills-mcp.lock, .skills-mcp-txn-*, .skills-mcp-*.tmp e recovery.json devem ser preservados em caso de interrupcao.

Citacoes de codigo-fonte (GitHub main):
- src/services/local-skills.ts: https://github.com/Hallaxius/skills/blob/main/src/services/local-skills.ts
- src/tools/local-skills.tool.ts: https://github.com/Hallaxius/skills/blob/main/src/tools/local-skills.tool.ts
- src/types/local-skills.ts: https://github.com/Hallaxius/skills/blob/main/src/types/local-skills.ts
- src/utils/skill-files.ts: https://github.com/Hallaxius/skills/blob/main/src/utils/skill-files.ts



## 6. Tools de descoberta — inalterados (5 tools, 7 read-only em 1.0.0 → 10 total em 1.1.0)

Antes (1.0.0): search_skills, get_top_skills, get_skill, get_skill_audits, get_official_skills (todos read-only).

Depois (1.1.0): os mesmos 5 discovery tools, inalterados em assinatura e comportamento, acrescidos dos 5 tools de gerenciamento local acima.

Variaveis de ambiente inalteradas em escopo: VERCEL_OIDC_TOKEN (semantic search + include_files), SKILLS_MIN_INTERVAL_MS, SKILLS_TIMEOUT_MS. Novas em 1.1.0: SKILLS_PROJECT_ROOT (raiz do projeto aprovada, nunca inferida), SKILLS_ALLOW_MUTATIONS (exige true exato para gravacoes), GITHUB_TOKEN/GH_TOKEN (apenas api.github.com), XDG_STATE_HOME (metadata global CLI).

Transporte: stdio MCP, sem telemetry, stdout so JSON-RPC, logs em stderr.



## 7. Riscos de compatibilidade e avaliacao para o OmO

O OmO (@hallaxius/omo-beta, 0.1.0-beta.1) e um produto V2-first, TypeScript ESM, Bun, com entrada inicial Promise de @opencode/plugin. Nao ha evidencia no escopo de que o OmO integre ou dependa do @hallaxius/skills. A avaliacao abaixo e condicional, caso o OmO adote o MCP server como ferramenta de descoberta/instalacao de skills.

Riscos observados (evidencia direta):

1. Gap de rastreabilidade GitHub ↔ npm 1.1.0. Nao ha tag/release v1.1.0 no GitHub; o npm 1.1.0 nao pode ser vinculado a um commit imutavel. Para um consumidor que exige provenance, isso e um bloqueio ate que uma tag/release v1.1.0 seja criada.

2. Dependencias nao pinadas exatamente. @modelcontextprotocol/sdk: ^1.30.1 e zod: ^4.6.5 sao ranges menores; @types/bun: latest no devDependencies. Nao e uma regressao do 1.1.0, mas permanece como risco de reprodutibilidade sem lockfile de producao publicado.

3. Nenhum tarball inspecionavel diretamente. O fetcher recusou application/octet-stream; portanto nao foi possivel verificar se o dist/ publicado corresponde ao HEAD de main. A confiabilidade repousa na assinatura npm (2 assinaturas, mesma keyid) e na correspondencia de versoes entre npm e package.json do HEAD.

4. Sem lancamento formal no GitHub para 1.1.0. Ausencia de release notes, changelog ou assets de release; o changelog efetivo e o commit dddcef92 + b76fc6b1.

Impacto no OmO (nao ha decisao de upgrade automatico de runtime)

O usuario pediu investigacao/recomendacoes, nao upgrade automatico de runtime. Nenhuma edicao de producao/config/teste, instalacao do pacote upstream, leitura de segredos/.env/estado do usuario ou publicacao foi realizada. O OmO continua sem dependencia declarada do @hallaxius/skills no seu package.json (dependencias: apenas @opencode/plugin: 2.0.24).

Se optar por integrar:
- Pinar a versao exata do @hallaxius/skills (ex. 1.1.0) e revisar o tarball antes de bloquear.
- Aguardar/solicitar tag/release v1.1.0 no GitHub para rastreabilidade.
- Avaliar o modelo de gravacao local (.agents/skills) contra a politica de isolamento de estado do OmO (estado versionado e isolado por projeto/sessao).



## 8. Limites e incertezas deste relatorio

- Nao foi possivel ler o conteudo binario dos tarballs (application/octet-stream recusado pelo fetcher). A comparacao de codigo-fonte usa o GitHub, nao o tarball publicado.
- Nao foi executado npm pack, npm install, nem qualquer comando do pacote upstream.
- Nao foram lidos .env, segredos, nem qualquer estado de usuario.
- Nao ha confirmacao de que o @hallaxius/skills seja de fato consumido pelo OmO; a avaliacao e condicional.
- Nenhuma instalacao de skill, nenhuma alteracao de configuracao de producao e nenhuma publicacao foram feitas.

## 9. Referencias primarias (permalinks)

- npm registry (pacote): https://registry.npmjs.org/@hallaxius/skills
- npm 1.0.0: https://registry.npmjs.org/@hallaxius/skills/1.0.0
- npm 1.1.0: https://registry.npmjs.org/@hallaxius/skills/1.1.0
- tarball 1.0.0: https://registry.npmjs.org/@hallaxius/skills/-/skills-1.0.0.tgz
- tarball 1.1.0: https://registry.npmjs.org/@hallaxius/skills/-/skills-1.1.0.tgz
- GitHub repo: https://github.com/Hallaxius/skills
- Release v1.0.0: https://github.com/Hallaxius/skills/releases/tag/v1.0.0
- Commit v1.0.0: https://github.com/Hallaxius/skills/commit/48633b31c058f18da3b1808445a9207f584f12da
- Commit funcional dddcef92: https://github.com/Hallaxius/skills/commit/dddcef92f2f9c5b1bcdab4bce0d90e180d6449a8
- Commit versao b76fc6b1: https://github.com/Hallaxius/skills/commit/b76fc6b15decd0312bcdd2385a1c1a07b50be608
- package.json v1.0.0: https://github.com/Hallaxius/skills/blob/v1.0.0/package.json
- package.json main: https://github.com/Hallaxius/skills/blob/main/package.json
- README v1.0.0: https://github.com/Hallaxius/skills/blob/v1.0.0/README.md
- README main: https://github.com/Hallaxius/skills/blob/main/README.md
- skills.sh: https://skills.sh (referenciado como fonte de dados, nao afiliada)

Fim do relatorio. O pai deve verificar independentemente as evidencias-chave e detem toda decisao de integracao. Nenhuma alteracao foi feita ao OmO nem ao repositorio upstream.

---

## 10. Consolidacao local OmO (verificacao independente do pai, 17 out 2026)

Esta secao foi escrita pelo pai apos consumir o relatorio acima, os resultados de dois
agentes delegados (pesquisa de fontes primarias e mapeamento read-only do OmO) e a
verificacao independente dos tarballs. Corrige, completa e traduz as descobertas em
recomendacoes concretas. Nenhuma alteracao de runtime/config/teste foi feita nesta tarefa.

### 10.1 Correcao ao item 7 acima ("no evidence OmO integrates @hallaxius/skills")

O OmO **sim** consome o @hallaxius/skills: e o MCP local padrao "skills", lancado por
`skillsMcpCommand` (`src/config/runtime.ts:48-56`) como `[runner, ...flags, "@hallaxius/skills"]`
(bunx padrao; npx -y / yarn dlx / pnpm dlx conforme package manager). O que nao existe e
dependencia declarada no `package.json` do OmO (unicas deps: `@opencode/plugin` 2.0.24),
nem pin de versao: todas as invocacoes usam o seletor mutavel `@hallaxius/skills`, sujeitas
ao cache do package runner (mcp-security-audit, Check 3, classe MEDIUM).

### 10.2 Verificacao que supre os limites do item 8 (tarballs "ilegiveis")

O pai baixou ambos os tarballs do registry, verificou o SHA-512 contra o `dist.integrity`
oficial de cada versao, extraiu os 4 arquivos allowlisted (package.json, README.md,
LICENSE, dist/index.js) com um parser tar bounded (sem instalar/executar nada upstream) e
comparou os bundles e os documentos contra o GitHub raw no SHA do HEAD
(`b76fc6b15decd0312bcdd2385a1c1a07b50be608`). Resultados salvos em
`out/research/skills-upstream/upstream-comparison.json`:

- Ferramentas MCP: 1.0.0 registra 5 tools; 1.1.0 registra 10; nenhuma removida.
  Adicionadas exatamente: `check_skill_updates`, `install_skill`, `list_installed_skills`,
  `remove_skill`, `update_skill`. `SERVER_VERSION` = 1.1.0 no bundle novo.
- `dependencies` (zod ^4.6.5, @modelcontextprotocol/sdk ^1.30.1) e `engines` (node >=18)
  identicos entre versoes. Mudanca de `bin` apenas normalizacao de caminho
  (`./dist/index.js` -> `dist/index.js`).
- Proveniencia npm vs GitHub HEAD: `package.json` byte-identico (sha256 b1d1a6ef...);
  `README.md` e `LICENSE` diferencam apenas por normalizacao CRLF (GitHub) -> LF (npm),
  comprovada empiricamente (github 2705bcf5.../03237317... vs npm 259a2b17.../087cd411...).
  Como o `gitHead` esta ausente no registro npm e nao existe tag v1.1.0, a equivalencia com
  o HEAD e **por conteudo**, nao por metadado.
- Assinaturas npm conferidas independentemente: 1.0.0 = 1 assinatura; 1.1.0 = 2 assinaturas,
  mesma keyid (SHA256:DhQ8wR5APBvFHLF/+...). devDependencies do 1.1.0 incluem
  `@types/bun: latest` (risco de reprodutibilidade upstream, sem impacto no consumidor).

### 10.3 Mapa de integracao local (evidencias file:line, leitura read-only)

- Preset "skills": `src/mcp/config.ts:3,163,201` (id, transportKeys `command/cwd/environment`,
  habilitado por padrao); preset local montado em `src/mcp/registry.ts:60-77`; entrada de
  mesmo nome do host sempre vence (`registry.ts:139`); referencias `{env:...}` resolvidas por
  `substituteString` (`registry.ts:86-92`), variavel ausente desabilita apenas aquele servidor
  (`registry.ts:120`); loader de `.env` ao lado do `omo.jsonc` ativo:
  `src/config/environment.ts:7-23` (concluido em tarefa anterior; ja suporta os novos envs
  sem mudanca de schema).
- Doctor: checagem `mcp-skills` opcional (`src/doctor/mcp.ts:166-177`), remedicao apenas
  sugere o comando (`:75`); floor do SDK 2.0.24 / host verificado 2.0.29
  (`src/doctor/host.ts:28,37`). O doctor nao percebe versao/pin/capacidade do MCP hoje.
- Auto-installer atual: usa a CLI oficial **separada** `skills add ... -y`
  (`src/skills/installer.ts:9-11`, timeout 120s `:27-32`); busca em endpoint nao documentado
  `skills.sh/api/search` (`src/skills/ensure.ts:33,63-79,110`); auditorias contra
  `https://skills.sh` fixo (`src/skills/audits.ts:22-25`); `skills-lock.json` local pinha hash
  de conteudo de skills instaladas, **nao** a versao do pacote MCP.
- Testes/seams: `test/integration/package.test.ts:90-93,180-182` (comandos esperados),
  `test/unit/doctor.test.ts:394-411` (strings de remedicao), mocks hermeticos em
  `test/unit/runtime.test.ts:122-134`. O smoke atual de MCP usa fixture local fake, nao o
  1.1.0 real — compatibilidade com 1.1.0 ainda nao esta validada por teste.

### 10.4 Recomendacoes faseadas (sem alteracao automatica; exigem decisao/aprovacao)

- **P0 — adocao segura e read-only**
  1. Pin exato revisado `@hallaxius/skills@1.1.0` no comando do MCP (override existente
     ja basta; apos validacao, tornar o pin o padrao de `skillsMcpCommand`). Um pin exato
     direto **nao congela** ranges transitive (zod ^, sdk ^) sem lock controlado.
  2. Smoke de capacidade com o 1.1.0 pinado: 10 tools expostos, leituras confinadas a um
     projeto temporario via `SKILLS_PROJECT_ROOT`, `SKILLS_ALLOW_MUTATIONS=false` recusa
     escritas, preview nao altera disco, token de confirmacao obedece, CRLF/junctions no
     Windows, reload/cancelamento do host.
  3. No preset padrao, definir explicitamente `SKILLS_ALLOW_MUTATIONS: "false"` e apontar
     `SKILLS_PROJECT_ROOT` para o diretorio real do projeto (`ctx.location.directory`, nao o
     cwd do host nem a pasta do omo.jsonc), preservando overrides do usuario.
  4. Nao encaminhar `GITHUB_TOKEN`/`GH_TOKEN` ou `VERCEL_OIDC_TOKEN` globalmente: mapear
     apenas quando o usuario pedir, por servidor, via `environment` explicito.
- **P1 — governanca**
  1. Doctor: relatar, sob demanda, seletor pinado/nao-pinado e catalogo de tools via
     `ctx.tool.list()`; nunca adivinhar versao pelo status "connected" nem ler valores secretos.
  2. Politica de permissao do host para tools mutantes (`skills_install_skill`,
     `skills_update_skill`, `skills_remove_skill`): deny ate opt-in explicito; o
     `confirm:true` + token upstream e frescor, nao consentimento humano.
  3. Decidir politica de auditoria estrita para o auto-installer atual (hoje apenas verdict
     `fail` bloqueia; `warn`/`unknown` prosseguem — comportamento existente, nao regressao).
- **P2 — migracao consentida (opcional)**
  Adaptador do instalador nativo 1.1.0 (preview + confirmacao) em substituicao **parcial** ao
  CLI `skills add`. Nao e drop-in: o SDK 2.0.24 (`McpDomain`) nao expoe `callTool`; seria
  necessaria invocacao publica autorizada pelo host. Manter um unico escritor por skill e
  manter o CLI para fontes nao-GitHub/ref especificos.

### 10.5 Limites de evidencia desta consolidacao

- Sem tag/release v1.1.0 no GitHub e `gitHead` ausente no npm: proveniencia por conteudo
  (incl. normalizacao CRLF/LF), nao por metadado.
- Nada do upstream foi instalado/executado; nenhuma skill foi instalada/removida; nenhum
  segredo/.env/estado do usuario foi lido. Context7 indisponivel (quota mensal excedida);
  site npmjs retornou 403 (HTML) — usada a registry API oficial. GitHub get_latest_release
  so mostra v1.0.0; nao usar esse endpoint sozinho para detectar a 1.1.0.
- O catalogo da presente sessao ainda expunha apenas os 5 tools antigos (pre-reconexao);
  isso nao prova a versao em processo. A recomendacao de upgrade fica pendente de validacao
  real (P0) e decisao do usuario.

### 10.6 Referencias adicionais usadas nesta secao

- Comparacao tecnica produzida pelo pai: `out/research/skills-upstream/upstream-comparison.json`
  (script `out/research/verify-skills-delta.ts`, scratch ignorado pelo VCS).
- Mapeamento local detalhado: `out/research/explore-final.md` (agente explore, read-only).
- Docs oficiais OpenCode V2 (MCP local `environment` herdado, cwd, `{env:NAME}`, acoes de
  permissao por nome normalizado `<server>_<tool>`): https://opencode.ai/v2/docs/mcp-servers
- Fontes upstream citadas nos itens 1-9 acima (permalinks).

---

## 11. Status de implementacao (17 out 2026, pos-aprovacao do usuario)

O usuario aprovou a execucao das recomendacoes. O que foi implementado e verificado no OmO:

- **P0.1 — Pin exato.** `skillsMcpCommand` agora lanca `@hallaxius/skills@1.1.0` em todos os
  package managers (`src/config/runtime.ts`); `isPinnedSkillsCommand` expoe a verificacao.
- **P0.2 — Smoke de capacidade.** Novo `bun run test:skills-capability`
  (`scripts/skills-capability-smoke.ts`): instala o pacote pinado em sandbox isolado, prova o
  catalogo exato de 10 tools, inventario read-only do projeto (`fixture-skill` listado,
  nao gerenciado), recusas `PERMISSION_DENIED` para install/remove com mutacoes desabilitadas,
  ausencia de lock/arquivos escritos, preview com `confirmation_token` emitido e disco
  intacto. Evidencia em `%LOCALAPPDATA%/Temp/opencode/hallaxius-omo-beta-skills-capability-*.json`.
- **P0.3 — Defaults seguros.** O preset skills define `SKILLS_ALLOW_MUTATIONS="false"` e
  `SKILLS_PROJECT_ROOT` = diretorio da location; entradas `environment` do usuario vencem
  por chave (`src/mcp/registry.ts`). O smoke de host real (OpenCode 2.0.29) provou que os
  defaults chegam ao subprocesso e vencem um herdado `"true"`.
- **P1.1 — Doctor por capacidade.** Nova checagem `mcp-skills-capability`
  (`src/doctor/mcp.ts` + `diagnose.ts` + `host.ts`) via `ctx.tool.list()`: falha com catalogo
  vazio ou so 1.0.0 (cache do runner/host restart), unknown em catalogo inesperado; nunca le
  metadados de versao nem segredos; skip quando ausente/desabilitado/desconectado.
- **P1.2 — Documentacao de permissao.** README registra o opt-in de mutacoes e o snippet
  `permissions` deny para `skills_install_skill`/`skills_update_skill`/`skills_remove_skill`.
- **P1.3 — Auditorias estritas.** `skills.strictAudits` (default `false`) recusa `warn` e
  `unknown` no auto-installer quando habilitado; comportamento historico preservado por padrao.
- **P2 — Bloqueado por SDK.** ADR 0003 registra o bloqueio: `McpDomain` do SDK 2.0.24 nao
  expoe invocacao autorizada de tools; CLI `skills add` segue como unico escritor. Revisitar
  quando o SDK publico expor caminho autorizado.

Verificacao observada pos-implementacao: `bun run check` verde (751 unit + 343 integracao,
0 falhas), `bun run test:package` verde, `bun run test:mcp-host-package` verde (evidencia com
`skillsMutationsDisabledDefault` e `skillsProjectRootConfigured`), `bun run
test:skills-capability` verde (10 tools, recusas, preview `ok/tokenIssued/diskUnchanged`).
Nenhuma autenticacao real de terceiros foi testada; o probe de preview usou o repositorio
publico anthropics/skills (best-effort, registrado na evidencia). Pendencias externas:
criacao de tag/release v1.1.0 no GitHub upstream (requer confirmacao do dono) e configuracao
do token real pelo usuario.

