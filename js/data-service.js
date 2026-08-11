(function criarDataService(global) {
    'use strict';

    const config = global.APP_CONFIG || {};
    let client = null;
    const imageBucket = 'failure-portal-images';
    const imageTypes = Object.freeze({
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif'
    });
    const maxImageSize = 5 * 1024 * 1024;

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
            reporterName: nomeDoPerfil(row.reporter, row.reporter_name),
            anexoPath: row.attachment_path || null,
            anexoNome: row.attachment_name || null,
            anexoMime: row.attachment_mime || null,
            anexoTamanho: row.attachment_size || null
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

    const failureSelect = 'id,occurred_at,title,cluster,incident,task_or_system,description,attachment_path,attachment_name,attachment_mime,attachment_size,reporter_id,reporter:failure_portal_profiles!failure_portal_reports_reporter_id_fkey(display_name)';
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

    function validarImagem(imagem) {
        if (!imagem) return null;
        if (!Object.hasOwn(imageTypes, imagem.type)) {
            throw new Error('Formato de imagem inválido. Use JPG, PNG, WEBP ou GIF.');
        }
        if (!Number.isFinite(imagem.size) || imagem.size < 1 || imagem.size > maxImageSize) {
            throw new Error('A imagem deve ter no máximo 5 MB.');
        }
        return imagem;
    }

    function criarIdentificador() {
        if (!global.crypto?.randomUUID) {
            throw new Error('Este navegador não oferece suporte seguro ao envio de imagens. Atualize-o e tente novamente.');
        }
        return global.crypto.randomUUID();
    }

    async function criarFalha(falha, imagem = null) {
        validarImagem(imagem);
        const supabaseClient = obterClient();
        let caminhoAnexo = null;
        let reportId = null;

        if (imagem) {
            const { data: userData, error: userError } = await supabaseClient.auth.getUser();
            propagarErro(userError, 'Falha ao identificar o usuário do anexo');
            if (!userData?.user?.id) throw new Error('Sessão inválida para enviar a imagem. Entre novamente.');

            reportId = criarIdentificador();
            caminhoAnexo = `${userData.user.id}/${reportId}/${criarIdentificador()}.${imageTypes[imagem.type]}`;
            const { error: uploadError } = await supabaseClient.storage
                .from(imageBucket)
                .upload(caminhoAnexo, imagem, {
                    cacheControl: '3600',
                    contentType: imagem.type,
                    upsert: false
                });
            propagarErro(uploadError, 'Falha ao enviar a imagem');
        }

        const payload = {
            ...(reportId ? { id: reportId } : {}),
            occurred_at: falha.occurredAt,
            title: falha.titulo,
            cluster: falha.cluster,
            incident: falha.incidente === 'N/A' ? null : falha.incidente,
            task_or_system: falha.taskOuSistema === 'N/A' ? null : falha.taskOuSistema,
            description: falha.descricao,
            attachment_path: caminhoAnexo,
            attachment_name: imagem ? String(imagem.name || 'imagem').slice(0, 255) : null,
            attachment_mime: imagem?.type || null,
            attachment_size: imagem?.size || null
        };

        const { data, error } = await supabaseClient.from('failure_portal_reports').insert(payload).select(failureSelect).single();
        if (error && caminhoAnexo) {
            await supabaseClient.storage.from(imageBucket).remove([caminhoAnexo]);
        }
        propagarErro(error, 'Falha ao salvar o registro no servidor');
        return mapearFalha(data);
    }

    async function excluirFalha(id, caminhoAnexo = null) {
        const supabaseClient = obterClient();
        const { error } = await supabaseClient.from('failure_portal_reports').delete().eq('id', id);
        propagarErro(error, 'Falha ao excluir o registro');
        if (!caminhoAnexo) return { cleanupWarning: null };

        const { error: cleanupError } = await supabaseClient.storage.from(imageBucket).remove([caminhoAnexo]);
        return {
            cleanupWarning: cleanupError
                ? `Registro excluído, mas a imagem não pôde ser removida: ${cleanupError.message || cleanupError}`
                : null
        };
    }

    async function criarUrlAnexo(caminhoAnexo) {
        if (!caminhoAnexo) throw new Error('Este registro não possui imagem.');
        const { data, error } = await obterClient().storage
            .from(imageBucket)
            .createSignedUrl(caminhoAnexo, 60);
        propagarErro(error, 'Falha ao abrir a imagem');
        if (!data?.signedUrl) throw new Error('O servidor não retornou o endereço da imagem.');
        return data.signedUrl;
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
        criarUrlAnexo,
        validarImagem,
        criarChamado,
        encerrarChamado,
        excluirChamado,
        importarLegado,
        paraIso,
        formatarDataHora
    });
})(window);
