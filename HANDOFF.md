# WA-Delivery — handoff de desenvolvimento

## Como usar este arquivo

Atualizar este documento ao final de cada etapa relevante, antes do commit. Registrar somente o
estado real e verificável: branch, último commit, mudanças concluídas, validações executadas,
pendências e próximo passo. Não substituir o plano completo de produto em `AGENTS.md`.

## Estado atual

- Branch de desenvolvimento: `feat/google-contacts-campaign-flow`
- Base: `main` no commit `cfc3881`
- Checkpoint anterior à retomada: `2eb690b` (`docs: checkpoint paused development state`).
- Estado da sessão: desenvolvimento local concluído; aguardando QA manual do usuário
- Etapa de retomada: QA real de OAuth, sincronização, envio e exclusão
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

Integração do domínio de campanhas Google concluída após o checkpoint `ff241f2`:

- simulação e rascunho resolvem a seleção no backend e persistem AST, resumo, IDs e configuração de
  lotes, sem depender de uma lista local;
- duração considera intervalos entre mensagens dentro do lote e a espera entre lotes;
- preparo recalcula a seleção e exige nova revisão quando a agenda mudou desde o rascunho;
- snapshot inclui elegíveis e inelegíveis, com vínculo Google, telefone bruto/canônico, posição no
  lote, motivo estruturado e recomendação conservadora de exclusão;
- duplicidade é determinada na ordem final e mantém um vencedor determinístico; ordem aleatória usa
  seed persistida;
- fila busca somente snapshots `eligible` com telefone e segue lote/posição; follow-up e exportação
  foram adaptados aos campos opcionais e vínculos Google;
- composição real do `CampaignService` agora recebe o mesmo `ContactSelectionService` usado pelas
  rotas;
- testes cobrem simulação, persistência, formação de lotes, manifesto de inelegíveis e bloqueio do
  preparo quando a agenda muda.

Integração do compositor e da revisão de campanha:

- o compositor aceita lista local ou a seleção Google resolvida na tela de contatos;
- exibe contagens de selecionados/elegíveis/inelegíveis e bloqueia simulação Google sem seleção;
- tamanho do lote (1–100), intervalo em horas/minutos (total validado até 48 horas) e ordem são
  configuráveis e enviados ao backend;
- simulação mostra quantidade/tamanho dos lotes e inclui as esperas na duração prevista;
- rascunhos Google podem ser reabertos e editados sem perder filtros, IDs ou seed da ordem
  aleatória;
- revisão preparada mostra telefone bruto quando não há canônico, lote e motivo estruturado dos
  inelegíveis;
- CSV/manual continuam disponíveis no mesmo compositor e recebem os mesmos controles de lote.

Execução persistente em lotes (migration v12):

- worker processa `batch_number`/`position_in_batch` e aplica o intervalo somente entre lotes;
- `next_batch_at`, lote atual e segundos restantes congelados são persistidos no banco;
- pausa manual e encerramento limpo congelam a contagem; retomada recalcula o horário sem reiniciar
  o intervalo completo;
- recuperação após interrupção continua convertendo campanhas em execução para `paused`, sem
  disparo silencioso; o usuário precisa retomar explicitamente;
- intervalo vencido durante interrupção permite iniciar o próximo lote imediatamente após a
  confirmação de retomada;
- nenhum intervalo é aplicado depois do último lote e estados terminais limpam a espera;
- SSE emite progresso durante a contagem regressiva; revisão e monitoramento mostram lote atual,
  total de lotes e tempo até o próximo;
- testes cobrem persistência da espera, congelamento durante pausa, retomada e ausência de espera
  após o último destinatário.

Manifesto estruturado e semântica de resultado:

- worker persiste `accepted`, `permanent_failure`, `transient_failure_exhausted`,
  `validation_failure`, `skipped_opt_out` e `skipped_cancelled` conforme o caso;
- número conclusivamente fora do WhatsApp muda para `not_on_whatsapp` e pode ser recomendado para
  exclusão; falhas permanentes genéricas e transitórias nunca são recomendadas automaticamente;
- sucesso é descrito como “envio aceito” com aviso explícito de que não confirma entrega;
- endpoint `GET /api/campaigns/:id/manifest` retorna resumo e snapshots persistidos com tentativas,
  motivos, lotes e recomendações;
- CSV foi ampliado com lote, elegibilidade, resultado, motivo e recomendação, mantendo proteção
  contra formula injection;
- revisão de campanha consome o manifesto e filtra por status, elegibilidade ou recomendação;
- testes cobrem aceite, número fora do WhatsApp, falha permanente, esgotamento transitório,
  agregação do manifesto e endpoint.

Jobs auditáveis de exclusão Google:

- criação exige campanha terminal, seleção não vazia e confirmação destrutiva explícita;
- somente destinatários vinculados ao Google com evidência forte (`missing_phone`, `invalid_phone`
  ou `not_on_whatsapp`) podem entrar no job; falhas transitórias e recomendações inseguras são
  recusadas pelo backend;
- cada item preserva contato, motivo, evidências estruturadas e snapshot dos dados usados na
  confirmação;
- antes de excluir, o serviço relê o contato remoto e revalida a evidência; casos com múltiplos
  telefones são bloqueados para revisão manual e `not_on_whatsapp` é consultado novamente no
  WhatsApp;
- exclusões são sequenciais, com backoff limitado para `429`/`5xx`; `401`/`403` interrompe os itens
  restantes e solicita reconexão sem expor detalhes sensíveis;
- sucesso remoto é registrado separadamente da verificação; uma sincronização posterior marca
  `verified_at`, e contatos já ausentes recebem `already_missing`;
- endpoints criam, consultam e repetem somente itens com falha;
- o manifesto permite seleção individual sem pré-seleção, mostra quantidade/motivos, exige checkbox
  e confirmação final, e apresenta o resultado de cada exclusão;
- testes cobrem exclusão verificada, mudança de evidência, ausência de confirmação/recomendação e
  interrupção por autorização.

Editor visual de filtros aninhados:

- a interface agora representa o AST completo com grupos recursivos, em vez de reduzir filtros
  salvos ao primeiro nível;
- cada grupo escolhe `E`/`OU` independentemente e pode receber regras ou novos subgrupos;
- filtros aninhados carregados do banco são reidratados integralmente e continuam editáveis;
- o AST enviado para busca, resolução de seleção e filtros salvos mantém a mesma versão e contrato
  já validados pelo backend;
- remoção preserva ao menos um nó por grupo, evitando criar grupos vazios pela interface.

Follow-up novamente revisável:

- a ação manual de reenvio agora cria um `draft`, nunca uma campanha pronta para disparo;
- somente falhas estruturadas elegíveis (`permanent_failure`, `transient_failure_exhausted` e
  `skipped_cancelled`) entram como candidatas, com fallback compatível para campanhas antigas;
- opt-outs, números sem telefone, inelegíveis e envios já aceitos não entram no reenvio;
- para Google, os pendentes viram uma seleção explícita de IDs, mantendo filtro/configuração
  herdados e sendo revalidados contra a agenda ao preparar;
- para listas locais, o novo snapshot só é criado após a segunda revisão e preserva as mensagens
  renderizadas quando o template não mudou;
- nome, template, mídia, intervalos e lotes permanecem editáveis antes do novo preparo;
- mídia compartilhada entre campanha original e follow-up só é removida quando nenhuma campanha
  ainda a referencia;
- testes cobrem o novo rascunho local e a seleção explícita Google seguida de novo preparo.

Exclusão assíncrona retomável e manifesto paginado:

- criação e nova tentativa de exclusão retornam `202` e executam o job em segundo plano;
- a tela consulta o job persistido a cada segundo, mostra progresso item a item e reencontra o job
  mais recente da campanha depois de reload;
- jobs pendentes ou com falha podem ser retomados explicitamente, sem repetir itens já concluídos;
- na inicialização, operações que estavam `deleting` são marcadas com resultado desconhecido e
  exigem retomada; a nova leitura do contato mantém a repetição idempotente na prática;
- falha inesperada do executor deixa o job persistido como falho, sem rejeição assíncrona solta;
- a lista do manifesto possui páginas navegáveis de 50 itens e mantém seleções individuais entre
  páginas e filtros;
- testes cobrem execução em segundo plano, consulta do último job e recuperação após interrupção.

Escolha de telefone e variáveis Google:

- resultados da agenda expõem todos os telefones com ID, label, valor bruto/canônico, validade e
  indicador de principal;
- quando existem vários números válidos sem um principal inequívoco, o contato fica inelegível até
  escolha manual; a interface mostra um seletor na própria linha;
- escolhas são validadas no backend e persistidas por contato dentro da definição versionada da
  seleção, portanto simulação e preparo usam exatamente o mesmo telefone;
- o resumo informa contatos com telefone ambíguo e o snapshot preserva telefone/label escolhidos;
- dados sincronizados agora alimentam variáveis Google como nome, sobrenome, telefone, email,
  organização, cargo, departamento, aniversário, notas, labels, endereço, URL e campos
  personalizados normalizados;
- `render_data_json`, que já existia no schema, passou a ser gravado e lido pelo domínio; mensagem e
  valores usados ficam congelados no snapshot mesmo se a agenda mudar;
- leitura individual da People API solicita o mesmo conjunto amplo de campos da sincronização;
- testes cobrem ambiguidade/escolha persistida e renderização imutável de variável Google.

Tentativas, retenção e navegação do fluxo:

- o limite de tentativas técnicas agora é invariavelmente três no serviço de configurações e no
  worker, inclusive ao abrir bancos antigos que armazenavam outro valor;
- a configuração correspondente permanece visível para explicar a política, mas não pode mais ser
  alterada na interface;
- exclusão manual e limpeza por retenção bloqueiam campanhas com jobs de exclusão pendentes, em
  execução, parciais ou com falha; auditorias terminais são removidas junto da campanha;
- o fluxo principal ganhou um indicador responsivo de etapas para conexão, contatos, campanha,
  execução e revisão, com atualização do passo ativo ao preparar a campanha;
- onboarding e README agora explicam Google Contacts, escolha de telefones ambíguos, manifesto,
  exclusão revisada, callback loopback e persistência segura dos tokens;
- as rotas de jobs de exclusão agora têm cobertura HTTP para criação assíncrona, consulta direta,
  consulta do job mais recente, repetição, ID inválido e integração não configurada.

Sincronização Google observável e exclusiva:

- concluir o OAuth agora executa automaticamente a primeira sincronização; se a People API falhar,
  a conta permanece conectada e o erro fica persistido para exibição e nova tentativa;
- o serviço impede duas sincronizações simultâneas na mesma instalação e responde conflito para a
  segunda solicitação, sem alterar o estado da operação em andamento;
- `/api/google/status` agora expõe tipo, horários da última sincronização completa/incremental,
  contadores, atualização do estado e erro mascarado;
- a tela de configurações mostra a última conclusão e seus contadores, desabilita nova solicitação
  enquanto o estado está em execução e informa que a sincronização inicial foi processada;
- mensagens de falha persistidas passam pelo mascaramento de telefones e possíveis credenciais.

Leitura e filtragem do manifesto:

- a revisão permite busca textual insensível a caixa e acentos por nome, telefone, status, código,
  motivo, erro e recomendação;
- foram adicionados filtros específicos para falha permanente, falha transitória esgotada e revisão
  manual, preservando os atalhos seguros de telefone inválido e fora do WhatsApp;
- a ordenação pode usar lote/posição, nome, resultado, quantidade de tentativas ou atualização mais
  recente, com desempate determinístico pelo ID do snapshot;
- cada destinatário mostra origem, elegibilidade, resultado estruturado, lote, tentativas e última
  atualização, além dos motivos já existentes;
- filtro, texto pesquisado e ordenação passam a integrar o snapshot de revisão gravado no job de
  exclusão; a busca não pré-seleciona contatos nem amplia a política de exclusão segura.

Edição da seleção de um rascunho Google:

- a campanha em rascunho agora abre a agenda com seu próprio ID para editar a seleção existente;
- o editor restaura AST do filtro, modo “selecionar todos”, inclusões/exclusões individuais e
  escolhas de telefone previamente salvas;
- ao confirmar, a seleção é revalidada e atualizada via `PUT` na mesma campanha, preservando nome,
  mensagem, mídia, intervalos, lotes e seed de ordenação;
- campanhas já preparadas e campanhas locais não podem entrar por esse caminho;
- teste de domínio confirma que o ID do rascunho é preservado e que IDs/resumo resolvidos são
  recalculados.

Corrida segura durante exclusão Google:

- o provedor People API agora distingue explicitamente `404` no `deleteContact` por meio de um erro
  de domínio, em vez de tratá-lo como sucesso indiferenciado;
- se o contato existia na validação, mas desaparece antes da chamada de exclusão, o item termina
  como `already_missing` e verificado;
- o caso não entra em backoff, não aparece como falha e continua auditável separadamente de uma
  exclusão aceita pela chamada atual;
- testes cobrem tanto a tradução do `404` no provedor quanto a corrida completa no job.

Retomada explícita depois de reinício:

- a recuperação de uma campanha que estava aguardando o próximo lote agora converte
  `next_batch_at` em segundos restantes no instante da inicialização; o relógio fica congelado até
  o usuário retomar;
- a retomada restaura o prazo a partir desses segundos, sem reiniciar o intervalo completo e sem
  consumir a espera enquanto a aplicação/campanha está parada;
- a página da campanha sempre explica o estado pausado e exige confirmação antes de retomar;
- o monitor também mostra a espera preservada, informa que não haverá retomada silenciosa e oferece
  a ação explícita de retomada;
- teste de recuperação confirma que uma espera de 90 segundos permanece salva e sem
  `next_batch_at` enquanto pausada.

Diagnóstico de exclusão de campanha:

- o domínio agora distingue campanha inexistente, campanha em execução e campanha bloqueada por
  job de exclusão incompleto;
- a rota retorna `404` para ID inexistente e mensagens `409` específicas para execução ativa ou
  auditoria pendente/parcial/com falha;
- campanhas com auditoria concluída continuam sendo removidas junto com seus registros terminais;
- o teste de retenção/auditoria verifica explicitamente o motivo estruturado do bloqueio.

Backup das novas estruturas sem tokens:

- teste integrado cria um banco no schema atual com conta/contato Google, campanha com lote e job de
  exclusão concluído, gera o `.wabkp`, altera o banco e restaura o arquivo;
- após a restauração, o SQLite real confirma os contatos Google, `batch_size` e a auditoria de
  exclusão;
- um refresh token de prova armazenado fora de `data/` não aparece no manifesto nem nos bytes do
  backup e permanece intacto depois da restauração;
- a restauração continua recusando schema mais novo, preservando a proteção de rollback já testada.

Filtros para campos amplos da People API:

- endereço, relação, URL e campo personalizado agora fazem parte da allowlist versionada e aparecem
  no construtor visual de filtros;
- cada campo usa `json_each`/`json_extract` parametrizado sobre sua coleção específica no JSON,
  evitando que uma busca de e-mail corresponda acidentalmente a outro campo bruto;
- endereços combinam valor formatado, rua, cidade, região, CEP e país; relações, URLs e campos
  personalizados combinam seus pares de tipo/chave e valor;
- testes consultam dados reais dessas quatro coleções, além do e-mail já existente.

Reconciliação segura da sincronização completa:

- uma sincronização completa bem-sucedida mantém o conjunto de `resourceName` vistos e marca como
  removidos remotamente os contatos locais ativos que não apareceram mais na agenda;
- a reconciliação e a conclusão do estado de sync ocorrem na mesma transação local, sem apagar os
  registros nem os snapshots históricos;
- sincronizações incrementais continuam dependendo apenas dos tombstones do Google e não executam
  varredura de ausentes;
- se uma sincronização completa falhar entre páginas, nenhum contato ausente é marcado como
  removido; a repetição completa pode recuperar e só então gravar o novo sync token;
- o contador `deleted` inclui os ausentes reconciliados. Teste cobre falha intermediária, estado
  `failed`, recuperação e marcação somente após sucesso.

Endurecimento do OAuth Google:

- a troca do código agora exige que a resposta tenha concedido explicitamente o escopo de contatos;
  login sem essa permissão é recusado com orientação segura;
- refresh preserva o escopo anterior quando o Google o omite e também recusa uma resposta que
  explicitamente remova a permissão necessária;
- o cálculo de expiração usa o relógio injetado do provedor, permitindo comportamento determinístico
  e teste real do TTL do `state`;
- testes cobrem callback negado, state expirado sem chamada ao endpoint de token e autorização sem
  escopo, comprovando que access/refresh tokens não aparecem na mensagem de erro.

Sincronização Google assíncrona e retomável na interface:

- a conclusão do OAuth e a ação manual iniciam a sincronização em segundo plano e devolvem a
  resposta HTTP imediatamente, sem manter a navegação bloqueada durante agendas grandes;
- `POST /api/google/sync` responde `202` com o estado persistido e
  `GET /api/google/sync/status` permite consultar a execução separadamente;
- a página de configurações observa o estado a cada segundo, mantém o botão desabilitado enquanto
  a sincronização está ativa e volta a acompanhá-la após um reload;
- o término mostra os contadores persistidos de contatos criados, atualizados e removidos, enquanto
  erros continuam disponíveis no status seguro da sincronização;
- uma segunda sincronização simultânea continua recusada com `409`;
- teste de rota mantém uma página remota propositalmente pendente, comprova a resposta imediata e o
  estado `running`, libera o trabalho e confirma o estado final pela rota de polling.

Acessibilidade de operações longas:

- a sincronização Google expõe uma região viva de estado e marca o cartão como ocupado durante a
  consulta e durante a sincronização persistida;
- mensagens de sucesso e erro em configurações, limpeza e restauração receberam semântica de
  `status`/`alert` para tecnologias assistivas;
- a barra do monitor passou a ser um `progressbar` com percentual e contagem processada atualizados
  em `aria-valuenow`/`aria-valuetext`;
- estado de execução e espera da campanha é anunciado de forma não intrusiva;
- exclusões Google marcam a lista de resultados como ocupada enquanto o job está ativo e anunciam
  as atualizações persistidas;
- testes estáticos protegem os contratos de acessibilidade das três operações longas.

Endurecimento de dependências e payloads:

- overrides compatíveis atualizam `sharp` para 0.35.5 e `music-metadata` para 11.16.0, removendo as
  vulnerabilidades transitivas conhecidas sem trocar a versão do Baileys;
- `npm ci` volta a concluir de forma reproduzível e `npm audit` reporta zero vulnerabilidades;
- payloads JSON possuem limite global explícito de 1 MiB e respostas 413 seguras, sem stack trace;
- jobs de exclusão aceitam no máximo 10.000 destinatários, alinhados ao limite da seleção;
- testes cobrem tanto o limite HTTP quanto a recusa antecipada de jobs excessivos.

Busca sem acentos e matriz completa de operadores:

- o SQLite registra uma função determinística local que normaliza caixa e remove diacríticos sem
  alterar os dados originais sincronizados;
- campos materializados, labels, telefones e coleções amplas do JSON usam a mesma normalização;
- buscas como `Avila`/`Crisalidas` encontram `Ávila`/`Crisálidas`;
- o campo de origem passou a respeitar os mesmos operadores parametrizados dos demais textos;
- testes em banco real cobrem contém, não contém, igual, diferente, começa, termina, vazio, não
  vazio, antes, depois, entre, em lista e fora da lista.

Compatibilidade, volume e matriz de exclusão:

- `AGENTS.md` reflete o schema atual v13; README documenta migrations automáticas e rollback seguro
  por backup compatível, sem abrir banco novo com código antigo;
- CHANGELOG registra o fluxo Google, lotes, manifesto, exclusão auditável, compatibilidade e
  endurecimentos da versão ainda não lançada;
- teste com 2.500 contatos confirma paginação de 100 itens e seleção global reproduzível sem perder
  resultados além da primeira página; a execução levou menos de meio segundo neste ambiente, sem
  evidência para introduzir FTS nesta fase;
- exclusão Google agora tem cobertura explícita para recuperação após dois `429`, esgotamento de
  três tentativas em `5xx` e falha de rede, preservando códigos e mensagens seguras para retry.

Progresso quantitativo da sincronização:

- cada página aplicada incrementa os contadores persistidos de contatos criados, atualizados e
  removidos dentro da mesma transação dos dados;
- `/api/google/status` e `/api/google/sync/status` passam a refletir progresso parcial real enquanto
  a operação está `running`, inclusive depois de reload;
- a interface anuncia os contadores atuais a cada polling e mantém os totais finais ao concluir;
- teste bloqueia propositalmente a segunda página e confirma que o primeiro contador já está
  visível antes da sincronização terminar.

## Validações da última etapa

Configuração local das credenciais OAuth (migration v13):

- a página Configurações agora recebe Client ID e Client secret, valida e persiste a configuração;
- o SQLite armazena o Client ID e uma referência opaca; o Client secret permanece fora do banco,
  protegido por DPAPI no Windows ou Secret Service no Linux;
- as credenciais são reutilizadas na inicialização seguinte e variáveis de ambiente continuam como
  override administrativo;
- a API nunca devolve o segredo e impede alteração enquanto uma conta Google estiver conectada;
- o tutorial completo foi criado fora do repositório em
  `C:\Users\Deia\Documents\WA-Delivery-Google-Cloud-Tutorial.md`, conforme solicitado;
- testes cobrem persistência sem segredo no SQLite, rotas, exclusão, validação e override.

- `npm run check`: passou com 203 testes, incluindo typecheck, lint, formatação e build.
- `git diff --check`: passou.

- `npm.cmd run typecheck`: passou.
- `npm.cmd run lint`: passou.
- `npm.cmd run format`: passou e normalizou os arquivos alterados.
- `npm.cmd test`: 200 testes passaram, 0 falharam.
- `npm.cmd run build`: passou.
- `node --check public/settings.js` e `node --check public/campaign.js`: passaram.
- `node --check public/monitor.js`: passou.
- `git diff --check`: passou.
- `npm.cmd run test:coverage`: passou com 92,88% de linhas, 76,84% de branches e 89,79% de funções.
- `npm.cmd ci`: passou.
- `npm.cmd audit --audit-level=moderate`: zero vulnerabilidades.
- QA visual automatizado não pôde ser executado nesta sessão: o controle de interface não encontrou
  navegador ou janela disponível (`apps: []`, `browsers: []`).
- Observação do ambiente: dentro do sandbox, o loader `tsx` falhou em `uv_os_get_passwd` com
  `ENOMEM`; a mesma suíte executada fora do sandbox passou integralmente.

## Próximo passo

1. Executar QA visual em um ambiente com navegador disponível.
2. Executar QA real de OAuth, sincronização, envio e exclusão com contas de teste.
3. Corrigir somente problemas encontrados no QA e repetir `npm.cmd run check`/`npm.cmd audit`.
4. Fazer merge para `main` apenas depois da validação integral e aprovação explícita do usuário.

## Decisões e cuidados ativos

- Tokens Google persistem fora do diretório incluído no backup `.wabkp`.
- Nenhuma credencial ou token real pode entrar no Git, logs ou respostas da API.
- Exclusão Google nunca é automática.
- Falha transitória de envio não constitui evidência de contato inválido.
- A aplicação não deve retomar disparos silenciosamente após reinício.
