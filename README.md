# WA-Delivery

Aplicação local para criar listas de contatos, preparar campanhas e enviar mensagens pelo WhatsApp com acompanhamento em tempo real.

> Utiliza Baileys, uma integração não oficial com o WhatsApp. Envie mensagens somente para contatos que autorizaram o recebimento.

## Requisitos

- Node.js 24.14.0 ou superior;
- npm, incluído na instalação do Node.js.

Baixe o Node.js em [nodejs.org](https://nodejs.org/).

## Windows

1. Baixe ou clone este repositório.
2. Abra a pasta do projeto.
3. Execute `RUN.bat`.

Na primeira execução, as dependências serão instaladas e a aplicação será compilada automaticamente. Depois disso, o navegador abrirá em:

```text
http://localhost:3000
```

Para encerrar, feche a janela do terminal ou pressione `Ctrl+C`.

## Linux e WSL

```bash
chmod +x run.sh
./run.sh
```

No WSL, abra `http://localhost:3000` no navegador do Windows caso ele não seja aberto automaticamente.

## Primeiro uso

1. Conecte o WhatsApp pelo QR Code.
2. Conecte e sincronize o Google Contacts, importe um CSV ou crie uma lista manual.
3. Crie e revise a campanha.
4. Confirme o envio.
5. Acompanhe o progresso pela página de monitoramento.

As configurações, contatos, campanhas, mídias e sessão ficam armazenados localmente no diretório `data/`.

## Google Contacts

Para usar a agenda Google como fonte principal:

Crie no Google Cloud um cliente OAuth 2.0 do tipo **Aplicativo para computador**, com a
**Google People API** habilitada. Depois abra **Configurações > Google Contacts**, salve o Client ID
e o Client secret, reinicie a aplicação e conecte a conta. As variáveis `GOOGLE_CLIENT_ID` e
`GOOGLE_CLIENT_SECRET` continuam disponíveis como override administrativo opcional.

No Windows, os tokens são cifrados com DPAPI para o usuário atual e armazenados em
`%LOCALAPPDATA%\WA-Delivery\google-tokens.bin`. Eles persistem entre execuções para evitar logins
frequentes, não ficam no repositório e não são incluídos no backup `.wabkp`.

O Client ID e uma referência ao segredo ficam no banco local. O Client secret é cifrado com DPAPI
no arquivo `%LOCALAPPDATA%\WA-Delivery\google-oauth-client.bin`, sem ser gravado em texto puro no
SQLite.

No Linux/WSL, instale `libsecret-tools` (o comando `secret-tool`) e tenha um Secret Service/chaveiro
desbloqueado na sessão. Os tokens são armazenados nesse cofre do sistema e também ficam fora do
backup. Se o WSL não possuir um Secret Service disponível, use a aplicação pelo Windows; não há
fallback para token em texto puro.

O acesso solicitado é o escopo de contatos da People API, necessário para ler, sincronizar e —
somente depois de revisão e confirmação explícita — excluir contatos. Desconectar revoga a sessão
quando possível, mas mantém a agenda sincronizada e o histórico local. Após restaurar um backup em
outro usuário/computador, conecte a conta novamente porque os tokens não fazem parte do `.wabkp`.

## Atualização

Faça um backup pela página **Configurações** antes de atualizar. Depois execute:

```bash
git pull --ff-only
npm ci
npm run build
```

Inicie novamente com `RUN.bat` ou `./run.sh`.

As migrations são aplicadas automaticamente ao iniciar. Depois que um banco for aberto por uma
versão com schema mais novo, não execute uma versão antiga sobre o mesmo diretório `data/`. Para
rollback, encerre a aplicação, preserve o diretório atual e restaure um `.wabkp` criado pela versão
anterior. A restauração recusa backups cujo schema seja mais novo que o código em execução.

## Desenvolvimento

```bash
npm ci
npm run dev
```

Comandos de validação:

```bash
npm run check
npm run test:coverage
npm audit --omit=dev
```

## Backup

Na página **Configurações**, é possível baixar e restaurar um backup `.wabkp` contendo o banco, as
mídias e a sessão local.

Guarde esse arquivo em local seguro, pois ele contém os dados da sessão do WhatsApp.
