(function criarDataService(global) {
    'use strict';

    const config = global.APP_CONFIG || {};
    let client = null;

    function configurado() {
        return Boolean(
            global.supabase &&
            /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.supabaseUrl || '') &&
            typeof config.supabasePublishableKey === 'string' &&
            config.supabasePublishableKey.length > 20
        );
    }

    function obterClient() {
        if (!configurado()) {
            throw new Error('Servidor não configurado. Informe a URL e a publishable key em js/config.js.');
        }
        if (!client) {
            client = global.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
            });
        }
        return client;
    }

    function propagarErro(error, contexto) {
        if (!error) return;
        const mensagem = error.message || String(error);
        throw new Error(`${contexto}: ${mensagem}`);
    }

    function formatarDataHora(iso) {
        if (!iso) return '';
        const data = new Date(iso);
        if (Number.isNaN(data.getTime())) return '';
        return new Intl.DateTimeFormat('pt-BR', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(data);
    }

    function paraIso(data, hora) {
        const valor = new Date(`${data}T${hora}:00`);
        if (Number.isNaN(valor.getTime())) throw new Error('Data ou hora inválida.');
        return valor.toISOString();
    }

    function dataBrParaIso(valor) {
        const match = String(valor || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
        if (!match) return null;
        return paraIso(`${match[3]}-${match[2]}-${match[1]}`, `${match[4]}:${match[5]}`);
    }

    function nomeDoPerfil(relacao, fallback) {
        const perfil = Array.isArray(relacao) ? relacao[0] : relacao;
        return perfil?.display_name || fallback || 'USUÁRIO';
    }

    function mapearFalha(row) {
        return {
            id: row.id,
            dataHora: formatarDataHora(row.occurred_at),
            dataIso: row.occurred_at,
            titulo: row.title,
            cluster: row.cluster,
            incidente: row.incident || 'N/A',
            taskOuSistema: row.task_or_system || 'N/A',
            descricao: row.description,
            reporterId: row.reporter_id,
            reporterName: nomeDoPerfil(row.reporter, row.reporter_name)
        };
    }

    function mapearChamado(row) {
        return {
            id: row.id,
            dataHora: formatarDataHora(row.opened_at),
            dataIso: row.opened_at,
            numero: row.ticket_number,
            motivo: row.reason,
            dataEncerramento: formatarDataHora(row.closed_at),
            encerramentoIso: row.closed_at,
            reporterId: row.reporter_id,
            reporterName: nomeDoPerfil(row.reporter, row.reporter_name)
        };
    }

    const failureSelect = 'id,occurred_at,title,cluster,incident,task_or_system,description,reporter_id,reporter:failure_portal_profiles!failure_portal_reports_reporter_id_fkey(display_name)';
    const ticketSelect = 'id,opened_at,closed_at,ticket_number,reason,reporter_id,reporter:failure_portal_profiles!failure_portal_tickets_reporter_id_fkey(display_name)';

    async function sessaoAtual() {
        if (!configurado()) return null;
        const { data, error } = await obterClient().auth.getSession();
        propagarErro(error, 'Falha ao verificar a sessão');
        return data.session;
    }

    async function entrar(email, senha) {
        const { data, error } = await obterClient().auth.signInWithPassword({ email, password: senha });
        propagarErro(error, 'Não foi possível entrar');
        return data.session;
    }

    async function cadastrar(displayName, email, senha) {
        const dominio = String(config.allowedEmailDomain || '').toLowerCase();
        const emailNormalizado = String(email || '').trim().toLowerCase();
        if (!dominio || !emailNormalizado.endsWith(`@${dominio}`)) {
            throw new Error(`Use um e-mail corporativo @${dominio || 'domínio autorizado'}.`);
        }
        if (String(displayName || '').trim().length < 3) {
            throw new Error('Informe seu nome com pelo menos 3 caracteres.');
        }
        if (String(senha || '').length < 8) {
            throw new Error('A senha precisa ter pelo menos 8 caracteres.');
        }
        const emailRedirectTo = global.location ? `${global.location.origin}${global.location.pathname}` : undefined;
        const { data, error } = await obterClient().auth.signUp({
            email: emailNormalizado,
            password: senha,
            options: {
                data: {
                    display_name: String(displayName).trim().slice(0, 120),
                    application: 'failure-portal'
                },
                emailRedirectTo
            }
        });
        propagarErro(error, 'Não foi possível criar a conta');
        return data;
    }

    async function obterAcesso() {
        const { data, error } = await obterClient()
            .from('failure_portal_memberships')
            .select('role')
            .maybeSingle();
        propagarErro(error, 'Falha ao verificar o acesso ao Comunicador');
        return data?.role || null;
    }

    async function sair() {
        const { error } = await obterClient().auth.signOut();
        propagarErro(error, 'Não foi possível encerrar a sessão');
    }

    function observarAuth(callback) {
        if (!configurado()) return () => {};
        const { data } = obterClient().auth.onAuthStateChange((_event, session) => callback(session));
        return () => data.subscription.unsubscribe();
    }

    async function listarTudo() {
        const supabaseClient = obterClient();
        const [falhasResult, chamadosResult] = await Promise.all([
            supabaseClient.from('failure_portal_reports').select(failureSelect).order('occurred_at', { ascending: false }),
            supabaseClient.from('failure_portal_tickets').select(ticketSelect).order('opened_at', { ascending: false })
        ]);
        propagarErro(falhasResult.error, 'Falha ao carregar os registros');
        propagarErro(chamadosResult.error, 'Falha ao carregar os chamados');
        return {
            falhas: (falhasResult.data || []).map(mapearFalha),
            chamados: (chamadosResult.data || []).map(mapearChamado)
        };
    }

    async function criarFalha(falha) {
        const payload = {
            occurred_at: falha.occurredAt,
            title: falha.titulo,
            cluster: falha.cluster,
            incident: falha.incidente === 'N/A' ? null : falha.incidente,
            task_or_system: falha.taskOuSistema === 'N/A' ? null : falha.taskOuSistema,
            description: falha.descricao
        };
        const { data, error } = await obterClient().from('failure_portal_reports').insert(payload).select(failureSelect).single();
        propagarErro(error, 'Falha ao salvar o registro no servidor');
        return mapearFalha(data);
    }

    async function excluirFalha(id) {
        const { error } = await obterClient().from('failure_portal_reports').delete().eq('id', id);
        propagarErro(error, 'Falha ao excluir o registro');
    }

    async function criarChamado(chamado) {
        const payload = {
            opened_at: chamado.openedAt,
            ticket_number: chamado.numero,
            reason: chamado.motivo
        };
        const { data, error } = await obterClient().from('failure_portal_tickets').insert(payload).select(ticketSelect).single();
        propagarErro(error, 'Falha ao salvar o chamado no servidor');
        return mapearChamado(data);
    }

    async function encerrarChamado(id, closedAt) {
        const { data, error } = await obterClient().from('failure_portal_tickets')
            .update({ closed_at: closedAt })
            .eq('id', id)
            .select(ticketSelect)
            .single();
        propagarErro(error, 'Falha ao salvar o encerramento');
        return mapearChamado(data);
    }

    async function excluirChamado(id) {
        const { error } = await obterClient().from('failure_portal_tickets').delete().eq('id', id);
        propagarErro(error, 'Falha ao excluir o chamado');
    }

    async function importarLegado(falhas, tickets) {
        const resultados = { falhas: 0, chamados: 0 };
        for (const falha of (falhas || []).slice(0, 500)) {
            const occurredAt = falha.dataIso || dataBrParaIso(falha.dataHora);
            if (!occurredAt) continue;
            await criarFalha({
                occurredAt,
                titulo: String(falha.titulo || 'SEM TÍTULO').slice(0, 160),
                cluster: String(falha.cluster || 'N/A').slice(0, 10),
                incidente: String(falha.incidente || 'N/A').slice(0, 120),
                taskOuSistema: String(falha.taskOuSistema || 'N/A').slice(0, 180),
                descricao: String(falha.descricao || 'IMPORTADO DO ARMAZENAMENTO LOCAL').slice(0, 5000)
            });
            resultados.falhas += 1;
        }
        for (const ticket of (tickets || []).slice(0, 500)) {
            const openedAt = ticket.dataIso || dataBrParaIso(ticket.dataHora);
            if (!openedAt) continue;
            const criado = await criarChamado({
                openedAt,
                numero: String(ticket.numero || '').slice(0, 120),
                motivo: String(ticket.motivo || '').slice(0, 180)
            });
            const closedAt = ticket.encerramentoIso || dataBrParaIso(ticket.dataEncerramento);
            if (closedAt) await encerrarChamado(criado.id, closedAt);
            resultados.chamados += 1;
        }
        return resultados;
    }

    global.DataService = Object.freeze({
        configurado,
        sessaoAtual,
        entrar,
        cadastrar,
        obterAcesso,
        sair,
        observarAuth,
        listarTudo,
        criarFalha,
        excluirFalha,
        criarChamado,
        encerrarChamado,
        excluirChamado,
        importarLegado,
        paraIso,
        formatarDataHora
    });
})(window);
