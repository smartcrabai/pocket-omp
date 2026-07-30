# pocket-omp

Pocket OMPのCloudflare Workers実装です。Relayはrecipient device単位のDurable Object、Review Hostはaccount単位のDurable Object、push通知はDurable Object OutboxとCloudflare Queuesで処理します。

## 必要なツール

- Bun 1.3.14
- Buf 1.72以降
- CloudflareアカウントとWrangler認証

```bash
bun install --frozen-lockfile
```

## 動作確認

リポジトリ全体の静的検査とテスト：

```bash
bun run check
```

Workersの契約テストだけを実行：

```bash
bun run test:workers
```

ローカルWorkerを起動：

```bash
bun run dev
```

```bash
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

## Cloudflareリソースの初期作成

```bash
bunx wrangler login
bunx wrangler queues create pocket-omp-push
bunx wrangler queues create pocket-omp-push-dead-letter
bunx wrangler queues create pocket-omp-review-push
bunx wrangler queues create pocket-omp-review-push-dead-letter
bunx wrangler r2 bucket create pocket-omp-snapshots
bunx wrangler r2 bucket create pocket-omp-snapshots-review
```

`wrangler.jsonc`の`RELAY_JWT_ISSUER`、`RELAY_JWKS_URL`、`STAFF_SSO_ISSUER`、`STAFF_SSO_JWKS_URL`を実際のControl API／IdPへ変更します。`RELAY_AUTH_DISABLED`と`ADMIN_AUTH_DISABLED`は本番では必ず`false`のままにします。

設定とバンドルをデプロイせず検査：

```bash
bun run deploy:check
bun run --cwd services/control-api deploy:check:review
```

## デプロイ

Cloudflareへログイン済みのローカル環境：

```bash
bun run deploy
```

隔離されたApp Review環境：

```bash
bun run deploy:review
```

GitHub Actionsからデプロイする場合は、GitHub Environmentの`production`と`review`に次のSecretsを登録します。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Deployは`Deploy Workers` workflowの手動実行（`workflow_dispatch`）でのみ行います。`main`へのpushでの自動deployは、issuer/JWKS等の実値が安定するまで無効化しています。

Relay ticket署名鍵はWrangler secretとして環境ごとに設定します（base64エンコードしたEd25519 private JWK）。初回のみ：

```bash
# base64 JWKを生成して投入（値は出力しない）
bun -e 'import { generateKeyPair, exportJWK } from "jose"; const { privateKey } = await generateKeyPair("EdDSA", { extractable: true }); const jwk = await exportJWK(privateKey); jwk.kid = "relay-signing-1"; jwk.alg = "EdDSA"; jwk.use = "sig"; process.stdout.write(btoa(JSON.stringify(jwk)));' \
  | bunx wrangler secret put RELAY_SIGNING_PRIVATE_KEY --name pocket-omp
bun -e 'import { generateKeyPair, exportJWK } from "jose"; const { privateKey } = await generateKeyPair("EdDSA", { extractable: true }); const jwk = await exportJWK(privateKey); jwk.kid = "relay-signing-1"; jwk.alg = "EdDSA"; jwk.use = "sig"; process.stdout.write(btoa(JSON.stringify(jwk)));' \
  | bunx wrangler secret put RELAY_SIGNING_PRIVATE_KEY --name pocket-omp-review
```

## Host CLI release

`pocket-omp-host`、`pocket-omp-agent-runtime`、`pocket-omp`、固定バージョンの`omp`をmacOS arm64/x64、Linux arm64/x64、Windows x64向けに同一のatomic releaseとしてbuildします。

- Agent RuntimeはOMP SDKを専用child processへ隔離します。
- HostとRuntimeは最大1 MiBのphysical frame、32 MiBのlogical message、SHA-256検証付きchunkからなるlength-prefixed `RuntimeFrame` Protobuf IPCを使用します。
- CLIとHost Daemonは短期secretによる相互HMAC認証を備えたlocal controlを使用します。macOS／LinuxのUDSはcurrent-user peer credentialも検証し、Windows named pipeのsecretはcurrent-userのlocal application-data directoryへ保存します。
- `pocket-omp tui <session-id>`はDaemonからsession file ownershipをhandoffして固定バージョンのOMP TUIを起動し、終了後にfingerprintを検証してDaemonへ所有権を戻します。

`HOST_UPDATE_SIGNING_KEY` Repository Secretには32-byte Ed25519 seedをbase64で登録します。`vX.Y.Z`タグのpushで`Host Release` workflowが全platformをbuild・検証し、署名update manifestとGitHub Releaseを公開します。workflow入力はシェルへ直接展開せず、環境変数経由で渡します。

署名公開鍵は`apps/host/src/update-trust.ts`へpinされ、release workflowはSecretから導出した公開鍵との一致を公開前に検証します。`pocket-omp update`はlatest releaseのplatform別manifestを取得し、署名、有効期限、version、Runtime IPC範囲、4成果物のsizeとSHA-256を検証してから、同一filesystem上のrollback可能なtransactionとして一式を更新します。更新前にHost Daemonを停止してください。Windowsでは一時helperへhandoffし、CLI process終了後にlocked executableを入れ替えます。

ローカルbuild：

```bash
bun run release:host:build --version 1.0.0 --platform darwin-arm64
POCKET_OMP_BIN_DIR=dist/host-release/darwin-arm64 \
  dist/host-release/darwin-arm64/pocket-omp-darwin-arm64 doctor
```

## API

- `POST /v1/relay/publish` — protobuf batch。複数recipientはrecipientごとにfan-outし、item単位で結果を返す
- `POST /v1/relay/ack` — protobuf acknowledgement
- `PUT|POST /v1/relay/snapshot` — encrypted snapshot。payloadはR2、metadataはDurable Object SQLiteへ保存
- `GET /v1/relay/subscribe` — Hibernation WebSocket。binary `RelayFrame`を返す
- `PUT /v1/control/push-registration` — Expo push token登録
- `GET /api/diagnostics?account_id=...&grant_id=...` — 旧Admin診断UI互換API
- `POST /v1/admin/account-diagnostics` — protobuf Admin account診断
- `POST /v1/admin/delivery-metadata` — protobuf Relay metadata診断
- `POST /v1/admin/revoke-device` — protobuf端末revoke。step-up必須
- `POST /v1/admin/force-entitlement-reconciliation` — protobuf再同期job作成。step-up必須
- `POST /v1/review/sessions` — App Review session作成
- `POST /v1/review/sessions/:id/approval` — App Review approval

HTTP APIは`Authorization: Bearer <relay-ticket>`を使用します。WebSocketは`pocket-omp-relay`と`pocket-omp-ticket.<relay-ticket>`のsubprotocolを指定します。

Admin APIは`Authorization: Bearer <staff-jwt>`またはCloudflare Accessの`Cf-Access-Jwt-Assertion`、account単位の期限付きgrant、`roles` claim、書き込み時の5分以内を示す`step_up_at` claimを要求します。Admin UIは`apps/admin/public`からWorkers Static Assetsとして配信されます。
