# @shtora/omo — instruções de implementação

> Refreshed by `init-deep`. Measured: package `@shtora/omo` v0.1.0, branch `main`,
> TypeScript ESM (single workspace, 0 workspaces declared), 88 source files under
> `src/` across 30 domain subdirectories (agents, boulder, config, context, deepini,
> delegation, diagnostics, doctor, events, evidence, execution, goal, handoff, hashline,
> host, lsp, mcp, memory, plans, refactor, runtime, sessions, skills, slashcommands,
> state, teams, telemetry, terminal, todo, worktrees). Bundled via `scripts/build.ts`;
> `bun run build`. Runtime entry Promise of `@opencode/plugin`. Biome for lint/format,
> `tsc` for typecheck.

## Entrada

Leia `docs/PRODUCT-SPEC.md` e os ADRs em `docs/adr/` antes de alterar runtime. Registre decisões arquiteturais novas em `docs/adr/`.

## Contratos do projeto

- Nome npm obrigatório: `@shtora/omo`. Implementação e entregáveis ficam nesta pasta.
- Produto V2-first, TypeScript ESM, ferramentas de desenvolvimento Bun; entrada inicial Promise de `@opencode/plugin`.
- Consulte Context7 e os docs `https://opencode.ai/v2/docs/` para APIs do host. Confirme sintaxe no package/version realmente instalado. Referências V1 servem somente como entrada de migração.
- Código e prompts próprios. Use OmO como referência comportamental; registre origem e licença de qualquer material reutilizado.
- Execute recursos pelo lifecycle público do host. Preserve autorização, ownership pai–filho, cancelamento e notificação quando adicionar delegação própria.
- Estado próprio versionado e isolado por projeto/sessão. Reconcilie sessões após restart antes de repetir execução.
- Trate feedback do usuário como orientação da tarefa ativa. Registre decisões arquiteturais novas em `docs/adr/`.

## Skills

Consulte `docs/SKILLS.md` e carregue somente as skills pertinentes à tarefa — sempre as instaladas no projeto do usuário (`.agents/skills` do projeto, `skills` do `opencode.jsonc`, nativas do host), nunca um catálogo do plugin. Se a ferramenta não reconhecer uma skill instalada, leia `.agents/skills/<nome>/SKILL.md` diretamente. Consulte os docs de plugins, hooks, tools e sessões em `https://opencode.ai/v2/docs/` ao registrar plugins, hooks, tools, sessões ou configurar o host.

## Execução e evidência

Implemente tarefas em ordem de dependência. Use TDD em políticas e máquinas de estado; valide integração com host real. Cada tarefa só termina quando o teste correspondente e os checks aplicáveis passam. Reporte comando, versão e resultado ao usuário.

Pode delegar tarefas independentes e revisão com contexto delimitado; um único executor integra os arquivos compartilhados. A capacidade ou ID do Muse Spark 1.3 deve ser obtida do ambiente, não inferida pelo nome. Sem subagentes disponíveis, execute sequencialmente.

## Entrega

O marco MVP é intermediário. Continue até o escopo completo definido na spec e a validação do pacote instalado em projeto limpo. Se faltar API pública ou serviço externo, registre o bloqueio, sua evidência e prossiga nas tarefas independentes. Um recurso bloqueado não está concluído.

Prepare tarball; publicação npm e alterações globais na configuração do usuário são etapas separadas, mediante solicitação. Preserve arquivos do usuário e descreva migrações de configuração. Use Git/worktrees quando houver repositório; verifique essa condição antes dos comandos.
