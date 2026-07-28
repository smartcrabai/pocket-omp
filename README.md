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

`main`へのpushはproduction Workerをデプロイします。Review Workerは`Deploy Workers` workflowを手動実行し、`review`を選択してデプロイします。

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
