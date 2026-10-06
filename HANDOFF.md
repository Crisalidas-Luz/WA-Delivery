# WA-Delivery — handoff de desenvolvimento

## Como usar este arquivo

Atualizar este documento ao final de cada etapa relevante, antes do commit. Registrar somente o
estado real e verificável: branch, último commit, mudanças concluídas, validações executadas,
pendências e próximo passo. Não substituir o plano completo de produto em `AGENTS.md`.

## Estado atual

- Branch de desenvolvimento: `feat/google-contacts-campaign-flow`
- Base: `main` no commit `cfc3881`
- Etapa em andamento: Fase 1 — OAuth e sincronização Google
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

### Fase 1 — OAuth e sincronização Google

Concluído neste marco:

- `GoogleContactsRepository` para conta única, estado de sincronização, upsert transacional de
  contatos e substituição consistente de telefones/labels;
- `GoogleContactsSyncService` com paginação de até 1000 contatos, sincronização completa e
  incremental, contadores e fallback automático quando o sync token expira;
- normalização de telefone na importação, preservando valor bruto e motivo quando inválido;
- armazenamento de tokens em arquivo protegido e gravado atomicamente fora do diretório de backup;
- proteção Windows DPAPI no escopo do usuário atual, sem passar token em argumentos do processo;
- testes de paginação, sync token expirado, telefone inválido e persistência/remoção de tokens.
- cliente HTTP concreto da Google People API sem dependência adicional, com Authorization Code +
  PKCE, state descartável/expirável, refresh, revogação, leitura e exclusão de contatos;
- mapeamento defensivo da resposta `Person`, validação de `resourceName` e tradução de
  `EXPIRED_SYNC_TOKEN` para o fallback do serviço;
- testes do fluxo OAuth e do cliente People API com HTTP simulado.
- `GoogleAuthService` combinando conta, token store, login, refresh antecipado, sincronização,
  revogação e desconexão;
- rotas `/api/google/status`, `/oauth/start`, `/oauth/callback`, `/sync` e `/disconnect`, incluindo
  respostas orientativas quando as credenciais ainda não estão configuradas;
- composição real no `app.ts` via `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, usando DPAPI e arquivo
  em `%LOCALAPPDATA%/WA-Delivery`, portanto fora do backup;
- testes de sessão, renovação, desconexão e rotas não configuradas/configuradas.
- seção Google Contacts em Configurações com status, conta conectada, login, sincronização,
  desconexão, feedback de progresso/erro e tutorial expansível;
- documentação no README para criação das credenciais OAuth e localização/segurança dos tokens.

Ainda pendente na Fase 1:

- adaptador seguro para Linux/WSL e tutorial de credenciais Google Cloud.

## Validações da última etapa

- `npm.cmd run typecheck`: passou.
- `npm.cmd run lint`: passou.
- `npm.cmd run format:check`: passou.
- `npm.cmd test`: 150 testes passaram, 0 falharam.
- `npm.cmd run build`: passou.
- Observação do ambiente: dentro do sandbox, o loader `tsx` falhou em `uv_os_get_passwd` com
  `ENOMEM`; a mesma suíte executada fora do sandbox passou integralmente.
- `npm ci` reportou uma vulnerabilidade de severidade alta em dependência; ainda precisa ser
  analisada sem aplicar atualização automática incompatível.

## Próximo passo

1. Fazer commit e push deste marco da Fase 1.
2. Implementar estratégia segura para Linux/WSL e concluir a Fase 1.
3. Iniciar Fase 2 com repositório de busca e compilador SQL dos filtros inteligentes.

## Decisões e cuidados ativos

- Tokens Google persistem fora do diretório incluído no backup `.wabkp`.
- Nenhuma credencial ou token real pode entrar no Git, logs ou respostas da API.
- Exclusão Google nunca é automática.
- Falha transitória de envio não constitui evidência de contato inválido.
- A aplicação não deve retomar disparos silenciosamente após reinício.
