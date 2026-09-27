# Security: Figma

信頼境界、脅威モデル、認証とセッション、暗号化と鍵、監査ログ、データのライフサイクル、秘密情報とサプライチェーン、不正利用、法務の確認待ちの論点。

| ADR | 決定 |
| --- | --- |
| [0043](../decisions/0043-authentication-sessions-and-org-sso.md) | 認証とセッションは Slack の ADR-0012 を引き継ぎ、組織の SAML SSO はメンバーにだけかける。セッションの取り消しで、長く続く接続も切る。Document Server もチケットの署名を確かめる |
| [0044](../decisions/0044-encryption-keys-and-client-cache.md) | 保存時の暗号化はデータの種類ごとの KMS の鍵（マルチリージョン）。組織ごとの鍵は MVP で持たない。端末のキャッシュは暗号化せず、組織の方針で止められるようにする |
| [0045](../decisions/0045-audit-log-and-data-lifecycle.md) | 監査ログは操作と同じトランザクションで書き、改ざんできない保管へ送る。削除は東京と大阪の両方で行い、バックアップの期限を最終の期限にする |

前提となる決定：テナントの分離（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)）、判定関数と能力のチケット（[ADR-0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md)）、取り消し（[ADR-0031](../decisions/0031-org-acl-version-and-connection-revalidation.md)）、プラグインのサンドボックス（[ADR-0037](../decisions/0037-plugin-sandbox-quickjs-wasm.md)）、書き出しの分担（[ADR-0034](../decisions/0034-export-rendering-split.md)）。権限の漏れの経路の一覧は [permissions-and-sharing.md](permissions-and-sharing.md) の 11 節にある。ここでは重ねて書かない。

## 1. 目標と前提

- CDE のような特別な規制の範囲はない。Slack と同じく、OWASP ASVS 5.0 の Level 2 を目標にする（Slack の [security.md](../../../slack/docs/architecture/security.md) の 1 節）。
- 最も重い障害は 3 つ。
  1. **組織をまたぐ漏洩**、権限のない人へのファイルの中身（サムネイルを含む）の漏洩（NFR-010）。
  2. **確定した編集の損失・改ざん**（NFR-006）。
  3. **信頼できないファイルによる利用者の端末の侵害**（悪意のあるファイル・画像・フォント・SVG・プラグインで、他人のセッションを奪う）。
- **ファイルの中身を、ログ・トレース・メトリクス・エラーの報告に書かない。** ID と大きさだけを書く（[AGENTS.md](../../AGENTS.md)）。
- **AI エージェント（コーディング・運用）は、本番のデータに触れない。** Slack の security.md の 7.3 節と同じ。

## 2. 信頼境界

```
  ┌──────────────── インターネット（信頼しない）──────────────────────────────┐
  │ 利用者のブラウザ（エンジン＝WASM、UI の殻、プラグインのサンドボックス）   │
  │ リンクを知っている匿名の人   公開 API の利用者（MVP の後）   攻撃者       │
  └──┬───────────────┬───────────────┬──────────────────┬─────────────────────┘
     │ app.<brand>    │ mp.<brand>     │ api.<brand>       │ <brand>usercontent（assets・plugin-ui）
  ═══╪══ B1：エッジ（CloudFront＋WAF＋Shield）═══════════════════════════════════
     ▼               ▼               ▼                  ▼
  ┌── prod アカウント（VPC）───────────────────────────────────────────────────┐
  │ API・Realtime ── B2：テナント（SET LOCAL app.org_id、FORCE RLS）── Aurora  │
  │ Gateway ── B3：能力のチケット（署名・60 秒・1 回）── Document Server      │
  │ Document Server ── B4：フェンス（epoch）── Journal（DynamoDB）・S3         │
  │ Render Worker・file-read ── B5：ジョブの org_id・file_id（判定済み）      │
  │ asset-fetch・webhook-egress（VPC の外の Lambda）── B6：外部の URL         │
  └────────────────────────────────────────────────────────────────────────────┘
  ═══ B7：管理プレーン ═══ CI/CD（OIDC）、運用者（SSO＋MFA、break-glass）、log-archive
  ─ ─ B8：開発環境（AI コーディングエージェント）… 本番への経路なし ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求、WebSocket | TLS 1.2 以上（1.3 を優先）、HSTS、WAF（マネージドルール、IP ごとのレート制限）、Shield Standard |
| B2 テナント | API・Realtime・Worker から Aurora | `SET LOCAL app.org_id`、FORCE RLS（ADR-0005）。組織の外の人は、ファイルを持つ組織の文脈で読む |
| B3 チケット | ブラウザ → Gateway → Document Server | API が判定関数を通して発行した能力のチケット（ADR-0030）。Gateway は `jti` の使い回しを、Document Server は署名と `file_id`・`level` を確かめる（ADR-0043）。同じ持ち主への再接続は、Gateway の再開のトークン（60 秒・1 回だけ、`session_id`・`file_id`・`epoch` に束ねる）でも入れる。Document Server は、チケットで確かめた水準を超えさせない（[permissions-and-sharing.md](permissions-and-sharing.md) の 5.5 節） |
| B4 フェンス | Document Server → ジャーナル | Router の割り当ての `epoch` と、ジャーナルのフェンス（[ADR-0024](../decisions/0024-journal-items-and-fencing.md)、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)） |
| B5 ジョブ | API → SQS → Render Worker・file-read | ジョブを作るときに判定し、実行の直前にもう一度判定する（[permissions-and-sharing.md](permissions-and-sharing.md) の 11 節）。Worker は判定関数を持たない |
| B6 外部の URL | 画像の URL の取り込み、Webhook | VPC の外の権限のない Lambda、宛先の検査（[export-and-assets.md](export-and-assets.md) の 9 節、[api-and-webhooks.md](api-and-webhooks.md) の 6.4 節） |
| B7 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、Ops の承認、break-glass の役割、監査（6 節） |
| B8 開発環境 | コード（PR としてのみ） | 本番の認証情報とデータを置かない |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。

### 3.1 クライアントのエンジン（信頼できないファイルを読む）

共有のリンクで開いたファイルは、他人が作った入力である。エンジンは WASM の中で動くが、同じタブには利用者のセッションがある。

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T・E | 復号器の欠陥を突くファイル（巨大な長さ、深い入れ子）でメモリを壊し、WASM の外へ出る | Rust で書く（ADR-0001）。長さと数の上限を先に確かめる（[document-model.md](document-model.md) の 13 節）。復号器と検証器の fuzzing。`unsafe` は境界だけ |
| T・E | 悪意のある画像・フォント・SVG | Rust のデコーダーを Web Worker で動かす、画素数と時間の上限（[rendering-engine.md](rendering-engine.md) の 14 節）。SVG の `<script>`・`foreignObject`・外部の実体を無視する（[export-and-assets.md](export-and-assets.md) の 11 節） |
| D | 描くだけでタブが止まるファイル（巨大なぼかし、数百万の線分） | 値の上限と、1 フレーム 1 秒を超えたら安全な描画の状態へ（rendering-engine.md の 13 節） |
| I | 利用者の上げたバイト列（SVG・HTML）がアプリのオリジンで動く | 別の登録可能ドメイン `<brand>usercontent.<domain>` から配る、`nosniff`、`CSP: sandbox`（export-and-assets.md の 3 節） |
| I | ファイルの中身が、エラーの報告やメトリクスで外に出る | panic は場所と種類だけ、計測はヒストグラム（[ADR-0049](../decisions/0049-client-telemetry-without-content.md)） |
| I | アプリの画面への XSS（ノードの名前・コメント） | React のエスケープ、`dangerouslySetInnerHTML` の禁止の lint、厳しい CSP（`script-src` はハッシュと自分のオリジンだけ、`unsafe-eval` なし。WASM には `wasm-unsafe-eval` だけを許す） |
| T | 他人の端末のキャッシュを書き換える | IndexedDB のチャンクは中身のハッシュで名付け、読むときにハッシュを確かめる（[file-storage-and-history.md](file-storage-and-history.md) の 6.3 節） |

### 3.2 Gateway

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 盗んだ・使い回したチケットで接続する | 60 秒・1 回だけ、`jti` を Valkey に記録（ADR-0030）。チケットは URL に入れず、最初のメッセージで送る（[multiplayer.md](multiplayer.md) の 4.3 節） |
| S | 盗んだ・使い回した再開のトークンで、権限を外された後に入り直す | 60 秒・1 回だけ（`rid` を Valkey に記録）。`epoch` が今の割り当てと等しいこと、組織の `acl_version` が変わっていないこと（変わっていれば一括の判定に回す）、ログインのセッションが取り消されていないことを確かめる（permissions-and-sharing.md の 5.5 節） |
| S | 他のサイトのページから WebSocket を張る（CSWSH） | `Origin` の許可の一覧。Cookie では認証しない（チケットだけ） |
| D | 接続の大量の確立、巨大なフレーム、遅い読み手 | WAF の IP ごとの制限、フレームの上限（4 MiB＋64 KiB）、送信の待ちの上限 8 MiB か 5 秒、セッションの流量の上限（multiplayer.md の 4.6 節） |
| E | Gateway の欠陥で、閲覧の接続が書き込みになる | Document Server が、チケットの署名と `level` を自分でも確かめる（ADR-0043）。再開のトークンでの再接続は、同じ `epoch` で API のチケットで確かめた水準を上限にする。Gateway が伝えてよいのは、水準を下げることだけ |
| R | 誰が接続したか分からない | 接続の確立と切断を、`session_id`・`account_id`・`file_id`・IP で記録する（中身なし）。組織の監査ログには、1 時間に 1 回に間引いて書く（6 節） |

### 3.3 Document Server

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T | 不正な変更（循環、型の誤り、上限を超える値） | すべての変更をサーバーで検証する（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)、multiplayer.md の 6 節） |
| T | 二重の持ち主が、ジャーナルを 2 つの列に分ける | フェンスの `epoch`（ADR-0024）、割り当ての `epoch`（ADR-0047）。大阪への切り替えでは世代でキーを分ける（[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)） |
| S | VPC の中の他のサービスが、Gateway になりすます | セキュリティグループで Gateway と Router からだけ受ける。`open_session` にチケットを添え、Document Server が署名を確かめる |
| I | ファイルをまたぐメモリの取り違え | file actor は 1 つのファイルの `Doc` だけを持つ。ファイルの ID を型で区別する（`FileId` と `NodeId` を混ぜない） |
| D | 1 つのファイルがタスクのメモリ・CPU・ジャーナルを使い切る | メモリの受け入れ（[ADR-0051](../decisions/0051-document-server-memory-admission.md)）、書き込みの予算（[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)）、参加の上限 500 人（[ADR-0011](../decisions/0011-presence-and-fan-out.md)） |
| R | 誰がどの変更をしたか | ジャーナルの `session_opens` と各変更の `session_id`（[file-storage-and-history.md](file-storage-and-history.md) の 4.1 節）。版の履歴 |

### 3.4 API・Realtime

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | セッションの窃取 | `__Host-` の Cookie、`HttpOnly`・`Secure`・`SameSite=Lax`。重要な操作（組織の削除、SSO の設定、所有者の移転）は再認証（ADR-0043） |
| T | CSRF | `SameSite=Lax` に加え、状態を変える要求に `Origin` の確認と、カスタムのヘッダー（`X-<Brand>-Csrf`）を要求する |
| I | IDOR（他の組織のファイル・コメント） | RLS と判定関数。権限がないものと存在しないものは同じ 404（permissions-and-sharing.md の 5.3 節） |
| I | ファイルの鍵の推測 | 128 ビットの乱数（permissions-and-sharing.md の 8 節） |
| D | 高い API（検索、版の一覧、複製）の連打 | Slack の ADR-0029 のレート制限の部品（Valkey）。利用者・組織ごと |
| E | 組織の管理者の権限の横取り（招待のトークン、SSO の設定） | 招待のトークンはハッシュで保存し、期限と 1 回だけ。SSO の設定の変更は、組織の管理者の再認証と監査ログ |

### 3.5 プラグイン（MVP の後）

脅威モデルの本体は [plugins.md](plugins.md) の 3 節にある。この領域で足すのは次のとおり。

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | プラグインが、開いたファイルの中身を宣言した通信先へ送る | 避けられない（plugins.md の 3 節）。組織の許可の一覧と、監査ログのプラグインの実行の記録（6 節） |
| E | QuickJS・membrane の欠陥でサンドボックスを抜ける | 公開を止め、全プラグインを止める ops フラグ（plugins.md の 11 節）。外部の侵入試験をプラグインの公開の前に 1 回 |
| S | UI の iframe で偽のログインの画面を出す | iframe の枠に名前と作者を出し、自動の検査でパスワードの入力欄を探す（plugins.md の 10 節） |

### 3.6 書き出しの Worker（Render Worker・file-read）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | ジョブの取り違えで、別の組織のファイルを描く | ジョブに `org_id`・`file_id` を入れ、子のプロセスは 1 ジョブで終わる（[export-and-assets.md](export-and-assets.md) の 5.1 節）。結果のキーに `org_id` を含める |
| E | 悪意のあるファイルで Worker の子のプロセスを乗っ取る | 子のプロセスのメモリ・時間の上限、ネットワークを持たない（子が自分で入れる seccomp のフィルタ。Fargate は `CAP_SYS_ADMIN` を与えないので名前空間は使わない。export-and-assets.md の 5.3 節）、タスクはインターネットへの経路を持たない（同 5.3 節） |
| I | 結果の URL の漏れ | 署名付き URL は 24 時間、結果は 14 日（同 4.4 節） |
| D | 大量の書き出しで Worker を占有する | 公開 API の画素の予算と組織ごとの合計（[api-and-webhooks.md](api-and-webhooks.md) の 5 節）、`render-export` と `render-thumbnail` のキューを分ける |

### 3.7 共有のリンクと利用者のコンテンツ

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 「リンクを知っている全員」のファイルで、ログインの画面や他社を装う画面（フィッシング）を配る | 9 節の不正利用の対応。プロトタイプの公開（MVP の後）は、別の登録可能ドメインで配り、上部に帯を出す |
| I | 共有のリンクの URL が、Referer・チャットのプレビューで漏れる | 名前を URL に入れない、OGP に名前とサムネイルを出さない、`noindex`（permissions-and-sharing.md の 8 節） |

## 4. 認証とセッション

[ADR-0043](../decisions/0043-authentication-sessions-and-org-sso.md) による。

| 項目 | 決定 |
| --- | --- |
| 実装 | Better Auth を自前でホスト（Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)） |
| アカウント | グローバル（`global.accounts`）。組織の中はメンバー（`org_members`）。Slack の ADR-0010 と同じ |
| ログインの手段 | メールの確認コード、Google、Microsoft、パスキー。パスワードは持たない |
| 2 段階の認証 | TOTP、パスキー。組織の方針で必須にできる（MVP の後） |
| セッション | `global.sessions`。アイドル 14 日、最長 30 日。端末の一覧と、個別の取り消し |
| 組織の SSO（E12。MVP の範囲の外で、GA の判定に含めない。[roadmap.md](../roadmap.md)） | SAML 2.0・OIDC。確認済みのドメインのメンバーにだけかける。ゲストは対象の外（本家と同じ）。「どの方法でもよい」「SSO だけ」 |
| SCIM | S2 の前（roadmap.md の延期の一覧）。`active=false` はメンバーの無効化（アカウントは消さない） |
| WebSocket | 能力のチケット（60 秒・1 回）。同じ持ち主への再接続は Gateway の再開のトークン（60 秒・1 回。permissions-and-sharing.md の 5.5 節）。セッションの取り消しで `session.revoked` を配り、接続を切る。取りこぼしは 5 分ごとの再検証で拾う |
| 運用者 | IAM Identity Center の SSO＋MFA。本番のデータを読む役割は、期限つきの承認（最長 4 時間）で得る |

- 本家は、21 日使われないと自動でログアウトさせる。Enterprise の組織の管理者は、メンバーのアイドルの期限を 12 時間〜14 日にできる（ゲストにはかからない）（[Set an idle session timeout](https://help.figma.com/hc/en-us/articles/14376092335127-Set-an-idle-session-timeout)、2026-09-27 に確認）。上の値（アイドル 14 日、最長 30 日）はこの設計の既定案で、PM と決め直してよい。
- 匿名の閲覧者（「リンクを知っている全員」）は、ブラウザごとの匿名のセッション（`anonymous_session_id`、24 時間）を持つ。在席では「匿名」と表示する（permissions-and-sharing.md の 11 節）。

## 5. 暗号化と鍵

[ADR-0044](../decisions/0044-encryption-keys-and-client-cache.md) による。

### 5.1 通信

- 外向きは TLS 1.2 以上。CloudFront のセキュリティのポリシーは `TLSv1.2_2021` 以上。HSTS（preload）。
- VPC の中：ALB → Gateway・API は TLS。Gateway → Document Server は、セキュリティグループで絞った VPC の中の TCP で、TLS を張る（証明書は自前の CA。費用と運用は E1 の `ecs-rust-services-baseline` で決める。**未検証**）。

### 5.2 保存

| 置き場所 | 暗号化 | 鍵 |
| --- | --- | --- |
| DynamoDB `journal`・`file_leases`・`ds_liveness` | カスタマー管理キー | `journal` |
| S3 `<brand>-files-{env}`（チェックポイント・チャンク・大きな変更） | SSE-KMS＋バケットキー | `files` |
| S3 assets（画像・フォント・書き出し・サムネイル・コメントの添付） | SSE-KMS＋バケットキー | `assets` |
| Aurora | ストレージの暗号化 | `metadata` |
| Valkey | 保存時と通信の暗号化 | `metadata` |
| CloudWatch Logs、log-archive の S3 | SSE-KMS | `logs` |
| Secrets Manager | 既定の形 | `secrets` |
| ブラウザの IndexedDB（チャンクのキャッシュ） | しない | — |

- 鍵はすべて東京で作り、大阪にレプリカを置くマルチリージョンキー。年 1 回の自動の入れ替え。
- 鍵のポリシーで、使えるサービスの役割を分ける（ADR-0044）。人は break-glass の役割だけ。
- 能力のチケットの署名の鍵（Ed25519）は Secrets Manager。90 日ごとに入れ替え、`kid` で 24 時間並べる。再開のトークンの鍵（HMAC-SHA256）は Gateway だけが読める別の秘密にし、同じ周期で入れ替える。Webhook の署名の秘密は [api-and-webhooks.md](api-and-webhooks.md) の 6.3 節。
- **組織ごとの鍵は MVP で持たない。** 企業の要望で、S2 の前に別の ADR で扱う。

### 5.3 端末のキャッシュ

- 暗号化しない（ADR-0044 の理由）。ログアウト、セッションの失効、権限の喪失で消す。
- 組織の方針 `client_cache = allowed | session_only | disabled`（E12）。ファイルを持つ組織の方針に従う。
- 画面と文書で、共有の端末ではログアウトするよう案内する。

## 6. 監査ログ

[ADR-0045](../decisions/0045-audit-log-and-data-lifecycle.md) による。形は Slack の [ADR-0018](../../../slack/docs/decisions/0018-audit-log.md) を引き継ぐ。

| 項目 | 決定 |
| --- | --- |
| 書き方 | `audit_events`（`org_id`、FORCE RLS）に、操作と同じトランザクションで書く。outbox で log-archive の S3（Object Lock のコンプライアンスモード）へ送る |
| 中身 | `actor`（アカウント・運用者・API のトークン・プラグイン）、`action`、`resource_type`・`resource_id`、変更前後の水準・範囲、IP、ユーザーエージェントの種類、`request_id`。**名前・本文を書かない** |
| 保持 | Aurora に 1 年、アーカイブは 7 年（既定案。法務の確認待ち、L4） |
| 見る人 | 組織の管理者（組織のプラン、MVP の後）。画面と CSV。本家の活動のログに当たる |
| 運用者の操作 | `global.operator_audit_events` にも書く。サポートの版の復元・複製、濫用の取り下げ、break-glass の利用 |

記録する操作：

| 分類 | 操作 |
| --- | --- |
| 認証 | ログイン、ログインの失敗（連続したものは間引く）、2 段階の認証の設定、セッションの取り消し、SSO の設定の変更 |
| 組織 | メンバーの追加・無効化、役割とシートの変更、方針の変更（公開の禁止、キャッシュ、プラグイン） |
| 共有 | `resource_roles`・`general_access` の変更、招待、アクセスの申請の承認、リンクの期限 |
| ファイル | 作成、移動、ゴミ箱、戻す、完全な削除、複製、版の復元、ファイルを開いた（1 時間に 1 回に間引く）、書き出し（サーバーの書き出し） |
| 資産 | 組織のフォントの追加・削除、画像の取り下げ |
| 拡張 | プラグインの実行（ID・版・ファイル。[plugins.md](plugins.md) の 8 節）、OAuth のアプリの許可、トークンの発行・失効、Webhook の作成 |

- ファイルの中の編集は監査ログに書かない。ジャーナルと版の履歴が記録になる。

## 7. データのライフサイクル

期間は既定案で、**法務の確認待ち**（[intent.md](../intent.md) の L4）。バックアップ（最大 35 日）を、どの削除でも最終の期限にする（ADR-0045）。

| データ | 通常の保持 | 削除のきっかけ | 消し方 | 残る場所と期間 |
| --- | --- | --- | --- | --- |
| ファイルの中身（ジャーナル） | 書いてから 30 日（TTL） | TTL、完全な削除 | TTL、削除のジョブ | PITR 35 日 |
| チェックポイント・チャンク | [file-storage-and-history.md](file-storage-and-history.md) の 5.3 節 | 掃除、完全な削除 | 東京と大阪の両方で、版を指定して消す | S3 の古い版 30 日（東京・大阪とも、ライフサイクルを両方に置く） |
| 版の履歴 | 無料 30 日、有料はすべて | 期限、完全な削除 | 掃除 | 同上 |
| ゴミ箱のファイル | 自動では消さない | 完全な削除 | 削除のジョブ（file-storage-and-history.md の 11.2 節） | 同上 |
| コメント・通知 | ファイルと同じ | 本人の削除、ファイルの完全な削除 | 行の削除 | Aurora のバックアップ 35 日 |
| 画像・フォント | 参照がある間 | 参照の数が 0、取り下げ | [export-and-assets.md](export-and-assets.md) の 6.5 節 | S3 の古い版 30 日 |
| 書き出しの結果 | 14 日 | 期限 | ライフサイクル | — |
| アカウント | 本人が消すまで | 本人の削除 | 30 日の猶予の後、個人の情報を消し、所有するファイルを組織（下書きは組織の管理者）へ移す | バックアップ 35 日 |
| 組織 | 解約まで | 解約 | 28 日の猶予（本家のチームの削除と同じ）の後、配下の全ファイルを完全な削除 | 同上 |
| 監査ログ | 1 年（Aurora）、7 年（アーカイブ） | 期限 | パーティションの削除、Object Lock の期限 | — |
| アプリのログ | 30 日 | 期限 | CloudWatch Logs の保持 | — |
| クライアントの計測 | 生のログ 30 日、集計 13 か月 | 期限 | 同上 | — |
| 端末のキャッシュ | 500 MB まで | ログアウト、権限の喪失、組織の方針 | クライアント | 利用者の端末 |

- **S3 の削除は大阪に伝わらない。** 版を指定した削除も、ライフサイクルの動作も複製されない（[What does Amazon S3 replicate?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-what-is-isnot-replicated.html)、2026-09-27 に確認）。削除のジョブ・掃除・ライフサイクルは、両方のバケットで行う（ADR-0045）。
- **リーガルホールド**：組織・ファイル単位で削除を止める印を持つ（Slack の ADR-0019 と同じ）。印のあるものは、掃除と削除のジョブが飛ばす。使う条件は法務の確認待ち。
- 所有者のアカウントを消したときのファイルの移し先は、[permissions-and-sharing.md](permissions-and-sharing.md) の 10 節に合わせる（チームの `admin`、下書きは組織の管理者）。

## 8. 秘密情報・サプライチェーン・運用者のアクセス

- 秘密情報は Secrets Manager。コードと環境変数に直に書かない。gitleaks を PR の CI で走らせる。
- Rust の依存は `cargo-deny`（ライセンスと既知の脆弱性）と `cargo-vet`（取り込みのレビュー）、npm は lockfile と `npm audit`。コンテナのイメージは Inspector で検査する。
- WASM とフォントを配る CloudFront の応答に、`Content-Security-Policy` と SRI（最初に読む JS）を付ける。ビルドの成果物は CI で署名し、どのコミットから作ったかを残す（SLSA の来歴。Slack と同じ）。
- 運用者が本番のファイルの中身を見る経路は持たない。サポートが利用者の依頼で版を復元・複製するときは、利用者の権限の範囲で、利用者の同意と監査の記録を残す（file-storage-and-history.md の 17 節の runbook）。

## 9. 不正利用

| 不正利用 | 見つけ方 | 対応 |
| --- | --- | --- |
| 「リンクを知っている全員」のフィッシングの画面 | 通報の窓口（画面の「通報」、`abuse@`）、外部のフィッシングの情報、新しいアカウントが作った `anyone` のファイルの閲覧の急増 | 運用者の取り下げ（一般アクセスを `invited_only` に下げ、所有者に知らせる）。監査付き。手続きは法務の確認待ち（L3） |
| 権利の侵害（画像・フォント） | 権利者の申し立て | 取り下げ（`taken_down`）。[export-and-assets.md](export-and-assets.md) の 16 節の runbook。手続きは法務の確認待ち（L2） |
| スパムのコメント・メンション・招待 | コメントの上限（1 時間 100 件）、招待の上限、通報 | 上限、アカウントの停止 |
| 無料のプランでの保存の濫用（画像の置き場） | 組織ごとの画像の容量、公開のファイルからの画像の取得の量 | 容量の上限（PM）、取得の制限 |
| アカウントの大量の作成 | 同じ IP・端末の作成の数 | WAF のレート制限、確認コードの上限 |
| 大量の取得（組織の中身の持ち出し） | API・書き出しの量 | tier の制限、組織の管理者への監査ログ（[api-and-webhooks.md](api-and-webhooks.md) の 9 節） |
| 巨大なファイルでの資源の占有 | ファイルの大きさ、Document Server のメモリ | 大きさの上限（[document-model.md](document-model.md) の 11 節）、ADR-0051 |

- 取り下げの操作は、運用者の画面から行い、`global.operator_audit_events` に残す。ファイルの中身を運用者が開くことは、通報の対象の確認だけに限り、承認を要する（手続きは法務の確認待ち）。

## 10. 法務の確認待ち

結論が出るまで、該当する Story の spec を承認しない（[intent.md](../intent.md) の「法務の確認待ち」）。

| # | この領域の論点 | 関わる節 |
| --- | --- | --- |
| L2 | 権利の侵害の申し立ての受け付けと、取り下げの期限・通知（情報流通プラットフォーム対処法。この事業の規模で大規模な事業者の義務がかかるかを含む） | 9 節 |
| L3 | 公開のリンクの不正な内容の通報と取り下げの手続き、運用者が中身を見てよい条件 | 9 節 |
| L4 | 削除の期間（ゴミ箱、アカウント、組織の猶予）、バックアップに最大 35 日残ることの利用規約とデータ処理の契約への書き方、監査ログの 7 年 | 6・7 節 |
| L5 | 漏洩（組織をまたぐ漏洩を含む）のときの、個人情報保護委員会と本人への報告の要否と期限 | [runbooks/incident-response.md](../runbooks/incident-response.md) |
| 追加 | クライアントの計測（中身なし）の利用規約への書き方と、同意の要否（ADR-0049） | [observability.md](observability.md) の 3 節 |
| 追加 | 海外の組織（EU など）との契約で求められる、データの所在（東京・大阪）の説明と、国外への移転の扱い | 7 節 |

## 11. セキュリティの試験

| 試験 | 頻度 | 対象 |
| --- | --- | --- |
| fuzzing（`cargo fuzz`） | PR ごとに 5 分、夜間に 1 時間 | 復号器・検証器、画像・フォント・SVG の解析、ワイヤの復号、plugin の membrane |
| 漏洩のテスト | PR ごと | [permissions-and-sharing.md](permissions-and-sharing.md) の 13.3 節の経路 × 4 つの主体 |
| DAST（OWASP ZAP） | 週に 1 回（staging） | API、Web |
| 外部の侵入試験 | GA の前に 1 回、以後年 1 回。プラグインの公開の前に 1 回 | 全体。特にチケット、Gateway、共有のリンク、usercontent のドメイン |
| 鍵のポリシー・IAM の検査 | PR ごと（Terraform） | IAM Access Analyzer、`checkov` |

## 12. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり（E1 基盤とビルド … E12 運用と GA の準備）。

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `auth-better-auth-baseline` | Better Auth、`global.accounts`・`sessions`、メールの確認コード、Google、パスキー |
| E1 | `kms-keys-and-policies` | 5.2 節の鍵、鍵のポリシー、大阪のレプリカ |
| E1 | `csp-and-security-headers` | CSP（`wasm-unsafe-eval`）、HSTS、`nosniff`、CSRF のヘッダー |
| E3 | `ds-ticket-verification` | Document Server でのチケットの署名の確認と、Gateway からの水準の下げだけの許可 |
| E3 | `gateway-resume-token` | 再開のトークンの発行・検証と、Document Server での水準の上限（permissions-and-sharing.md の 5.5 節） |
| E9 | `session-revocation-kick` | `session.revoked` の配送と接続の切断 |
| E9 | `audit-events-core` | `audit_events`、outbox、log-archive への送り |
| E7 | `purge-both-regions` | 完全な削除のジョブと掃除を大阪のバケットにも広げる（file-storage-and-history の `trash-and-purge` と 1 つにする） |
| E12 | `org-audit-log-viewer` | 組織の管理者の監査ログの画面と CSV（組織のプラン。GA の判定に含めない） |
| E12 | `org-saml-sso` | SAML・OIDC、確認済みのドメイン、「SSO だけ」（MVP の範囲の外。GA の判定に含めない） |
| E12 | `org-client-cache-policy` | `client_cache` の方針 |
| E12 | `abuse-takedown-console` | 取り下げの運用者の画面と監査（L2・L3 の確認の後） |
| E12 | `pentest-and-fixes` | 外部の侵入試験と修正 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- セッションはアイドル 14 日、最長 30 日。
- 組織ごとの鍵は MVP で持たない。
- 端末のキャッシュは暗号化しない。組織の方針で止められるようにする（E12）。
- 監査ログは Aurora に 1 年、アーカイブに 7 年。
- 組織の解約は 28 日の猶予。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Gateway → Document Server の TLS の証明書の出し方（自前の CA の費用と入れ替え） | E1 の `ecs-rust-services-baseline` |
| 匿名の閲覧者のセッションの長さと、匿名の人数の上限 | PM（E9） |
| 組織の管理者が、プランを上げる前の監査ログを見られるか | PM |
| 組織ごとの鍵（持ち込みの鍵）の需要 | S2 の前。企業の商談で決める |
| 10 節の法務の論点 | 法務 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 漏洩のテストの経路の一覧（permissions-and-sharing.md の 11 節）を、NFR-010 のリリースの基準にする。経路を足したらテストも足す。
- fuzzing の実行時間と、見つかった落ちの数（目標 0 で出す）。
- 外部の侵入試験の重大・高の指摘が 0 件で GA。

### runbooks

- `session-compromise.md`：アカウントの乗っ取りの疑いで、全セッションを取り消し、接続が切れたことを確かめ、監査ログで操作を調べる手順。
- `ticket-signing-key-rotation.md`：能力のチケットの署名の鍵の定期の入れ替えと、漏洩のときの即時の入れ替え（Gateway と Document Server への公開鍵の配布）。
- `tenant-isolation-breach.md`：組織をまたぐ漏洩の疑い。影響の範囲の調べ方（判定のログの規則の ID、監査ログ）、報告の判断（L5）。[runbooks/incident-response.md](../runbooks/incident-response.md) の「テナントの分離の破れ」から呼ぶ。
- `abuse-takedown.md`：フィッシング・権利の侵害の取り下げ（L2・L3 の後）。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| Aurora `global.accounts`・`global.sessions`・`global.passkeys`・`global.verification_codes` | 認証（Better Auth の表。Slack と同じ形） |
| Aurora `org_sso_configs`（RLS） | `org_id`、`protocol`（`saml`・`oidc`）、IdP のメタデータ、`enforcement`（`any`・`sso_only`）、`verified_domains` |
| Aurora `audit_events`（RLS、月のパーティション） | 6 節 |
| Aurora `global.operator_audit_events` | 運用者の操作 |
| Aurora `legal_holds`（RLS） | `org_id`、`scope`（`org`・`file`）、`resource_id`、`reason`、`created_by`、`released_at` |
| Aurora `orgs` の列 | `client_cache`、`session_max_age` |
| S3（log-archive）`audit/{org_id}/{yyyy}/{mm}/…` | 監査のアーカイブ（Object Lock） |
