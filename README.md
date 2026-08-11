# Comunicador de falhas

Portal estático integrado ao Supabase para centralizar falhas e chamados. Os dados não dependem do `localStorage`: o histórico e os relatórios consultam a mesma base remota, identificam administradores e preservam o anonimato das inserções da Equipe Madrugada.

## Arquitetura

- GitHub Pages (ou qualquer servidor estático) hospeda `index.html`, `css/` e `js/`.
- Supabase Auth autentica cada usuário por e-mail e senha.
- Postgres/Supabase armazena `failure_portal_reports`, `failure_portal_tickets` e `failure_portal_profiles`, isoladas por prefixo das tabelas de outros sistemas no mesmo projeto gratuito.
- Supabase Storage mantém imagens de falhas em bucket privado, limitado a 5 MB e acessível somente por membros autenticados do Comunicador.
- RLS permite leitura compartilhada somente entre membros do Comunicador, inserção em nome próprio e exclusão somente para administradores; usuários de outros sistemas do mesmo Supabase permanecem isolados.
- A `service_role`/secret key nunca é enviada ao navegador.

## Configuração

1. Crie ou selecione um projeto Supabase.
2. Aplique a migration em `supabase/migrations`.
3. Copie a URL do projeto e uma **publishable key** ativa para `js/config.js`.
4. O cadastro público foi desativado. As contas são provisionadas no servidor e a autorização é registrada em `failure_portal_memberships`, nunca em metadados editáveis do usuário.
5. Existem apenas dois papéis: `admin` e `team`. Kelly, Marley e Nelson pertencem a `admin`; a conta compartilhada Madrugada pertence a `team`. Os e-mails de Marley e Madrugada precisam ser incluídos em `failure_portal_private.allowed_accounts` antes do provisionamento.
6. Contas administrativas devem ser criadas pela Admin API do Supabase com `email_confirm: true`; não desligue a confirmação global, pois o projeto também atende o Férias Inteligentes.
7. O identificador real do autor permanece apenas no banco para auditoria. Consultas do navegador recebem somente o nome do administrador ou `EQUIPE MADRUGADA (ANÔNIMO)`.
8. No GitHub, configure **Settings > Pages > Deploy from a branch**, usando `main` e a pasta `/ (root)`. Esse modo hospeda o site gratuitamente sem depender de runners do GitHub Actions.

Exemplo de configuração pública:

```js
window.APP_CONFIG = Object.freeze({
    supabaseUrl: 'https://SEU-PROJETO.supabase.co',
    supabasePublishableKey: 'sb_publishable_...'
});
```

## Desenvolvimento local

Sirva a pasta por HTTP; abrir diretamente via `file://` pode bloquear dependências externas:

```powershell
npx http-server . -p 4173 -a 127.0.0.1 -c-1
```

Acesse `http://127.0.0.1:4173`.

## Segurança

O antigo login fixo no JavaScript foi removido. A publishable key é pública por definição e seu acesso é limitado pelas políticas RLS. Nunca coloque `sb_secret_...`, `service_role` ou senha do banco em arquivos versionados.
