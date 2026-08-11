# Comunicador de falhas

Portal estático integrado ao Supabase para centralizar falhas e chamados reportados por vários usuários. Os dados não dependem mais do `localStorage` do navegador: o histórico e os relatórios consultam a mesma base remota e identificam o usuário responsável por cada inserção.

## Arquitetura

- GitHub Pages (ou qualquer servidor estático) hospeda `index.html`, `css/` e `js/`.
- Supabase Auth autentica cada usuário por e-mail e senha.
- Postgres/Supabase armazena `failure_portal_reports`, `failure_portal_tickets` e `failure_portal_profiles`, isoladas por prefixo das tabelas de outros sistemas no mesmo projeto gratuito.
- RLS permite leitura compartilhada somente entre membros do Comunicador, inserção em nome próprio e exclusão somente para administradores; usuários de outros sistemas do mesmo Supabase permanecem isolados.
- A `service_role`/secret key nunca é enviada ao navegador.

## Configuração

1. Crie ou selecione um projeto Supabase.
2. Aplique a migration em `supabase/migrations`.
3. Copie a URL do projeto e uma **publishable key** ativa para `js/config.js`.
4. No primeiro acesso, usuários `@claro.com.br` podem criar uma conta e confirmar o e-mail. A autorização é registrada em `failure_portal_memberships`, não em metadados editáveis do usuário.
5. Após a confirmação do e-mail, `nelson.soares@claro.com.br` e `kelly.lira@claro.com.br` recebem o papel de administrador; demais contas recebem `reporter`. Alterações de papel devem ser feitas apenas no banco por um administrador.
6. No GitHub, configure **Settings > Pages > Deploy from a branch**, usando `main` e a pasta `/ (root)`. Esse modo hospeda o site gratuitamente sem depender de runners do GitHub Actions.

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
