# WA-Delivery — handoff de desenvolvimento

## Como usar este arquivo

Atualizar este documento ao final de cada etapa relevante, antes do commit. Registrar somente o
estado real e verificável: branch, último commit, mudanças concluídas, validações executadas,
pendências e próximo passo. Não substituir o plano completo de produto em `AGENTS.md`.

## Estado atual

- Branch de desenvolvimento: `feat/google-contacts-campaign-flow`
- Base: `main` no commit `cfc3881`
- Etapa em andamento: Fase 2 — filtros e seleção
- Merge para `main`: proibido até validação integral e aprovação do usuário
- Sessão pausada a pedido do usuário em 2026-10-07.

### Checkpoint WIP da pausa

- Último marco integralmente validado e publicado: `a521a9a` (`feat: add campaign selection and
  batch schema`), com 162 testes, lint, typecheck e build aprovados.
- Trabalho iniciado depois desse marco: conexão da migration v11 aos tipos, ao
  `CampaignRepository`, ao `CampaignService` e à fila; também foi adicionado
  `resolveSelectionWithContacts` ao serviço de seleção.
- O trabalho pós-`a521a9a` está deliberadamente incompleto e deve ser retomado como WIP. O
  `CampaignService` já referencia os métodos auxiliares `simulateGoogle`, `requireGoogleSelection`
  e `prepareGoogleDraft`, mas eles ainda precisam ser implementados.
- O typecheck ainda precisa ser reexecutado e corrigido. Antes da pausa, os erros conhecidos
  incluíam adaptação do worker para telefone opcional no manifesto, follow-up de snapshots Google,
  retorno dos novos campos de simulação e narrowing de `contactListId`; algumas dessas correções já
  começaram, mas não foram validadas após o último patch.
- Não tratar o próximo commit WIP como etapa funcional. Ao retomar: concluir os três helpers do
  serviço, ajustar fila/follow-up/exportação, compor `ContactSelectionService` antes de
  `CampaignService` em `app.ts`, adicionar testes Google de simulação/rascunho/preparo e só então
  rodar format, typecheck, lint, build e suíte completa.

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
- armazenamento Linux/WSL no Secret Service por `secret-tool`, sem fallback em texto puro, com
  seleção automática do cofre conforme o sistema operacional.

Fase 1 concluída. A validação com uma conta Google real permanece como QA manual dependente das
credenciais do usuário; toda integração está atrás de contratos e coberta por HTTP/cofres simulados.

### Fase 2 — filtros e seleção

Concluído neste marco:

- compilador da AST v1 para SQL parametrizado com allowlist de campos e operadores;
- escaping explícito de curingas `LIKE`, composição `and`/`or` e consultas correlacionadas seguras
  para telefones, labels, validade, duplicidade e opt-out;
- repositório de busca paginada, limite de 100 registros por página, ordenação estável e escolha do
  telefone principal;
- busca em campos normalizados e em dados brutos preservados para campos ainda não materializados;
- testes contra texto de injeção SQL, paginação, labels, telefone inválido e grupos aninhados.

Bloco de API concluído após o marco `fe1cde1`:

- `ContactSelectionService` para busca e validação do CRUD de filtros salvos;
- persistência para listar, criar, editar e excluir filtros em `saved_contact_filters`;
- rotas `POST /api/contacts/search` e CRUD em `/api/contact-filters`;
- composição do serviço em `app.ts` e registro opcional em `server.ts`;
- testes de serviço e API para criação, edição, listagem, exclusão, busca e erros de validação.

Bloco de seleção global concluído após o checkpoint `32327fc`:

- resolução reproduzível da seleção com AST, opção de selecionar todos os resultados, inclusões e
  exclusões manuais;
- busca segura por IDs para materializar inclusões manuais fora do filtro atual, ignorando contatos
  inexistentes ou removidos remotamente;
- ordenação final determinística por nome/ID ou pela ordem local correspondente à origem Google;
- resumo de elegibilidade para telefone ausente, inválido, opt-out e duplicidade dentro da seleção,
  preservando um vencedor determinístico por telefone;
- rota `POST /api/contacts/resolve-selection` e testes de serviço/API para exceções manuais,
  duplicidade e IDs inexistentes.

Bloco inicial da interface Google Contacts:

- nova aba principal de Google Contacts na página de contatos, preservando CSV e cadastro manual;
- construtor visual de regras com combinação `E`/`OU`, todos os campos e operadores atualmente
  aceitos pelo backend;
- carregar, salvar e excluir filtros; pesquisa paginada e situação do telefone por contato;
- seleção individual ou de todos os resultados do filtro, incluindo exceções entre páginas;
- resumo de elegibilidade atualizado pela resolução autoritativa do backend;
- passagem temporária da seleção resolvida ao compositor via `sessionStorage`; a persistência no
  rascunho ainda é o próximo bloco obrigatório.

Limitação conhecida desta primeira UI: ela edita um grupo raiz de regras. A AST/backend já aceita
grupos aninhados, mas o editor visual recursivo ainda precisa ser implementado antes de considerar a
interface de filtros integralmente concluída.

Fundação de campanhas Google e lotes (migration v11):

- campanhas agora aceitam origem `local_list` ou `google`, sem exigir lista local para a agenda
  Google;
- definição do filtro, resumo, IDs resolvidos, inclusões/exclusões e instante de finalização da
  seleção possuem campos persistentes;
- tamanho do lote, intervalo entre lotes, ordem, seed, lote atual e próximo horário estão no schema;
- snapshots aceitam vínculo Google, `resourceName`, telefone original/label, dados renderizáveis,
  lote/posição, elegibilidade, resultado e recomendação de exclusão;
- inelegíveis podem existir no manifesto com telefone nulo e `skipped`, enquanto um índice parcial
  impede telefones elegíveis duplicados;
- migration reconstrói de forma controlada as duas tabelas, verifica chaves estrangeiras antes do
  commit e reativa `foreign_keys`; campanhas antigas recebem defaults compatíveis de lote único;
- teste explícito cobre campanha Google sem lista, inelegível sem telefone, limites e manutenção das
  chaves estrangeiras, além dos upgrades legados existentes.

## Validações da última etapa

- `npm.cmd run typecheck`: passou.
- `npm.cmd run lint`: passou.
- `npm.cmd run format`: passou e normalizou os arquivos alterados.
- `npm.cmd test`: 162 testes passaram, 0 falharam.
- `npm.cmd run build`: passou.
- `node --check public/contacts.js`: passou.
- Observação do ambiente: dentro do sandbox, o loader `tsx` falhou em `uv_os_get_passwd` com
  `ENOMEM`; a mesma suíte executada fora do sandbox passou integralmente.
- `npm ci` reportou uma vulnerabilidade de severidade alta em dependência; ainda precisa ser
  analisada sem aplicar atualização automática incompatível.

## Próximo passo

1. Integrar os novos campos ao domínio/repositório de campanhas e consumir a seleção Google no
   simulador, rascunho e preparo do snapshot.
2. Evoluir o editor visual para grupos `E`/`OU` aninhados sem perder ASTs já salvas.
3. Implementar execução persistente dos lotes sobre a fundação da migration v11.

## Decisões e cuidados ativos

- Tokens Google persistem fora do diretório incluído no backup `.wabkp`.
- Nenhuma credencial ou token real pode entrar no Git, logs ou respostas da API.
- Exclusão Google nunca é automática.
- Falha transitória de envio não constitui evidência de contato inválido.
- A aplicação não deve retomar disparos silenciosamente após reinício.
