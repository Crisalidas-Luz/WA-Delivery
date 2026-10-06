# WA-Delivery — handoff de desenvolvimento

## Como usar este arquivo

Atualizar este documento ao final de cada etapa relevante, antes do commit. Registrar somente o
estado real e verificável: branch, último commit, mudanças concluídas, validações executadas,
pendências e próximo passo. Não substituir o plano completo de produto em `AGENTS.md`.

## Estado atual

- Branch de desenvolvimento: `feat/google-contacts-campaign-flow`
- Base: `main` no commit `cfc3881`
- Etapa concluída: Fase 0 — decisões técnicas e fundação
- Merge para `main`: proibido até validação integral e aprovação do usuário

## Progresso

### Fase 0 — fundação

Concluído:

- migration v10 para conta Google, sincronização, agenda local, telefones, labels, filtros salvos e
  auditoria de exclusão;
- contrato abstrato do Google People Provider e do armazenamento seguro de tokens;
- AST versionada e validação inicial dos filtros inteligentes;
- taxonomia de elegibilidade, resultado e recomendação de exclusão;
- testes da migration e dos contratos puros.

Detalhes implementados:

- schema atualizado da versão 9 para a versão 10;
- restrição de uma única conta Google ativa por instalação;
- tabelas de conta, estado de sincronização, contatos, telefones, labels, filtros salvos e jobs/itens
  de exclusão;
- contrato `GooglePeopleProvider`, tipos de OAuth/contatos e contrato `GoogleTokenStore`;
- AST de filtros v1 com allowlists, grupos `and`/`or`, limite de profundidade e validação;
- taxonomia inicial de elegibilidade/resultados e política conservadora de recomendação de exclusão;
- 7 novos testes, totalizando 136 testes no projeto.

## Validações da última etapa

- `npm.cmd run typecheck`: passou.
- `npm.cmd run lint`: passou.
- `npm.cmd run format:check`: passou.
- `npm.cmd test`: 136 testes passaram, 0 falharam.
- `npm.cmd run build`: passou.
- Observação do ambiente: dentro do sandbox, o loader `tsx` falhou em `uv_os_get_passwd` com
  `ENOMEM`; a mesma suíte executada fora do sandbox passou integralmente.
- `npm ci` reportou uma vulnerabilidade de severidade alta em dependência; ainda precisa ser
  analisada sem aplicar atualização automática incompatível.

## Próximo passo

1. Fazer commit e push da Fase 0 no branch de desenvolvimento.
2. Iniciar Fase 1 com repositórios da conta/agenda e implementação do cofre de tokens.
3. Implementar OAuth Google e sincronização por páginas atrás do contrato já criado.

## Decisões e cuidados ativos

- Tokens Google persistem fora do diretório incluído no backup `.wabkp`.
- Nenhuma credencial ou token real pode entrar no Git, logs ou respostas da API.
- Exclusão Google nunca é automática.
- Falha transitória de envio não constitui evidência de contato inválido.
- A aplicação não deve retomar disparos silenciosamente após reinício.
