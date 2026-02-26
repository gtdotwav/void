# JV Video Studio

Interface local para gerar clips, editar cortes/legendas, transcrever com ElevenLabs e criar assets (thumb/titles/hashtags).

## Execucao rapida

### Opcao 1 (recomendada): um servidor so

```bash
cd /Users/geander/Desktop/jv
node server.mjs
```

Abra: `http://localhost:8787`

Atalho:

```bash
cd /Users/geander/Desktop/jv
./run-local.sh
```

Esse comando salva logs em `/tmp/jv-backend.log`.

### Opcao 2: frontend e backend separados

Terminal 1:

```bash
cd /Users/geander/Desktop/jv
node server.mjs
```

Terminal 2:

```bash
cd /Users/geander/Desktop/jv
python3 -m http.server 8080
```

Abra: `http://localhost:8080`

## Diagnostico

```bash
curl -s http://localhost:8787/health
```

Campos mais importantes:

- `hasElevenLabsKey: true` -> API key carregada
- `youtubeTranscribeReady: true` -> YouTube + transcricao automatica ok
- `ytDlp.available: true` -> yt-dlp disponivel

## Novas APIs de automacao

- `POST /api/automation` com `action=ingest` -> analise de ingestao (cuts, viral, emocao, energia, CTA)
- `POST /api/automation` com `action=frame_patch` -> cria AI patch layer de frame
- `POST /api/automation` com `action=motion_reconstruct` -> plano de reconstrucao de motion
- `POST /api/automation` com `action=render_incremental` -> plano de render diferencial
- `GET /api/automation` -> snapshot do estado da automacao
- `GET /api/workflow` -> marketplace de templates de workflow
- `POST /api/workflow` com `action=apply_template` -> aplica template em workflow
- `GET /api/keys` -> lista keys salvas no vault
- `POST /api/keys` com `action=save_key` -> salva key criptografada por provider
- `POST /api/keys` com `action=remove_key` -> remove key do vault

## Key Vault (criptografia)

- Configure `KEY_VAULT_MASTER_KEY` no `.env` para ativar armazenamento criptografado de keys.
- Sem `KEY_VAULT_MASTER_KEY`, o sistema tenta fallback usando material de chave ja existente no ambiente.
- O frontend pode salvar keys no vault pela aba `Complementar Video`.

## Variaveis de ambiente

Use o arquivo `.env`:

```env
ELEVENLABS_API_KEY=...
ELEVENLABS_AGENT_ID=agent_3701khd9583qe1ctjzvqxtz38cfa
YT_DLP_PATH=yt-dlp
PORT=8787
```

## Troubleshooting

- Se abrir "Directory listing for /", use `http://localhost:8080/generated-page%20(1).html` ou mantenha `index.html` presente.
- Se YouTube nao permitir player embed, o sistema usa fallback de metadados via backend e segue com edicao/transcricao.
- No chat da interface, use `diagnostico` para checar backend/yt-dlp/chave em tempo real.
- Se `yt-dlp` faltar:

```bash
brew install yt-dlp
```
