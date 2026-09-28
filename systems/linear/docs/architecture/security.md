# Security: Linear

信頼境界、脅威モデル（部品ごとの STRIDE）、端末に残るデータ（IndexedDB、Electron）、暗号化、監査ログ、秘密情報、運用者のアクセス、データのライフサイクル（アーカイブ・削除・解約・保持）、セキュリティの試験、脆弱性の管理、インシデント、法務の論点を決める。権限の関数と同期グループは [permissions-and-teams.md](permissions-and-teams.md)、ログインとセッションは [accounts-and-auth.md](accounts-and-auth.md)、連携の資格情報は [integrations.md](integrations.md)、公開 API のトークンと Webhook は [api-and-webhooks.md](api-and-webhooks.md) にある。

| 関連 | 決定 |
| --- | --- |
| [ADR-0004](../decisions/0004-tenancy-and-permissions.md) | ワークスペースを FORCE RLS で分け、非公開のチームを同期グループで配る前に絞る |
| [ADR-0005](../decisions/0005-client-persistence-and-offline.md) | 手元の保存と outbox。ログアウトでそのアカウントの DB を消す |
| [ADR-0032](../decisions/0032-single-policy-module-and-group-mapping.md) | 権限を 1 つの関数にまとめる |
| [ADR-0035](../decisions/0035-sessions-and-sync-ticket.md) | セッションと同期のチケット |
| [ADR-0040](../decisions/0040-integration-installations-and-credential-storage.md)、[ADR-0042](../decisions/0042-api-keys-oauth-apps-and-token-format.md) | 連携の秘密、トークンの形 |
| [0046](../decisions/0046-device-data-no-app-encryption-and-remote-wipe.md) | 手元の DB はアプリの層で暗号化せず、OS のディスクの暗号化に任せる。共有の端末には「この端末に保存しない」の入り方を用意する。ログアウト・除外・遠隔の消去の指示で手元を消し、Electron のクラッシュの記録を外へ送らない |
| [0047](../decisions/0047-audit-log.md) | 監査ログは、ワークスペースの監査（Aurora の表、1 年）とプラットフォームの監査に分け、どちらも log-archive へハッシュの連鎖つきで写す。同期のログ（`sync_actions`）を監査ログの代わりにしない |
| [0048](../decisions/0048-data-lifecycle-and-workspace-deletion.md) | 保持の期間を 1 つの表で持ち、時間で消える表はパーティションで落とす。ワークスペースの削除は 30 日の猶予の後に、Aurora・OpenSearch・S3 から `workspace_id` で消し、バックアップは 35 日で消える。アカウントの削除は、ワークスペースの中の人を仮名にし、書いた中身は残す |

## 1. 目標と前提

- **OWASP ASVS 5.0 の Level 2 を目標にする**（他の題材と同じ）。要件の番号との照合は E1 で行う。
- 最も重い障害は 4 つ。
  1. **非公開のチームのデータが、見てよくないクライアントに届く**（NFR-008）。画面に出なくても、IndexedDB に残れば漏えいである（[architecture/README.md](README.md) の 6 節）。
  2. **ワークスペースをまたいだデータの漏えい**（NFR-008）。
  3. **端末に残ったデータの漏えい**：共有の端末、紛失した端末、除外された人の端末。
  4. **配布の経路の乗っ取り**：Web の資産、Electron の自動更新。全利用者の端末でコードが動く。
- 実行基盤・CI/CD・監視の統制は、他の題材の決定（Slack・Stripe・Auth0 の security.md）を引き継ぎ、この題材に固有の部分だけを書く。
- **AI エージェント（コーディング・運用）は、本番に一切の経路を持たない**（他の題材と同じ）。

## 2. 信頼境界

```
  ┌──────────────────────── インターネット（信頼しない）────────────────────────────────┐
  │ 利用者のブラウザ・Electron  公開 API の利用者・OAuth のアプリ  GitHub・GitLab・Slack  攻撃者 │
  └────┬───────────────────────────┬───────────────────────────────┬─────────────────────┘
       │ <brand>.<domain>（画面、Sync API、WSS）│ api.<brand>.<domain>            │ /hooks/*
  ═════╪═ B1: エッジ（CloudFront＋WAF）══════╪═══════════════════════════════╪═══════════
  ┌────▼─── prod（東京・大阪）────────────────▼───────────────────────────────▼───────────┐
  │  auth  sync-api  gateway ─▶ writer ◀─ public-api（GraphQL・OAuth・受け口）               │
  │   ══ B2: ワークスペースのコンテキスト（SET LOCAL app.workspace_id、FORCE RLS）══         │
  │   ══ B3: 同期グループ（groupsFor → 差分・ブートストラップ・検索・API・Webhook を絞る）══ │
  │  Aurora  Valkey  OpenSearch  SQS  S3（添付・段置き・書き出し）                            │
  │  worker ──▶ worker-egress ── B5 ──▶ Webhook の宛先、自前の GitLab、インポートの元        │
  └──────────────────────────────────────────────────────────────────────────────────────┘
  ═══ B4: 管理プレーン ═══ CI/CD（OIDC）、配布（Web の資産、Electron の署名と更新の配信）、運用者（JIT）
  ═══ B6: 端末 ═══ IndexedDB・Service Worker のキャッシュ・Electron のデータの場所（利用者の端末。本システムの管理の外）
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求、WebSocket | TLS 1.2 以上、HSTS、WAF、Shield Standard。オリジンは CloudFront からだけ（[infrastructure.md](infrastructure.md) の 2 節） |
| B2 ワークスペース | サービスから DB | `SET LOCAL app.workspace_id`、FORCE RLS（ADR-0004）。ワークスペースをまたぐ処理は `platform` のロールだけ |
| B3 同期グループ | 行からクライアント・API・Webhook・検索・通知・書き出し | `packages/policy` の `groupsFor`・`can()` だけで絞る（ADR-0032）。配信の監査 |
| B4 管理プレーン | デプロイ、配布、運用者の操作 | OIDC の短命な認証情報、2 人の承認、署名（Electron のコード署名と公証）、JIT |
| B5 外向きの送信 | 顧客の指定する宛先 | egress の専用の経路、名前解決の後の IP の検査、リダイレクトを追わない |
| B6 端末 | 手元の DB、キャッシュ | 見てよいデータだけを配る（B3）、ログアウト・除外・遠隔の消去で消す（4 節） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。

### 3.1 クライアント（ブラウザ・Electron）

| # | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| C1 | I・E | XSS：利用者の書いた本文・コメント・タイトルから、他の人の手元の DB を読む・変更を送る | React の文字として描く、エディタのスキーマを通した描画だけ、CSP（`script-src 'self'`、Trusted Types）（[client-app.md](client-app.md) の 14 節）。XSS はその人の見てよいデータに限られる（B3）が、outbox へ書けるので、全部の操作ができる。最重要の試験の対象にする |
| C2 | I | 添付の HTML・SVG が本体のドメインで動く | 別のドメイン（`<brand>usercontent.<domain>`）、`Content-Security-Policy: sandbox`、`nosniff`（[editor-and-descriptions.md](editor-and-descriptions.md) の 8.3 節） |
| C3 | E | Electron のレンダラーから Node.js を使う | `contextIsolation`・`sandbox`・`nodeIntegration: false`、preload の API の最小、IPC の送り手の確かめ、fuses（[client-app.md](client-app.md) の 11 節） |
| C4 | S | ディープリンクの横取りでログインのコードを奪う | PKCE の形の交換（[accounts-and-auth.md](accounts-and-auth.md) の 6.5 節） |
| C5 | I | 共有の端末・紛失の端末の手元の DB | 4 節 |
| C6 | T | 手元の DB を書き換えて、見てよくない変更を送る | すべての変更を Writer で検証する。クライアントの `can()` は画面のためだけ（[sync-engine.md](sync-engine.md) の 11 節） |
| C7 | I | RUM・エラーの報告・クラッシュの記録に中身が入る | 数と ID だけ（[observability.md](observability.md) の 2 節）。Electron のミニダンプを送らない（4.4 節） |

### 3.2 エッジと Gateway・Sync API

| # | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| G1 | S | WebSocket の乗っ取り（CSWSH） | `Origin` の確かめ、60 秒・1 回限りのチケットを最初のメッセージで（URL に入れない）（ADR-0009） |
| G2 | I | 差分・ブートストラップ・遅延の読み込みで、購読の外の行を送る | 絞り込みの関数を 1 つにし、Gateway・Sync API・シミュレーターで同じコード。配信の監査（[observability.md](observability.md) の 5 節）。PROP-SYNC-004、PROP-PERM-002 |
| G3 | I | 脱退の後も、手元に行が残る | 1 つの IndexedDB のトランザクションでの消去（ADR-0013）。本番の抜き取りで `_g` が購読の部分集合であることを見る |
| G4 | D | 再接続の殺到、ブートストラップの殺到 | 乱数の待ち、`retry_after_ms`、受け付けの上限（[capacity.md](capacity.md)） |
| G5 | D | 1 つのクライアントの暴走（拒否の繰り返し、巨大なフレーム） | 1 分 100 回の拒否で `kick`、1 フレーム 1 MiB、送信の流量（[sync-engine.md](sync-engine.md) の 9.6 節） |
| G6 | S | 停止・取り消しの後も接続が残る | Valkey の知らせで 5 秒以内に切る、5 分ごとの確かめ（ADR-0035） |

### 3.3 Writer

| # | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| W1 | E | 権限の判定の抜け（移動の後のチームでの判定、参照先の判定） | 検証の決定表（[sync-engine.md](sync-engine.md) の 5.3 節）、移動は前後の両方で `can()`、参照先の「見てよくない」を `invalid_reference` |
| W2 | T | `origin = import`・`worker` の例外の悪用 | 例外は Writer の中の表（DT-IMPORT-002）に限り、`origin` は内部の呼び出し元（サービスのロール）で決める。Gateway から来た要求は `client` に固定する |
| W3 | D | 1 ワークスペースへの書き込みの集中 | 書き込みの割り当て（[ADR-0054](../decisions/0054-per-workspace-write-admission.md)） |
| W4 | R | 誰が変えたか分からない | `sync_actions.actor_id`・`origin`、`IssueHistory`、監査ログ（6 節） |

### 3.4 Public API・OAuth・Webhook・連携

| # | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| A1 | S | 漏れた API キー・トークン | 接頭辞とチェックサム、シークレットスキャン、ハッシュの保存、期限、入れ替えと再利用の検出（ADR-0042） |
| A2 | E | 範囲を超えた操作 | `can() ∧ 範囲 ∧ チーム`（[api-and-webhooks.md](api-and-webhooks.md) の 3.5 節） |
| A3 | I | Webhook で非公開のチームの変更が外へ | 作成の規則、作った管理者の今の権限で送る時に絞る（ADR-0043） |
| A4 | S・E | SSRF（Webhook、自前の GitLab、インポートの元） | egress の経路、宛先の検査（ADR-0040、ADR-0043） |
| A5 | S | 偽の GitHub・Slack の事象 | 署名と時刻と重複の確かめ（ADR-0038、ADR-0039） |
| A6 | E | PR のタイトルで非公開のチームのイシューを動かす | DT-INT-003（ADR-0038） |
| A7 | D | 複雑な GraphQL の問い合わせ | 実行の前の複雑さの計算、枠（ADR-0041） |

### 3.5 データの置き場所と Worker

| # | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| D1 | I | RLS の外し忘れ、ワークスペースの条件のない問い合わせ | マイグレーションの CI（新しい表の `workspace_id` と FORCE RLS）、RLS の外の表の許可リスト（[data-model.md](data-model.md) の 5 節） |
| D2 | I | OpenSearch（RLS の外）での漏れ | 検索の関数で必ず `workspace_id` と `groups` を付け、結果を読み直す（ADR-0031） |
| D3 | I | 添付の署名付きの URL の漏れ | 5 分、画面で毎回取り直す、ログに書かない |
| D4 | I | バックアップ・段置き・書き出しのファイルの漏れ | KMS、非公開のバケット、期限（9 節） |
| D5 | T | `sync_epoch` を上げずに DB を戻す | 手順で禁止（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。戻しのワークフローが必ず上げる（ADR-0050） |

### 3.6 CI/CD と配布

| # | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| P1 | T | Web の資産のすり替え（S3・CloudFront） | 資産のバケットへの書き込みは CI のロールだけ、ハッシュ付きの名前、`index.html` の SRI は同じオリジンなので使わない（CSP の `'self'` で足りる） |
| P2 | T | Electron の更新の配信のすり替え | macOS は署名と公証、Windows はコード署名。Squirrel は配布物の署名を確かめる（macOS は必須。[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、2026-09-28 に確認）。更新の案内（フィード）を返す入口は TLS で、署名の鍵は HSM（クラウドの署名の仕組み）に置く（[delivery.md](delivery.md) の 6 節） |
| P3 | T | 依存の乗っ取り（npm） | lockfile、`npm audit`、新しい版の取り込みの遅延（公開から 7 日）、SBOM |
| P4 | E | AI エージェントが本番に触れる | 本番の資格情報を開発環境に置かない（他の題材と同じ） |

## 4. 端末に残るデータ

ADR-0046。

### 4.1 何が残るか

| 置き場所 | 中身 | 消える時 |
| --- | --- | --- |
| IndexedDB（ワークスペースの DB） | 見てよいモデルの行、outbox（未送信の変更の中身）、拒否の記録、オフラインの添付 | ログアウト、除外、遠隔の消去、やり直し（モデルだけ）、ブラウザの消去 |
| IndexedDB（登録） | DB の一覧（アカウントとワークスペースの ID、件数） | 最後の DB を消した時 |
| Service Worker のキャッシュ | アプリの殻だけ（データなし） | 版の更新 |
| `localStorage` | 最後に開いたビュー（ID）、一覧とボードの別、パネルの幅 | ログアウト |
| HTTP のキャッシュ | 添付の画像（`private, max-age=300`） | ブラウザの規則 |
| クッキー | セッション、端末の ID（`<brand>_cid`） | ログアウト（セッション）。端末の ID は残す（[client-store-and-offline.md](client-store-and-offline.md) の 9.3 節） |
| OS の通知の履歴 | 通知の文面（`desktop_content = full` なら識別子とタイトル） | OS の規則 |
| Electron のデータの場所（`userData`） | 上の IndexedDB・キャッシュ・クッキーと同じもの（Electron のセッションの区画） | 同上。アンインストールで消えるかは OS とインストーラーによる（**未検証**。E6 の `electron-shell` で確かめる） |

### 4.2 暗号化しない理由

- 手元の DB を、アプリの層の鍵で暗号化しない。
  - ブラウザでは、鍵を同じ端末（IndexedDB の `CryptoKey` か、サーバーから毎回受ける鍵）に置くしかない。同じ端末の鍵では、ディスクを読める攻撃者から守れない。サーバーから鍵を受ける形は、オフラインで起動できなくなる（NFR-003・004 と合わない）。
  - Electron の `safeStorage` は、macOS では同じ利用者の他のアプリからも守るが、Windows（DPAPI）では同じ利用者の他のアプリから守らない。Linux は秘密の保管がなければ守らない（[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、2026-09-28 に確認）。IndexedDB の全体を包む仕組みも Chromium にない、と見ている（**未検証**。E3 の `idb-layout` で調べる）。
  - XSS（C1）には、どの暗号化も効かない（アプリ自身が復号する）。
- 代わりに、端末の紛失・盗難には **OS のディスクの暗号化**（FileVault、BitLocker）を前提にし、利用の条件と管理者向けの案内に書く。MDM で確かめる機能は MVP の後。

### 4.3 消す

| 契機 | 消すもの | 手順 |
| --- | --- | --- |
| この端末からログアウト（既定） | そのアカウントの全部のワークスペースの DB、`localStorage`、セッション | 未送信があれば件数を示して確かめる（ADR-0005、[accounts-and-auth.md](accounts-and-auth.md) の 6.6 節） |
| ワークスペースからの除外・停止 | そのワークスペースの DB（outbox ごと） | `kick: forbidden`・チケットの `403`・`404` で（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.6 節） |
| 遠隔の消去（新規） | そのセッションのアカウントの全部の DB | 本人か管理者が、セッションの一覧から「この端末のデータを消す」を選ぶ。セッションに `wipe_requested` を立てて取り消す。端末が次にチケットを求めると `401 wipe_required` を受け、未送信を確かめずに消してからログインの画面を出す |
| 共有の端末の入り方 | — | 4.5 節 |
| アカウントの削除 | 全部 | 全部のセッションに `wipe_requested` |

- 遠隔の消去は、端末がつながった時にしか効かない。つながらない端末（紛失したまま電源が入らない）は、OS のディスクの暗号化に頼る。
- 「全部の端末からログアウト」は、他の端末の DB を消さない（outbox を守るため。[accounts-and-auth.md](accounts-and-auth.md) の 6.6 節）。消したい時は遠隔の消去を選ぶ。画面で違いを説明する。
- 遠隔の消去で失われる未送信の変更は、本人に「端末で失った件数」として示す（`client_devices` の最後の報告。[client-store-and-offline.md](client-store-and-offline.md) の 9.3 節）。

### 4.4 Electron のクラッシュの記録

- `crashReporter` のミニダンプ（メモリーの中身を含みうる）を外へ送らない（`uploadToServer: false`）。
- JavaScript のエラーの報告は、自前の収集の口へ、スタックと Action の ID と版だけを送る（[observability.md](observability.md) の 2 節）。

### 4.5 共有の端末

- ログインの画面に「この端末に保存しない」を置く。選ぶと、ワークスペースの DB をメモリーの中だけ（IndexedDB を使わない）で持ち、タブ・窓を閉じると消える。オフラインでは使えず、outbox もメモリーだけなので、閉じる時に未送信があれば確かめる。
- Web だけに置く（Electron は個人の端末の前提）。
- この入り方は、ブートストラップを毎回行う。大きなワークスペースでは起動が遅い（NFR-003 の対象外）。

## 5. 暗号化

### 5.1 転送中

- 外部：TLS 1.2 以上（CloudFront のセキュリティのポリシー）、HSTS（`includeSubDomains`、`preload` は GA の後）。WebSocket も WSS だけ。
- 内部：ALB → タスクは TLS。Writer への内部の HTTP/2 は TLS（ECS Service Connect の TLS）。Aurora・Valkey・OpenSearch は TLS を必須にする。

### 5.2 保存時

| 対象 | 鍵 |
| --- | --- |
| Aurora、スナップショット、Global Database の二次 | KMS の `<brand>-data`（マルチリージョンの鍵） |
| S3（添付、段置き、書き出し、バックアップ） | SSE-KMS（`<brand>-data`）。書き出しは `<brand>-exports` |
| OpenSearch | 保存時の暗号化とノードの間の暗号化を有効（`<brand>-data`） |
| Valkey | 保存時と転送中の暗号化を有効 |
| 連携の秘密、Webhook の秘密、インポートの認証 | 共通の包みの部品 `packages/envelope`（AES-256-GCM、AAD、DEK を KMS で包む）。鍵は用途ごと（`<brand>-integration-secrets`、`<brand>-webhook-secrets`、`<brand>-import-secrets`） |
| log-archive | SSE-KMS（log-archive のアカウントの鍵）、Object Lock |

- 鍵の削除の予約・無効化は SCP で break-glass のロール以外に禁止する（他の題材と同じ）。

## 6. 監査ログ

ADR-0047。

| 系統 | 記録するもの | 置き場所 |
| --- | --- | --- |
| ワークスペースの監査（`audit_events`） | ログインの手段の制限の変更、メンバーの招待・停止・ロールの変更、チームの作成・削除・公開の切り替え、管理者の非公開のチームへの参加（`admin_joined_private_team`）、API キー・OAuth のアプリ・Webhook・連携の作成・取り消し、書き出し、インポートとその取り消し、遠隔の消去、ワークスペースの削除の依頼と取り消し | Aurora（ワークスペースの表、RLS）→ log-archive |
| プラットフォームの監査（`platform_audit_events`） | 運用者の本番へのアクセス、サポートの参照（8 節）、`sync_epoch` を上げた操作、DR での権限を狭める操作のやり直し（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)）、ワークスペースの PITR での戻し、リーガルホールド、ワークスペースの停止、break-glass | 同上（RLS の外。[data-model.md](data-model.md) の 5 節） |
| AWS の操作 | CloudTrail（組織の証跡） | log-archive |
| 認証のイベント | ログインの成功・失敗、セッションの取り消し（[accounts-and-auth.md](accounts-and-auth.md)） | `audit_events` の `auth.*` の種類 |

- 1 行は `{id, workspace_id, at, actor{kind, id}, action, target{kind, id}, ip, user_agent_hash, detail}`。`detail` にタイトル・本文などの中身を入れない（ID と変更のフィールドの名前だけ）。
- **同期のログ（`sync_actions`）を監査ログの代わりにしない。** `sync_actions` は 30 日で消え、`sync_epoch` を上げると番号の意味が変わる。監査の対象の操作は、Writer が同じ DB のトランザクションで `audit_events` にも書く。
- log-archive へは 1 時間ごとに写し、ワークスペースごとのハッシュの連鎖（前の行のハッシュを含める）を付ける。
- 監査ログの画面（オーナーが見る、書き出す）は MVP の後（Enterprise。intent）。記録は MVP から取る。

## 7. 秘密情報の管理

| 秘密情報 | 保存 | 入れ替え |
| --- | --- | --- |
| セッションのトークン | Better Auth の `session`（ハッシュの有無は部品の既定。文書に書かれていない。**未検証**。E4 の `auth-service-skeleton` で確かめる） | 30 日の不使用で失効 |
| 同期のチケット | Valkey に SHA-256（60 秒） | 1 回限り |
| API キー、OAuth のトークン・クライアントの秘密 | SHA-256（ADR-0042） | 期限、入れ替え |
| Webhook の秘密、連携のトークン、インポートの認証 | 暗号文（5.2 節） | 利用者・管理者の操作、Slack は 12 時間 |
| GitHub App の秘密鍵、Slack の署名の秘密、メールの送信事業者の鍵、DB の認証情報 | Secrets Manager | GitHub App の鍵は年 1 回と漏えいの疑いで。DB は自動のローテーション |
| 添付のアップロードの `upload_ref` の HMAC の鍵 | Secrets Manager | 90 日。新旧の 2 つを受ける |
| CloudFront の署名付きの URL の鍵（添付） | Secrets Manager（秘密鍵）、CloudFront の鍵グループ（公開鍵） | 90 日。新旧の 2 つを鍵グループに置く |
| CloudFront → ALB の秘密のヘッダー | Secrets Manager | 90 日 |
| Electron・Windows・macOS のコード署名の鍵 | クラウドの HSM（delivery の領域で選ぶ） | 証明書の期限 |

- 本システムのトークンの接頭辞（`<brand>_api_` など）は、GitHub のシークレットスキャンのパートナープログラムに登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 8. 社内の運用者のアクセス

- 常設の権限は、ダッシュボード・メトリクス・中身を含まないログだけ。DB・シェル・KMS の管理は期限つき（最長 4 時間）で、プラットフォームの監査に残す（他の題材と同じ）。
- **ワークスペースの中身の参照**（サポート）は、ワークスペースのオーナーが期限つき（最長 7 日）で許した時だけ行う。許しは `workspace_support_grants` に持ち、参照は読み取りの専用のロールで、プラットフォームの監査とワークスペースの監査の両方に残す。非公開のチームは、許しの中で明示したものだけ。
- なりすまし（運用者が利用者として同期につなぐ）の機能を作らない。
- インシデントの対応の例外（許しなしの参照）は、Ops の責任者とセキュリティの担当の 2 人の承認で、事後にオーナーへ知らせる。契約での約束は法務の L7。

## 9. データのライフサイクル

ADR-0048。**期間はすべて既定案で、法務の確認（L5・L7）で確定する。**

| データ | 保持（既定案） | 期限後 |
| --- | --- | --- |
| イシュー・コメント・プロジェクトなどのモデル | ワークスペースが消すまで。アーカイブは期限なし | ゴミ箱の 30 日の後に物理削除（[issues-and-workflow.md](issues-and-workflow.md) の 4.5 節） |
| 本文の版（`issue_description_versions`） | イシューがある間 | イシューと一緒に。管理者の「版を消す」（消した秘密の対策。[editor-and-descriptions.md](editor-and-descriptions.md) の 11 節の依頼）は MVP で持つ |
| `IssueHistory` | イシューがある間 | イシューと一緒に |
| 添付の中身（S3） | 行がある間 | 行の削除から 30 日 |
| `sync_actions` | 30 日（ADR-0013） | パーティションを落とす |
| `tx_results` | 90 日 | 同上 |
| 通知 | 通知の領域の決定（[notifications-and-inbox.md](notifications-and-inbox.md)） | 同左 |
| `integration_events` | 30 日 | パーティションを落とす |
| `webhook_deliveries` | 14 日（本文は 72 時間） | 同上 |
| インポートの段置き、認証 | 段置き 30 日、認証はジョブの後 | S3 のライフサイクル、行の削除 |
| 書き出しのファイル | 24 時間 | S3 のライフサイクル |
| ワークスペースの監査 | DB に 1 年、log-archive に 3 年 | 削除 |
| プラットフォームの監査 | log-archive に 5 年 | 削除 |
| アプリのログ | CloudWatch Logs 30 日、log-archive 13 か月（中身を含めない） | 自動 |
| RUM の集計 | 13 か月（集計の値だけ） | 自動 |
| `client_devices` | 最後の報告から 180 日 | 削除 |
| `notification_keys` | 30 日 | パーティションを落とす |
| `notification_deliveries`（送り終えた行） | 30 日 | 削除（[data-model/views-and-notifications.md](data-model/views-and-notifications.md)。2026-09-28 に足した） |
| `attachment_purges`（消した添付の S3 の鍵の台帳） | 中身を消すまで（削除から 30 日） | 削除（[data-model/issues.md](data-model/issues.md)。2026-09-28 に足した） |
| `convergence_audits`・`convergence_mismatches` | 90 日・1 年（中身を含めない） | パーティションを落とす・削除 |
| `narrowing_outbox`、DynamoDB の `narrowing_journal` | 送った行は 7 日、記録は 35 日（バックアップと同じ。ID と列挙の値だけで中身を含めない） | 削除、TTL |
| 配信の監査の抜き取り（S3） | 90 日 | S3 のライフサイクル |
| セッション | Better Auth の既定（切れてからの残り方は E4 で確かめる） | — |
| ワークスペース | 削除の依頼から 30 日（戻せる） | 9.1 節 |
| バックアップ | 35 日 | 期限で消える（削除の最終の期限） |

- **時間で消える表は、日ごとのパーティションで持ち、`DROP` で消す**（`sync_actions`・`tx_results`・`integration_events`・`webhook_deliveries`・`audit_events` の DB の部分・`convergence_audits`・`notification_keys`）。
- **リーガルホールド**（`legal_holds`）は保持の期限に優先する。ワークスペースの削除も止める。

### 9.1 ワークスペースの削除

```
 オーナー：削除を依頼（最近のログイン。ADR-0035 の freshAge）
   ▼ Writer：workspace.status = pending_deletion、全員のチケットを 403 に、全接続に kick: forbidden
   │ 30 日：オーナーは戻せる（戻すと sync_epoch は変えない。データは残っている）
   ▼ 30 日後：削除のジョブ（platform のロール）
   1. Valkey の鍵、SQS の予定を捨てる
   2. OpenSearch：workspace_id での削除の問い合わせ（search の領域）
   3. S3：ws/<workspace_id>/ の接頭辞を消す（添付、段置き、書き出し）
   4. Aurora：モデルの表・ログの表から workspace_id の行を 1 万行ずつ消す（パーティションの表は行を消す）
   5. 連携：GitHub App のインストールの解除の案内、Slack の `auth.revoke`、Webhook の停止
   6. プラットフォームの監査に「削除の完了」を残す（ワークスペースの名前は残さない。ID だけ）
   ▼ バックアップは 35 日で期限が切れ、最終の削除になる
```

- 端末の DB は、次にチケットを求めた時に `404` で消える（[accounts-and-auth.md](accounts-and-auth.md) の 6.3 節）。つながらない端末には残る（4.3 節と同じ限界）。
- 解約（請求の停止）と削除は別にする。解約の後のデータの扱い（何日で削除に移るか）は法務の L5・L7 と契約で決める。

### 9.2 アカウントの削除と、人の削除の求め

- アカウント（Better Auth の `user`）を消すと、各ワークスペースの `User` を仮名にする：`name`・`display_name` を「削除された利用者」、`email` と `avatar_url` を空、`status = suspended`。ID は残し、履歴・担当・コメントの書き手は、仮名の人を指したままにする。
- その人の書いたコメント・本文は、ワークスペースのデータとして残す（ワークスペースの持ち主の判断で消す）。本人からの削除の求めに、ワークスペースの中身まで含めるかは法務の L7（委託の扱い）で決める（[accounts-and-auth.md](accounts-and-auth.md) の 4.3 節）。
- 外部のアカウントの結び付け、API キー、OAuth の認可、セッションは消す。

## 10. セキュリティの試験

| 種類 | 対象 | 頻度 | 合否 |
| --- | --- | --- | --- |
| SAST、シークレットスキャン、依存・イメージ・IaC の検査 | 全体 | PR、毎日 | High 以上 0 件（他の題材と同じ） |
| 同期グループの性質ベーステスト | PROP-SYNC-004、PROP-BOOT-002、PROP-PERM-002、PROP-SEARCH-002、PROP-API-001、PROP-HOOK-001、PROP-EXPORT-001、PROP-INT-002・003、PROP-NOTIF-002 | PR（同期・権限・該当の領域に触れる PR は夜間と同じ回数） | 全件の成功（NFR-008） |
| RLS の検査 | マイグレーション | PR | 新しい表の `workspace_id` と FORCE RLS、RLS の外の表の許可リストとの一致 |
| XSS の試験 | エディタ、コメント、タイトル、ラベルの名前、Slack・GitHub から来た文字 | PR（例の集まり）、夜間（ファジング） | 実行 0 件 |
| Electron の設定の検査 | 配布物 | 配布ごと | `webPreferences` と fuses の値（[client-app.md](client-app.md) の 15 節） |
| 手元の消去の試験 | ログアウト、除外、遠隔の消去、脱退 | PR（該当の領域） | 消去の後に IndexedDB・`localStorage` に該当のワークスペースの行が 0 |
| DAST | staging の画面・Sync API・公開 API・OAuth | 夜間とリリース前 | High 以上 0 件 |
| 外部のペンテスト | 同期（Gateway・Sync API の絞り込み）、非公開のチームの経路の全部、公開 API・OAuth・Webhook、Electron、添付の配り | E12、その後は年 1 回と大きな変更の後 | Critical・High がすべて修正済み |

- 脆弱性の報告の窓口（`security.txt`）を公開の時点で置く。

## 11. 脆弱性の管理

他の題材の期限（Critical：緩和 24 時間・修正 7 日、High：30 日）を使う。加えて次のとおり。

- **非公開のチーム・ワークスペースをまたぐ漏えい、他人としての書き込み、配布の経路の乗っ取りにつながる脆弱性は、CVSS にかかわらず Critical** とする。
- **Electron（Chromium）**：Chromium の High 以上の修正を含む Electron の patch は 7 日以内に配る。メジャーは 8 週以内（[client-app.md](client-app.md) の 11 節）。
- **認証の部品（Better Auth）**：High 以上の告知は 7 日以内（[accounts-and-auth.md](accounts-and-auth.md) の 3.4 節）。
- **Yjs・ProseMirror**：本文の解析の脆弱性は、サーバーの `packages/doc` にも及ぶので、サーバーとクライアントを同じ日に上げる。

## 12. インシデントへの対応

- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md)。非公開のチームの漏えいの疑い、収束の不一致、端末の保存の消去、伝播の遅れの場面を持つ。
- **個人データの漏えい等のおそれ**のとき、個人情報保護委員会への報告と本人への通知の要否、報告の主体（顧客か本システムか）は法務が判断する（13 節の L1）。他の題材で確かめた期限の目安は、速報が概ね 3〜5 日以内、確報が 30 日以内（不正の目的によるものは 60 日以内）（Stripe の [security.md](../../../stripe/docs/architecture/security.md) の 12 節）。
- 非公開のチームのデータがクライアントに届いた場合、**その端末の IndexedDB に残っていることを前提に扱う**。消去の指示（`kick: forbidden` と握手の `groups`）が届いたかを、端末の ID ごとに確かめる（runbook）。

## 13. 法務の論点（法務の確認待ち）

**結論は出さない。** 設計は、どの結論にも対応できる形にする。下の表の「止まるもの」は、確認が済むまで PM・QA が承認しない。全体の一覧は [intent.md](../intent.md) の「法務の確認待ち」にある。

| # | 論点 | この領域の設計への影響 | 止まるもの |
| --- | --- | --- | --- |
| L1 | ワークスペースのデータを顧客からの委託として扱うか。外国にある第三者への提供（GitHub・GitLab・Slack、メールの送信事業者、Webhook の宛先）。漏えい等の報告の義務を負う者と手順 | 12 節の報告の手順、インシデントの runbook の連絡先、[integrations.md](integrations.md) の 9 節 | E9 のメール、E10 の連携、E12 の GA の判定 |
| L2 | コメント・通知の媒介が電気通信事業に当たるか。RUM の外部送信規律の公表 | RUM を自前の収集の口にする（[observability.md](observability.md) の 3 節）。公表の文面 | E5 のコメント、E9 の通知の公開 |
| L3 | インポートの他社の規約、取り込んだ個人データ | [import-export.md](import-export.md) の 9 節 | E11 のインポート |
| L4 | データの所在：バックアップ（大阪は国内）、CloudFront・WAF のログ（グローバルなサービス）、Electron の更新の配信、OS の通知の履歴、サポートの参照 | 4.1 節、[infrastructure.md](infrastructure.md) の 1 節 | E1 のリージョンの構成、E12 の契約の文書 |
| L5 | 保持の期間：`sync_actions`、履歴、削除・アーカイブしたデータ、解約したワークスペース、端末に残るデータ、監査ログ | 9 節の全部 | E3 のログの保持、E12 の GA の判定 |
| L6 | AI の機能（MVP の後） | — | AI の Epic |
| L7 | DPA、サブプロセッサーの一覧、SLA の文言、開示・削除の請求の窓口、本人の削除の求めの範囲（9.2 節）、サポートの参照（8 節）、バックアップからの削除の期限（35 日）の説明 | 8 節、9 節 | E12 の GA の判定 |
| L8 | 画面の見た目とショートカットを本家に寄せる範囲 | — | E6 の画面の Story |
| 新 | 端末の消去（遠隔の消去で未送信を失わせること）を、利用の条件にどう書くか | 4.3 節 | E12 の GA の判定 |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `kms-keys-and-envelope` | 5.2 節の鍵と `packages/envelope` |
| E1 | `rls-migration-guard` | RLS の検査と、RLS の外の表の許可リスト |
| E1 | `audit-log-table-and-archive` | 6 節の `audit_events`、log-archive への写しとハッシュの連鎖 |
| E1 | `csp-and-security-headers` | CSP、Trusted Types、HSTS、添付の別のドメイン（client-app・editor と共同） |
| E3 | `device-wipe-on-logout` | 4.3 節のログアウト・除外の消去の試験 |
| E4 | `remote-wipe` | 4.3 節の遠隔の消去、`401 wipe_required`（accounts-and-auth と共同） |
| E4 | `shared-device-mode` | 4.5 節の「この端末に保存しない」 |
| E6 | `electron-crash-reporting-off` | 4.4 節 |
| E12 | `workspace-deletion-job` | 9.1 節 |
| E12 | `account-deletion-pseudonymize` | 9.2 節 |
| E12 | `support-access-grants` | 8 節 |
| E12 | `retention-jobs` | 9 節の保持のジョブ（パーティションの落とし） |
| E12 | `external-pentest` | 10 節の外部のペンテスト |

## 15. 未解決の問い

- 手元の DB をアプリの層で暗号化するか。
- 共有の端末の扱い。紛失した端末の消し方。
- 監査ログを `sync_actions` から作るか、別に書くか。
- ワークスペースの削除の猶予とバックアップからの削除。
- アカウントの削除で、書いた中身を消すか。

### 決定

2026-09-28 の既定案。法務の確認と E12 で覆りうる。

- **手元の暗号化**：しない。OS のディスクの暗号化を前提にする（ADR-0046）。
- **共有の端末**：「この端末に保存しない」の入り方（Web）。遠隔の消去（ADR-0046）。
- **監査ログ**：`sync_actions` と別に、Writer が同じトランザクションで書く（ADR-0047）。
- **ワークスペースの削除**：30 日の猶予、バックアップは 35 日で消える（ADR-0048）。
- **アカウントの削除**：仮名にし、中身は残す（ADR-0048）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| ASVS 5.0 の要件の番号の照合 | E1 |
| Better Auth のセッションのトークンの保存の形（ハッシュか） | E4 の `auth-service-skeleton`（**未検証**。[Database](https://www.better-auth.com/docs/concepts/database) の表の説明に書かれていない） |
| Chromium に IndexedDB を包む仕組みがあるか | E3 の `idb-layout` で調べる（**未検証**）。あれば Electron だけ暗号化を見直す |
| Electron のアンインストールで `userData` が消えるか | E6 の `electron-shell` で OS ごとに確かめる（**未検証**） |
| MDM での端末の条件の確かめ、管理者の「端末に保存させない」の設定 | MVP の後（Enterprise） |
| 監査ログの画面、ログのストリーム | MVP の後（Enterprise） |
| 解約から削除までの日数 | 法務の L5・L7 |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- 10 節の同期グループの性質ベーステストの一覧を、NFR-008 の試験の集まりとして E12 まで毎回の CI で回す。
- 手元の消去の試験（ログアウト、除外、遠隔の消去、脱退）を E3・E4 のリリースの基準にする。
- 本番：遠隔の消去の指示から実際の消去までの時間（端末が戻るまで）、消去が届いていない端末の数。
- 本番：配信の監査の不一致 0 件（[observability.md](observability.md) の 5 節）。
- E12：外部のペンテストの Critical・High 0 件。

### runbooks

- `incident-response.md`（本工程で作る）：非公開のチームの漏えいの場面を含む。
- `lost-device.md`：端末の紛失の連絡を受けたときの遠隔の消去と、セッションの取り消し。
- `workspace-deletion.md`：削除のジョブの確かめ、失敗の続き、リーガルホールドの確かめ。
- `support-access.md`：サポートの参照の許しの確かめ方と、参照の手順。

### data-model（索引への追加の提案）

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| `audit_events`（ワークスペースの表、日ごとのパーティション） | ワークスペースの監査（1 年） | 6 |
| `platform_audit_events`（RLS の外） | プラットフォームの監査 | 6 |
| `legal_holds`（RLS の外） | ワークスペース単位の削除の停止 | 9 |
| `workspace_support_grants` | サポートの参照の許し | 8 |
| `workspaces.status` に `pending_deletion`、`deletion_requested_at` | 削除の猶予 | 9.1 |
| accounts-and-auth への依頼（反映済み） | セッションに `wipe_requested`、チケットの発行の決定表（DT-AUTH-002）に `401 wipe_required` の行（[accounts-and-auth.md](accounts-and-auth.md) の 6.3 節） | 4.3 |
| editor-and-descriptions への依頼（反映済み） | 本文の版を消す管理者の操作（[editor-and-descriptions.md](editor-and-descriptions.md) の 4.7 節） | 9 |
| S3 のバケットの一覧 | 添付、段置き、書き出し、log-archive の鍵と期限 | 5.2、9 |

## 出典

いずれも 2026-09-28 に確認。

- Electron, [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、[autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)
- 他の題材の security.md（Auth0、Stripe）の方針を引き継いだ箇所は、その文書の出典に従う。
