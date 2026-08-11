const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'data-service.js'), 'utf8');

function carregarServico({ config = {}, client = {} } = {}) {
    let uuidCounter = 0;
    const window = {
        APP_CONFIG: config,
        location: { origin: 'https://example.test', pathname: '/comunicador/' },
        supabase: { createClient: () => client },
        crypto: { randomUUID: () => `uuid-${++uuidCounter}` }
    };
    vm.runInNewContext(source, { window, URL, Intl, Date, Error, Object, Array, String, Boolean, Promise });
    return window.DataService;
}

test('recusa inicialização sem URL e publishable key', () => {
    const service = carregarServico();
    assert.equal(service.configurado(), false);
    assert.throws(() => service.paraIso('invalida', '10:00'), /Data ou hora inválida/);
});

test('carrega falhas e chamados centralizados com identificação do usuário', async () => {
    const rows = {
        failure_portal_reports: [{
            id: 'f1',
            occurred_at: '2026-08-11T12:00:00.000Z',
            title: 'FALHA SISTÊMICA',
            cluster: 'N/A',
            incident: null,
            task_or_system: 'Sistema: SIR',
            description: 'TESTE',
            attachment_path: 'u1/f1/imagem.png',
            attachment_name: 'imagem.png',
            attachment_mime: 'image/png',
            attachment_size: 1024,
            reporter_id: 'u1',
            reporter: { display_name: 'OPERADOR 1' }
        }],
        failure_portal_tickets: [{
            id: 't1',
            opened_at: '2026-08-11T11:00:00.000Z',
            closed_at: null,
            ticket_number: 'CH-1',
            reason: 'SIR',
            reporter_id: 'u2',
            reporter: { display_name: 'OPERADOR 2' }
        }]
    };
    const client = {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }) },
        from(table) {
            return {
                select() {
                    return { order: async () => ({ data: rows[table], error: null }) };
                }
            };
        }
    };
    const service = carregarServico({
        config: {
            supabaseUrl: 'https://projeto.supabase.co',
            supabasePublishableKey: `sb_publishable_${'x'.repeat(30)}`
        },
        client
    });

    assert.equal(service.configurado(), true);
    assert.equal((await service.sessaoAtual()).user.id, 'u1');
    const dados = await service.listarTudo();
    assert.equal(dados.falhas[0].reporterName, 'OPERADOR 1');
    assert.equal(dados.chamados[0].reporterName, 'OPERADOR 2');
    assert.equal(dados.falhas[0].incidente, 'N/A');
    assert.equal(dados.falhas[0].anexoPath, 'u1/f1/imagem.png');
    assert.equal(dados.falhas[0].anexoNome, 'imagem.png');
});

test('envia imagem privada e vincula o caminho ao registro', async () => {
    let upload;
    let payload;
    const client = {
        auth: {
            getUser: async () => ({ data: { user: { id: 'u1' } }, error: null })
        },
        storage: {
            from(bucket) {
                assert.equal(bucket, 'failure-portal-images');
                return {
                    upload: async (path, file, options) => {
                        upload = { path, file, options };
                        return { data: { path }, error: null };
                    },
                    remove: async () => ({ data: [], error: null }),
                    createSignedUrl: async path => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null })
                };
            }
        },
        from(table) {
            assert.equal(table, 'failure_portal_reports');
            return {
                insert(value) {
                    payload = value;
                    return {
                        select() {
                            return {
                                single: async () => ({
                                    data: {
                                        ...value,
                                        reporter_id: 'u1',
                                        reporter: { display_name: 'OPERADOR 1' }
                                    },
                                    error: null
                                })
                            };
                        }
                    };
                }
            };
        }
    };
    const service = carregarServico({
        config: {
            supabaseUrl: 'https://projeto.supabase.co',
            supabasePublishableKey: `sb_publishable_${'i'.repeat(30)}`
        },
        client
    });
    const imagem = { name: 'evidencia.png', type: 'image/png', size: 1024 };
    const falha = await service.criarFalha({
        occurredAt: '2026-08-11T12:00:00.000Z',
        titulo: 'FALHA',
        cluster: 'RJ',
        incidente: 'N/A',
        taskOuSistema: 'N/A',
        descricao: 'TESTE'
    }, imagem);

    assert.equal(upload.path, 'u1/uuid-1/uuid-2.png');
    assert.equal(upload.file, imagem);
    assert.equal(upload.options.upsert, false);
    assert.equal(payload.id, 'uuid-1');
    assert.equal(payload.attachment_path, upload.path);
    assert.equal(payload.attachment_name, 'evidencia.png');
    assert.equal(falha.anexoMime, 'image/png');
    assert.equal(await service.criarUrlAnexo(upload.path), `https://signed.test/${upload.path}`);
});

test('recusa anexos fora dos formatos e do limite permitido', () => {
    const service = carregarServico();
    assert.throws(
        () => service.validarImagem({ name: 'arquivo.svg', type: 'image/svg+xml', size: 100 }),
        /Formato de imagem inválido/
    );
    assert.throws(
        () => service.validarImagem({ name: 'grande.png', type: 'image/png', size: 5 * 1024 * 1024 + 1 }),
        /no máximo 5 MB/
    );
});

test('propaga erro de leitura do servidor com contexto', async () => {
    const client = {
        auth: {},
        from() {
            return {
                select() {
                    return { order: async () => ({ data: null, error: { message: 'RLS bloqueou' } }) };
                }
            };
        }
    };
    const service = carregarServico({
        config: {
            supabaseUrl: 'https://projeto.supabase.co',
            supabasePublishableKey: `sb_publishable_${'y'.repeat(30)}`
        },
        client
    });
    await assert.rejects(service.listarTudo(), /Falha ao carregar os registros: RLS bloqueou/);
});

test('cadastro aceita somente domínio corporativo e marca a aplicação correta', async () => {
    let payload;
    const client = {
        auth: {
            signUp: async value => {
                payload = value;
                return { data: { user: { id: 'u1' }, session: null }, error: null };
            }
        }
    };
    const service = carregarServico({
        config: {
            supabaseUrl: 'https://projeto.supabase.co',
            supabasePublishableKey: `sb_publishable_${'z'.repeat(30)}`,
            allowedEmailDomain: 'claro.com.br'
        },
        client
    });

    await assert.rejects(
        service.cadastrar('Usuário Teste', 'teste@example.com', 'senha-segura'),
        /@claro\.com\.br/
    );
    await service.cadastrar('Usuário Teste', 'TESTE@CLARO.COM.BR', 'senha-segura');
    assert.equal(payload.email, 'teste@claro.com.br');
    assert.equal(payload.options.data.application, 'failure-portal');
    assert.equal(payload.options.emailRedirectTo, 'https://example.test/comunicador/');
});
