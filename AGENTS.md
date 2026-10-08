# WA-Delivery — instruções do projeto e plano de evolução

## 1. Finalidade deste documento

Este arquivo é a referência operacional para agentes e desenvolvedores que trabalharem no
WA-Delivery. Ele reúne:

- o contexto e as restrições da aplicação atual;
- as decisões de produto já confirmadas;
- o fluxo-alvo de campanhas integrado ao Google Contacts;
- a arquitetura proposta;
- as mudanças de banco, backend e interface;
- regras de segurança para sincronização e exclusão de contatos;
- critérios de aceite, testes e uma sequência recomendada de implementação.

O plano é deliberadamente detalhado. Antes de implementar uma fase, confirme se as fases das quais
ela depende já foram concluídas e mantenha este documento atualizado quando uma decisão mudar.

## 2. Visão atual do projeto

O WA-Delivery é uma aplicação local, single-user, executada em `127.0.0.1:3000`, escrita em
TypeScript/Node.js e com interface web estática. O banco local usa `node:sqlite`. A integração com
WhatsApp usa Baileys, portanto não é uma integração oficial.

### 2.1 Componentes existentes

- `src/app.ts`: composição das dependências e ciclo de vida da aplicação.
- `src/database/database.ts`: schema SQLite e migrations sequenciais. O schema atual termina na v13.
- `src/providers/whatsapp`: abstração e implementação Baileys, QR Code, sessão persistente,
  verificação de número e envio de texto/mídia.
- `src/modules/contacts`: listas locais, membros, normalização de telefone, importação e análise CSV.
- `src/modules/campaigns`: rascunho, simulação, preparação, snapshot imutável dos destinatários,
  exportação e follow-up.
- `src/modules/queue`: execução, pausa, retomada, cancelamento, recuperação após interrupção,
  classificação de erros e retentativas técnicas.
- `src/modules/media`: upload, validação e ciclo de vida de imagem/vídeo.
- `src/modules/settings`: configurações persistentes.
- `src/modules/backup`: backup/restauração do banco, mídias e sessão do WhatsApp.
- `src/web`: rotas Fastify e SSE.
- `public`: interface atual em HTML/CSS/JavaScript sem framework.
- `tests`: testes unitários e de integração usando `node:test`.

### 2.2 Capacidades que devem ser preservadas

- login do WhatsApp por QR e reconexão da sessão salva;
- importação CSV com prévia, detecção de colunas e preservação de campos extras;
- cadastro e edição manual de listas;
- opt-out global por telefone;
- templates com `{{nome}}` e campos extras;
- snapshot imutável ao preparar uma campanha;
- confirmação explícita antes de preparar e antes de iniciar;
- pausa, retomada, cancelamento e recuperação idempotente;
- mídia, exportação CSV, monitoramento em tempo real, backup e retenção;
- mascaramento de telefones e credenciais nos logs;
- testes, lint, formatação, typecheck e build existentes.

### 2.3 Limitações atuais relevantes

- contatos existem principalmente dentro de listas locais; não há uma agenda Google sincronizada;
- uma campanha referencia uma lista inteira, sem uma consulta/filtro persistido de seleção;
- não há conceito explícito de lote dentro da campanha;
- `sent` significa que a chamada de envio foi aceita e retornou um ID, não que houve recibo de
  entrega ao aparelho;
- o worker possui retentativas técnicas, mas o relatório não modela evidências de exclusão de um
  contato;
- follow-up cria outra campanha com `failed` e `skipped`; o fluxo-alvo será uma campanha única;
- não existe OAuth Google, sincronização incremental, vínculo por `resourceName` ou exclusão remota.

## 3. Decisões de produto confirmadas

Estas decisões são requisitos, não sugestões:

1. Google Contacts será a fonte principal de contatos.
2. CSV e cadastro manual continuarão disponíveis como alternativas.
3. O login Google será feito por OAuth 2.0 e atenderá uma única conta por instalação.
4. Os contatos Google serão sincronizados para o banco local.
5. A seleção suportará filtros inteligentes em todos os campos úteis, composição `E`/`OU`,
   operadores variados, deduplicação, labels/grupos e filtros salvos.
6. O conteúdo de `Labels`, inclusive textos no formato observado na amostra
   `Lote-5-05/10/26 ::: * myContacts`, é texto pesquisável; não inferir semântica de lote ou data.
7. Depois dos filtros, o usuário poderá marcar e desmarcar contatos individualmente.
8. Os lotes pertencem a uma única campanha, e não a subcampanhas independentes.
9. O tamanho dos lotes e o intervalo entre lotes serão configuráveis pelo usuário.
10. Cada destinatário terá no máximo três tentativas técnicas durante a execução da campanha.
11. O estado `sent` representa apenas o aceite do envio pelo WhatsApp/Baileys. A interface nunca
    deve chamar isso de confirmação de entrega ao aparelho.
12. Números malformados, ausentes, duplicados, não registrados no WhatsApp ou com erro permanente
    precisam aparecer no manifesto com seu motivo.
13. Ao final, o usuário verá um manifesto dos destinatários problemáticos, além do log geral.
14. Exclusão do Google Contacts será sempre precedida por revisão, filtros, seleção individual e
    confirmação explícita.
15. O sistema precisa verificar e registrar o sucesso ou a falha de cada exclusão remota e permitir
    nova tentativa para falhas.
16. O fluxo existente será atualizado para o novo fluxo, sem criar um segundo fluxo concorrente.
17. A campanha guardará tamanho do lote, intervalo entre lotes e a definição dos filtros usados na
    seleção.
18. O tamanho de lote aceito será de 1 a 100 contatos.
19. O intervalo entre lotes será informado em horas e minutos, de 0 até 48 horas, e persistido para
    permitir retomada correta após encerramento ou reinício da aplicação.
20. A ordenação padrão dos lotes será por nome, com desempate por identificador interno. A interface
    também poderá oferecer ordem original do Google e ordem aleatória.
21. Quando houver vários telefones, usar por padrão o número marcado como principal. Casos ambíguos
    continuam disponíveis para revisão manual.
22. Tokens Google devem permanecer salvos localmente entre execuções para evitar novo login
    frequente, mas não serão incluídos no backup `.wabkp`.
23. O follow-up existente será mantido e adaptado ao novo modelo de seleção, lotes, motivos e
    manifesto; ele continuará sendo iniciado manualmente pelo usuário.

## 4. Fluxo-alvo do usuário

Implementar o processo como um assistente com etapas visíveis e retomáveis:

1. **Conectar WhatsApp**
   - mostrar estado atual, QR Code e erros;
   - permitir avançar somente conectado, salvo em telas que não exigem envio.
2. **Conectar Google Contacts**
   - iniciar OAuth no navegador;
   - mostrar conta conectada, última sincronização e opção de desconectar/trocar conta;
   - após autorização, executar sincronização inicial.
3. **Selecionar contatos**
   - pesquisar, combinar filtros, salvar filtro e revisar resultados;
   - selecionar todos os resultados ou contatos individuais;
   - exibir contagens de selecionados, sem telefone, inválidos localmente, duplicados e opt-out;
   - nunca selecionar opt-out silenciosamente.
4. **Configurar lotes**
   - tamanho sugerido: 50 ou 100;
   - aceitar inteiro definido pelo usuário entre 1 e 100;
   - configurar intervalo entre lotes em horas e minutos, de 0 até 48 horas;
   - escolher ordenação por nome, ordem original do Google ou ordem aleatória;
   - mostrar quantidade de lotes e previsão de duração.
5. **Preencher campanha**
   - nome, mensagem, mídia, intervalo entre mensagens, tamanho do lote e intervalo entre lotes;
   - mostrar filtros aplicados e exceções manuais da seleção.
6. **Revisar e preparar**
   - simular mensagens e validar variáveis;
   - congelar snapshot dos contatos e da configuração;
   - distribuir os destinatários elegíveis em lotes determinísticos;
   - apresentar inelegíveis antes do envio.
7. **Executar campanha**
   - processar lotes em ordem;
   - fazer até três tentativas técnicas por destinatário conforme a classificação do erro;
   - aguardar o intervalo configurado entre lotes;
   - permitir pausar, retomar e cancelar sem perder posição.
8. **Revisar resultado**
   - mostrar resumo geral e manifesto detalhado de exceções;
   - permitir filtros inteligentes, ordenação e seleção individual;
   - separar problemas que constituem evidência forte de invalidade de falhas operacionais.
9. **Confirmar exclusões do Google**
   - excluir somente linhas explicitamente selecionadas;
   - exigir confirmação destrutiva com quantidade e motivos;
   - executar mutações sequencialmente;
   - verificar e registrar cada resultado;
   - oferecer nova tentativa apenas para exclusões que falharam.

Não haverá uma “segunda campanha” automática. As três tentativas técnicas do worker são o limite de
envio previsto por destinatário nesta versão. O follow-up permanece como ação manual e cria uma nova
campanha adaptada ao mesmo fluxo, somente quando o usuário decidir utilizá-lo.

## 5. Terminologia e semântica obrigatórias

### 5.1 Envio versus entrega

- `sent` / **envio aceito**: Baileys retornou sucesso e `messageId`.
- Não usar “entregue” para esse estado.
- Recibos de entrega/leitura estão fora do escopo até existir implementação específica e testada.

### 5.2 Estado de elegibilidade

Antes de entrar na fila, cada registro deve ser classificado como:

- `eligible`: pode ser enviado;
- `missing_phone`: não possui telefone utilizável;
- `invalid_phone`: telefone não pode ser normalizado/validado;
- `duplicate_phone`: outro contato selecionado representa o mesmo telefone normalizado;
- `opted_out`: telefone está em opt-out;
- `not_on_whatsapp`: verificação explícita informou que não está registrado;
- `stale_google_contact`: referência Google já não existe;
- `unknown`: não foi possível concluir a validação.

Somente `eligible` entra na fila. Todos os demais aparecem na revisão e no manifesto.

### 5.3 Classificação do resultado de envio

- `accepted`: envio aceito pelo WhatsApp;
- `permanent_failure`: erro classificado como permanente após evidência suficiente;
- `transient_failure_exhausted`: erro transitório permaneceu após três tentativas;
- `validation_failure`: falhou antes de enviar;
- `skipped_opt_out`: opt-out;
- `skipped_cancelled`: pendente quando a campanha foi cancelada.

Persistir código legível por máquina, descrição segura para o usuário, erro técnico mascarado,
número de tentativas e timestamps. Não depender apenas de texto livre.

### 5.4 Elegibilidade para sugerir exclusão

O sistema pode **sugerir** exclusão quando houver evidência forte:

- sem telefone em um contato cuja finalidade na campanha depende de telefone;
- telefone estruturalmente inválido;
- resposta explícita e conclusiva de que o número não está no WhatsApp;
- contato remoto já marcado como excluído/inexistente, para limpeza apenas local.

O sistema não deve pré-selecionar exclusão com base apenas em:

- timeout;
- desconexão do WhatsApp;
- rate limit;
- falha de rede;
- erro desconhecido;
- cancelamento ou pausa;
- falha transitória, mesmo após esgotar tentativas;
- ausência de recibo de entrega, pois esse recibo não faz parte do escopo.

Falha permanente só pode sugerir exclusão quando o código/motivo demonstrar invalidade do destino.
“Permanente” não é sinônimo automático de “contato deve ser apagado”.

## 6. Integração Google Contacts

Usar a Google People API. Referências oficiais:

- OAuth para aplicações instaladas/desktop:
  https://developers.google.com/identity/protocols/oauth2/native-app
- listar e sincronizar contatos:
  https://developers.google.com/people/api/rest/v1/people.connections/list
- ler e gerenciar contatos:
  https://developers.google.com/people/v1/contacts
- excluir um contato:
  https://developers.google.com/people/api/rest/v1/people/deleteContact

### 6.1 Configuração OAuth

- Criar um cliente OAuth do tipo Desktop app no Google Cloud Console.
- Habilitar People API e configurar a tela de consentimento.
- Usar Authorization Code com PKCE quando suportado pela biblioteca escolhida.
- Receber o callback por loopback local ligado somente a `127.0.0.1`, com porta efêmera ou rota
  dedicada controlada pela aplicação.
- Validar `state` e nunca aceitar callback sem uma tentativa de autenticação ativa.
- Solicitar o menor conjunto de escopos possível. Como haverá leitura e exclusão, o escopo esperado
  é `https://www.googleapis.com/auth/contacts`.
- Não colocar client secret, refresh token ou access token no frontend, URL persistida, logs ou
  exportações.
- Credenciais do cliente serão configuração local não versionada. Fornecer tutorial para criação e
  instalação dessas credenciais; não incluir credenciais reais no repositório.
- Guardar tokens localmente entre execuções, com permissões restritas e proteção do cofre de
  credenciais do sistema operacional. No Windows, preferir Credential Manager/DPAPI; em Linux/WSL,
  preferir Secret Service/libsecret quando disponível. Um fallback criptografado deve ser explícito,
  documentado e nunca armazenar a chave ao lado do ciphertext sem proteção adicional.
- Access e refresh tokens não serão incluídos no backup `.wabkp`. Depois de uma restauração em que
  o armazenamento seguro não esteja mais disponível, o usuário fará login Google novamente. Em uma
  execução normal, os tokens salvos e o refresh automático evitam logins frequentes.
- Desconectar Google deve revogar o token quando possível e remover tokens locais, sem apagar os
  contatos sincronizados automaticamente.

### 6.2 Sincronização

- Buscar apenas contatos da fonte de contatos, evitando misturar perfis/diretório indevidamente.
- Incluir `metadata`, `names`, `nicknames`, `phoneNumbers`, `emailAddresses`, `organizations`,
  `birthdays`, `biographies`, `memberships`, `addresses`, `relations`, `urls`, `userDefined` e os
  campos adicionais que forem expostos pelos filtros.
- Paginar até `nextPageToken` acabar; `pageSize` pode chegar a 1000 conforme a documentação.
- Na sincronização completa, solicitar `nextSyncToken` e persisti-lo.
- Usar sincronização incremental enquanto o token for válido.
- Se o Google responder `EXPIRED_SYNC_TOKEN`, descartar o token e executar sincronização completa.
- Aplicar mudanças incrementalmente em transação local.
- Contatos retornados com `metadata.deleted = true` devem ser marcados como removidos remotamente,
  não apagados imediatamente do histórico local.
- Preservar snapshots de campanhas antigas mesmo quando o contato for alterado ou removido.
- Registrar início, fim, tipo, quantidade criada/atualizada/removida e erro da sincronização.
- Não permitir duas sincronizações simultâneas.

### 6.3 Identidade e telefones múltiplos

- A identidade remota canônica é `resourceName`, não nome nem telefone.
- Persistir também `etag`/metadados necessários para detectar concorrência quando aplicável.
- Um contato Google pode ter vários telefones. Modelar telefones como registros separados, com
  label, valor original, valor canônico e indicação de principal.
- A seleção ocorre por contato + telefone escolhido. Por padrão, usar telefone principal válido;
  quando houver mais de um candidato válido e nenhum principal inequívoco, permitir escolha na
  revisão. Como a maioria dos contatos possui somente um número, esse caso não deve interromper o
  fluxo geral.
- Deduplicação de campanha usa telefone normalizado. Manter referência a todos os contatos que
  colidiram, escolher um vencedor deterministicamente e mostrar os descartados.

### 6.4 Exclusão remota

- `people.deleteContact` exige `resourceName` e escopo de contatos.
- Enviar mutações para a mesma conta sequencialmente, conforme recomendação oficial.
- Antes de excluir, consultar/validar que o `resourceName` ainda corresponde ao contato esperado e
  que o usuário ainda o selecionou para exclusão.
- Revalidar a evidência que motivou a sugestão quando isso exigir uma chamada atual ao WhatsApp.
- Criar um job/auditoria local antes da primeira chamada remota.
- Para cada item, registrar `pending`, `deleting`, `deleted`, `failed`, `already_missing` ou
  `cancelled`, código HTTP seguro, mensagem e timestamps.
- Resposta de sucesso do endpoint marca a operação como `deleted`, mas uma sincronização posterior
  deve confirmar o desaparecimento/estado removido. Não bloquear a UI por minutos esperando
  propagação; mostrar “exclusão aceita, aguardando sincronização” quando necessário.
- `404` depois de uma confirmação de identidade pode ser tratado como `already_missing`, não como
  falha destrutiva.
- `401/403` deve interromper o restante do job e pedir reconexão/permissão.
- `429` e erros 5xx usam backoff limitado e mantêm opção de nova tentativa.
- Nunca excluir contatos em lote sem guardar a seleção exata e uma confirmação explícita.

## 7. Modelo de dados proposto

Criar migrations incrementais; nunca editar migrations já aplicadas. Nomes finais podem ser
ajustados durante a implementação, mas as responsabilidades abaixo devem existir.

### 7.1 Conta e sincronização Google

`google_accounts`

- `id`, com apenas uma conta ativa;
- `google_subject`, `email`, `display_name`;
- referência segura ao armazenamento de tokens, nunca token em texto exposto;
- `connected_at`, `updated_at`, `disconnected_at`.

`google_sync_state`

- `account_id`, `sync_token`, `last_full_sync_at`, `last_incremental_sync_at`;
- `status`, `last_error_code`, `last_error_message`;
- contadores da última sincronização.

`google_contacts`

- `id`, `account_id`, `resource_name` único, `etag`;
- nomes separados e nome exibido;
- apelido, organização, cargo, departamento, aniversário, notas/biografia;
- `raw_json` para preservar campos ainda não normalizados;
- `remote_deleted`, `remote_updated_at`, `synced_at`, `created_at`, `updated_at`.

`google_contact_phones`

- `id`, `google_contact_id`, `label`, `raw_value`, `normalized_phone`;
- `is_primary`, `is_valid`, `validation_reason`;
- índices em `normalized_phone` e `google_contact_id`.

`google_contact_labels`

- `google_contact_id`, identificador/nome do grupo e texto pesquisável.

Se filtros exigirem desempenho além do aceitável, adicionar colunas normalizadas/FTS somente após
medição. O JSON bruto não deve ser a única fonte para campos essenciais.

A implementação inicial usará índices SQLite normais. SQLite FTS só será adicionado se testes com
agendas grandes demonstrarem necessidade real e vier acompanhado de migrations e testes.

### 7.2 Filtros e seleção

`saved_contact_filters`

- `id`, `name`, `definition_json`, `created_at`, `updated_at`.

O AST/versionamento do filtro deve conter:

- versão do formato;
- grupos `AND`/`OR` aninháveis;
- campo, operador e valor;
- normalização de caixa/acentos;
- filtros de telefone, origem, label, validade, duplicidade e opt-out.

Não construir SQL concatenando campos ou operadores vindos do cliente. Traduzir uma lista fechada
de campos/operadores para SQL parametrizado.

### 7.3 Campanhas e lotes

Estender `campaigns` com:

- `batch_size`;
- `batch_interval_seconds`;
- `batch_order` (`name`, `google` ou `random`);
- `batch_order_seed` anulável, para reproduzir ordenação aleatória;
- `current_batch_number` e `next_batch_at`, ou estado persistido equivalente;
- `selection_filter_json` versionado;
- `selection_summary_json`;
- opcionalmente `selection_finalized_at`.

Estender `campaign_recipients` com:

- `google_contact_id` anulável e snapshot do `resource_name`;
- telefone original, label do telefone e campos renderizáveis congelados;
- `batch_number` e `position_in_batch`;
- `eligibility_status`, `result_code`, `result_reason`;
- `deletion_recommendation` (`recommended`, `review`, `not_recommended`);
- `deletion_reason_code` anulável.

Criar `campaign_selection_exclusions` ou persistir uma estrutura equivalente para registrar
inclusões/exclusões manuais aplicadas depois do filtro. O snapshot preparado deve continuar sendo a
fonte de verdade da execução.

### 7.4 Auditoria de exclusão

`contact_deletion_jobs`

- `id`, `campaign_id`, `status`, `requested_count`;
- `confirmed_at`, `started_at`, `finished_at`;
- snapshot dos filtros usados na tela de revisão.

`contact_deletion_items`

- `id`, `job_id`, `google_contact_id`, `resource_name_snapshot`;
- nome e telefone mascarável para auditoria;
- motivo selecionado, evidências em JSON versionado;
- `status`, `attempt_count`, `last_error_code`, `last_error_message`;
- `requested_at`, `deleted_at`, `verified_at`, `updated_at`.

Jobs e itens de exclusão não devem sumir quando a campanha for limpa pela retenção sem uma regra
explícita de auditoria. Preservar a auditoria enquanto a campanha existir e nunca remover jobs
incompletos. Se uma campanha for elegível à limpeza, bloquear a remoção enquanto houver job não
terminal; jobs concluídos seguem a retenção da campanha correspondente.

## 8. Motor de filtros inteligentes

### 8.1 Campos mínimos

- nome exibido, nome, nome do meio e sobrenome;
- nome fonético, prefixo, sufixo, apelido e “file as”, se disponíveis;
- todos os telefones: original, normalizado, DDI, DDD, final e label;
- email;
- organização, cargo e departamento;
- aniversário;
- notas/biografia;
- labels/grupos;
- endereço, relações, URLs e campos personalizados quando sincronizados;
- origem (`google`, `csv`, `manual`);
- estado de telefone, duplicidade e opt-out;
- data da última sincronização/alteração.

### 8.2 Operadores mínimos

- contém, não contém;
- igual, diferente;
- começa com, termina com;
- vazio, não vazio;
- antes, depois, entre, para datas;
- em lista, não em lista;
- válido/inválido;
- pertence/não pertence a label;
- combinação `AND`/`OR`.

Busca textual deve ser insensível a caixa e, quando tecnicamente viável, a acentos. Telefone deve ser
comparado também por sua forma normalizada.

### 8.3 Seleção e reprodutibilidade

- Mostrar resultados paginados e contagem total.
- “Selecionar todos” se refere a todos os resultados do filtro, não apenas à página visível.
- Guardar AST do filtro, IDs incluídos manualmente e IDs excluídos manualmente.
- Antes de preparar, recalcular a seleção e informar se a sincronização alterou os resultados.
- Depois de preparar, mudanças na agenda não alteram o snapshot da campanha.
- Campanhas históricas devem conseguir explicar quais filtros foram usados, ainda que um filtro salvo
  seja posteriormente editado ou apagado.

## 9. Lotes e execução da fila

### 9.1 Formação

- Validar `batch_size` como inteiro entre 1 e 100.
- Receber intervalo entre lotes em campos de horas e minutos, validar o total entre 0 e 48 horas e
  persistir o valor canônico em segundos.
- A ordenação deve ser estável e explicitamente definida antes do snapshot. O padrão é nome
  normalizado, com desempate por identificador interno. Também oferecer ordem original do Google e
  ordem aleatória; a ordem aleatória deve ser materializada no snapshot ou usar seed persistida.
- `batch_number = floor(index / batch_size) + 1`.
- Exibir lote total, lote atual e progresso dentro do lote.

### 9.2 Espera entre lotes

- A espera só acontece após terminar um lote e antes do próximo.
- Não aguardar depois do último lote.
- Persistir campanha, lote atual, posições concluídas e o instante `next_batch_at` para sobreviver a
  encerramento ou reinício da aplicação.
- Na inicialização, uma campanha interrompida não deve disparar silenciosamente. Ela deve aparecer
  como retomável, mostrando o lote e a espera restantes, e exigir ação do usuário para continuar.
- Ao retomar depois de `next_batch_at`, o próximo lote pode iniciar imediatamente após confirmação.
  Se o instante ainda estiver no futuro, preservar a contagem restante em vez de reiniciar as 48
  horas completas.
- Pausa durante a espera congela a progressão; retomada recalcula de modo previsível.
- Cancelamento marca pendentes como cancelados/ignorados sem reclassificá-los como inválidos.
- SSE deve emitir evento de lote concluído e contagem regressiva para o próximo lote.

### 9.3 Três tentativas técnicas

- `maxAttempts = 3` por destinatário.
- Erro transitório: aplicar backoff e tentar novamente até o limite.
- Erro permanente: não repetir inutilmente; encerrar o destinatário com motivo estruturado.
- Falha de `isRegisteredNumber` precisa distinguir resposta conclusiva `false` de erro/timeout da
  própria verificação.
- Uma falha da verificação não pode ser convertida em “não está no WhatsApp”.
- Registrar uma linha em `delivery_attempts` para cada tentativa real e, se necessário, uma etapa
  separada para a validação pré-envio.

## 10. Manifesto pós-campanha

O manifesto é uma visão persistida e reproduzível, não apenas um modal montado com textos de log.

### 10.1 Resumo

- total selecionado;
- total elegível e inelegível;
- envios aceitos;
- falhas permanentes;
- falhas transitórias esgotadas;
- não registrados no WhatsApp;
- telefones ausentes/inválidos;
- duplicados e opt-outs;
- número total de tentativas;
- total sugerido para revisão e para exclusão;
- resultados das exclusões já solicitadas.

### 10.2 Tabela detalhada

Colunas mínimas:

- seleção para ação;
- nome;
- telefone original e normalizado;
- origem e vínculo Google;
- lote;
- resultado;
- código e motivo legível;
- número de tentativas;
- última tentativa;
- recomendação de exclusão e evidência;
- estado da exclusão Google.

Fornecer os mesmos filtros inteligentes relevantes, busca, ordenação e paginação. Incluir atalhos
seguros como “somente números comprovadamente fora do WhatsApp” e “somente telefones inválidos”.
Não oferecer “selecionar todas as falhas” como ação destrutiva padrão, pois falhas transitórias não
justificam exclusão.

### 10.3 Confirmação destrutiva

Antes de criar o job:

- mostrar contagem, agrupamento por motivo e exemplos;
- exigir uma caixa de confirmação explícita;
- deixar claro que a ação apaga os contatos da conta Google;
- impedir envio com seleção vazia;
- não incluir itens que não possuam `resourceName` Google;
- avisar que contatos CSV/manual sem vínculo Google só podem ser removidos localmente por outra
  ação separada.

## 11. API/backend proposta

Os nomes podem evoluir, mas manter separação por domínio.

### 11.1 Novos módulos

- `src/providers/google/GooglePeopleProvider.ts`: interface testável do provedor.
- `src/providers/google/people/GooglePeopleApiProvider.ts`: OAuth e chamadas People API.
- `src/modules/google-auth`: estado OAuth, tokens e conta conectada.
- `src/modules/contact-sync`: sincronização completa/incremental e mapeamento.
- `src/modules/contact-selection`: AST, validação, tradução SQL, filtros salvos e seleção.
- `src/modules/contact-deletion`: política, jobs, execução sequencial e verificação.
- extensões em `campaigns` e `queue` para lotes e manifesto.

### 11.2 Endpoints indicativos

- `GET /api/google/status`
- `POST /api/google/oauth/start`
- `GET /api/google/oauth/callback`
- `POST /api/google/disconnect`
- `POST /api/google/sync`
- `GET /api/google/sync/status`
- `POST /api/contacts/search` com AST validado
- CRUD de `/api/contact-filters`
- `POST /api/campaigns/simulate-selection`
- `POST /api/campaigns/:id/prepare` incluindo confirmação da seleção
- `GET /api/campaigns/:id/manifest`
- `POST /api/campaigns/:id/deletion-jobs`
- `GET /api/contact-deletion-jobs/:id`
- `POST /api/contact-deletion-jobs/:id/retry`

Mutação por `GET` é proibida. Respostas de erro devem continuar sem stack trace e sem segredos.
Aplicar limites de payload, paginação e validação de IDs como nas rotas existentes.

## 12. Interface proposta

- Transformar o fluxo de campanha em wizard responsivo com indicador de etapas.
- Permitir voltar antes da preparação sem perder o rascunho.
- Depois da preparação, mudanças de seleção exigem retornar a rascunho e gerar novo snapshot.
- Mostrar claramente estados independentes de WhatsApp, Google e sincronização.
- Exibir skeleton/progresso durante sincronização; grandes agendas não podem congelar o navegador.
- Manter acessibilidade por teclado, labels, foco após erros e contraste.
- Toda ação longa deve apresentar progresso e ser retomável após reload.
- Manter exportação CSV do manifesto, protegida contra formula injection.
- Atualizar onboarding, configurações, navegação e README com configuração do Google Cloud/OAuth.

## 13. Segurança, privacidade e operação

- A aplicação continua ligada somente a `127.0.0.1` por padrão.
- OAuth callback também deve ser local e validado por `state`.
- Tokens e credenciais são segredos e devem ser mascarados pelo logger.
- Não registrar corpo bruto de contatos, notas, emails, tokens ou mensagens pessoais.
- Mascarar telefone em logs técnicos; a UI autenticada localmente pode mostrar o dado necessário.
- Sanitizar campos vindos do Google antes de renderizar; usar `textContent` ou escaping consistente.
- Queries de filtros devem ser parametrizadas e baseadas em allowlist.
- Exclusão remota deve ser auditável, idempotente na prática e nunca disparada por sincronização
  automática.
- Backup/restauração precisa ser revisado para as novas tabelas e eventual armazenamento seguro de
  tokens.
- Informar ao usuário que Baileys é não oficial e que campanhas devem respeitar consentimento,
  opt-out, políticas do WhatsApp e legislação aplicável.

## 14. Compatibilidade e migração

- Listas CSV/manuais existentes continuam funcionando.
- Adicionar origem `google` sem invalidar checks atuais de `contact_lists.source`; isso exigirá nova
  tabela/rebuild controlado em SQLite ou uma camada de agenda separada.
- Campanhas antigas sem lotes devem ser lidas como um único lote.
- Campanhas antigas sem manifesto estruturado continuam visíveis com dados derivados disponíveis.
- Follow-up existente será mantido e adaptado. A ação manual cria uma nova campanha vinculada à
  original, abre o mesmo wizard e herda, de forma editável, filtros, seleção elegível, configuração de
  lotes, intervalos, template e mídia. Ela deve usar motivos estruturados para escolher candidatos,
  nunca incluir opt-outs e gerar seu próprio snapshot e manifesto. Não iniciar follow-up
  automaticamente ao concluir uma campanha.
- Incrementar schema e versão do formato de backup quando necessário.
- Documentar rollback: código antigo não deve abrir silenciosamente um banco com schema mais novo.

## 15. Estratégia de testes

Toda fase precisa de testes unitários e de integração. APIs externas devem ser abstraídas e simuladas;
testes padrão não dependem de conta Google ou WhatsApp reais.

### 15.1 Google/OAuth

- geração e validação de `state`;
- callback válido, negado, expirado e repetido;
- refresh de token, revogação e token inválido;
- segredo ausente e configuração incorreta;
- garantia de que tokens não aparecem em logs/respostas.

### 15.2 Sincronização

- paginação completa;
- sync token e expiração;
- contato criado, alterado, mesclado e removido;
- vários telefones e telefone principal;
- labels/grupos;
- transação e recuperação após falha no meio;
- exclusão remota não remove histórico de campanha.

### 15.3 Filtros

- cada campo e operador;
- `AND`/`OR` aninhado;
- acentos, caixa, vazios e telefone normalizado;
- seleção de todos os resultados além da página atual;
- inclusões/exclusões manuais;
- AST inválido, campo proibido e tentativa de SQL injection;
- filtro salvo alterado não muda campanha preparada.

### 15.4 Campanhas/lotes

- divisão exata e último lote parcial;
- limites de tamanho e intervalo;
- ordem determinística;
- pausa, retomada, cancelamento e reinício entre lotes;
- nenhuma espera após o último lote;
- snapshot preserva filtros, dados e vínculos remotos;
- campanhas antigas funcionam como lote único.

### 15.5 Tentativas e manifesto

- sucesso na primeira, segunda e terceira tentativa;
- erro permanente não repete;
- transitório esgota três tentativas;
- timeout da verificação não vira `not_on_whatsapp`;
- motivo estruturado correto para cada resultado;
- `sent` exibido como “envio aceito”, nunca “entregue”;
- exportação segura contra CSV formula injection.

### 15.6 Exclusão

- somente itens confirmados são enviados;
- mutações são sequenciais;
- revalidação de identidade/evidência;
- sucesso, 404, 401/403, 429, 5xx e falha de rede;
- interrupção e nova tentativa apenas dos itens falhos;
- confirmação posterior por sincronização;
- auditoria permanece após reload/reinício;
- falha transitória de envio não é pré-selecionada para exclusão.

### 15.7 Validação final

Executar, no mínimo:

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Quando a cobertura for alterada significativamente, executar também `npm run test:coverage`.

## 16. Fases de implementação

### Fase 0 — decisões técnicas e fundação

- escolher biblioteca Google oficial/compatível com Node atual;
- criar interfaces do provedor e fakes;
- definir armazenamento seguro de credenciais/tokens;
- fechar schemas de AST, códigos de resultado e política de exclusão;
- criar migrations iniciais e testes de migração.

**Saída:** contratos estáveis, banco migrável e testes de fundação.

### Fase 1 — OAuth e sincronização Google

- tela/configuração do cliente OAuth;
- login, callback, refresh, logout/revogação;
- sincronização completa e incremental;
- visualização da conta, status e contatos sincronizados;
- tutorial de configuração no Google Cloud.

**Saída:** agenda Google local confiável e atualizável.

### Fase 2 — filtros e seleção

- AST e tradutor SQL seguro;
- UI de filtros, paginação, seleção global e exceções individuais;
- filtros salvos;
- deduplicação, opt-out e escolha de telefone;
- resumo de seleção.

**Saída:** conjunto reprodutível de destinatários pronto para campanha.

### Fase 3 — composer e lotes

- wizard substituindo o fluxo atual;
- persistência de filtro, tamanho e intervalo de lotes;
- snapshot enriquecido;
- previsão e revisão pré-envio;
- execução e recuperação conscientes de lote.

**Saída:** uma campanha única processada em lotes configuráveis.

### Fase 4 — motivos estruturados e manifesto

- taxonomia de validação/erro;
- relatório persistente;
- filtros inteligentes no manifesto;
- exportação e linguagem correta de “envio aceito”.

**Saída:** resultado explicável por destinatário e por tentativa.

### Fase 5 — exclusão Google segura

- política de recomendação;
- revisão e seleção explícita;
- jobs sequenciais, auditoria, retry e verificação;
- estados parciais e reconexão OAuth.

**Saída:** exclusão remota controlada, verificável e recuperável.

### Fase 6 — compatibilidade, documentação e endurecimento

- migração de dados antigos;
- atualização de onboarding, README, backup e CHANGELOG;
- testes de volume e desempenho;
- revisão de segurança/privacidade;
- QA completo em Windows e Linux/WSL.

**Saída:** versão pronta para uso cotidiano e atualização segura.

## 17. Critérios de aceite globais

O fluxo só é considerado concluído quando:

- uma conta Google pode ser conectada, sincronizada, desconectada e reconectada sem expor tokens;
- contatos Google são pesquisáveis localmente por todos os campos acordados;
- filtros complexos e alterações manuais geram seleção reproduzível;
- uma única campanha divide e executa destinatários em lotes configuráveis;
- pausa/reinício não duplica envios já confirmados nem perde a posição do lote;
- cada destinatário tem resultado e motivo estruturados;
- nenhuma falha transitória é apresentada como prova de contato inválido;
- o manifesto permite filtrar, selecionar e revisar candidatos à exclusão;
- nenhuma exclusão Google ocorre sem confirmação explícita;
- cada exclusão possui resultado individual, auditoria e opção de retry;
- campanhas, listas antigas, CSV/manual, opt-out, mídia, backup e monitoramento continuam válidos;
- todos os checks do projeto passam.

## 18. Regras para futuras alterações

- Ler este documento e o código relacionado antes de alterar o domínio.
- Não implementar exclusão automática de contatos Google.
- Não chamar envio aceito de entrega confirmada.
- Não inferir que toda falha permanente justifica exclusão.
- Não reduzir as proteções de opt-out, confirmação, snapshot, logs mascarados ou backup.
- Não guardar tokens no frontend, no Git ou em logs.
- Não alterar migrations antigas; adicionar migrations novas e testes correspondentes.
- Preservar alterações não relacionadas existentes no worktree.
- Manter módulos externos atrás de interfaces testáveis.
- Preferir mudanças pequenas por fase, com testes e documentação no mesmo conjunto.
- Atualizar este plano quando implementação real exigir decisão diferente, registrando o motivo.

## 19. Decisões técnicas consolidadas

- Tokens Google ficam persistidos no cofre seguro do sistema operacional para renovação automática
  da sessão, mas não entram no backup `.wabkp`.
- Lotes aceitam de 1 a 100 contatos.
- O intervalo entre lotes aceita de 0 a 48 horas, com entrada em horas e minutos e persistência do
  instante de retomada.
- A aplicação não retoma disparos silenciosamente após reinício; o usuário confirma a continuação a
  partir do estado persistido.
- A ordem padrão é por nome e ID; ordem Google e aleatória são alternativas reproduzíveis.
- O telefone principal é escolhido por padrão; ambiguidades ficam disponíveis para revisão.
- Auditorias de exclusão vivem enquanto a campanha existir, e jobs incompletos nunca são removidos
  pela limpeza automática.
- Follow-up permanece disponível como ação manual e passa a usar todo o novo fluxo.
- A busca começa com índices SQLite normais; FTS depende de evidência de desempenho em testes.

Essas definições estão fechadas para a implementação. Qualquer alteração futura deve registrar a
justificativa neste documento e preservar a alternativa mais conservadora para segurança,
privacidade e prevenção de exclusões indevidas.
