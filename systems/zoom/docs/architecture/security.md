# Security: Zoom

信頼境界、部品ごとの脅威モデル（STRIDE）、暗号化、鍵と秘密、監査ログ、運用者のアクセス、濫用への対策（会議の荒らし、TURN の悪用、メディアの IP への DDoS）、データのライフサイクル、セキュリティの試験、脆弱性の管理、インシデント、法務の論点。会議に知らない人を入れない仕組みの中身は [meeting-security.md](meeting-security.md)、E2EE の中身は [e2ee.md](e2ee.md)、TURN と網の規則は [network-traversal.md](network-traversal.md) にある。

前提となる決定は、既定はホップごとの暗号化で E2EE は選べること（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）、Media Node は公開の IP を持ち接続の追跡を外すこと（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0016](../decisions/0016-media-edge-addressing-and-security-groups.md)）、TURN の中継の相手を Media Node に限ること（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)）、待合室かパスコードの不変条件（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0045](../decisions/0045-ddos-defense-for-media-edge.md) | Shield Advanced は入口（CloudFront・ALB・Route 53）を常に守る。Media Node と TURN の EIP は、攻撃を受けたときだけ守りに加える（常に守ると転送の料金が約 4 割増え、IPv6 は守れない）。Media Node に、ICE を通った送信元だけを通す防御のモードを持たせ、攻撃を受けた Node の会議は別の Node へ移す |
| [0046](../decisions/0046-audit-logs-and-data-lifecycle.md) | 監査ログを 3 系統（組織、会議、プラットフォーム）に分け、DB に 1 年、log-archive に 7 年置く。会議の内容は既定で残さない。IP は 30 日、品質の生の記録は 30 日、参加ごとの品質の要約は 12 か月 |
| [0047](../decisions/0047-keys-and-operator-access-to-media.md) | KMS の鍵を用途ごとに分け、録画などは 1 つの鍵と `org_id` の暗号化の文脈で組織を分ける。BYOK は MVP の後。平文のメディアに触れる部品を `media-prod` のアカウントに分け、人に常設の権限を与えない。会議に見えない形で入る機能を作らない |

## 1. 目標と前提

- 実行基盤・CI/CD・監視の統制は、他の題材の決定を引き継ぐ（[ADR-0001](../decisions/0001-platform-and-stack.md)）。ここにはビデオ会議に固有の部分を書く。
- 目標の水準は、OWASP ASVS 5.0 の Level 2 とする（他の題材と同じ）。章の番号との照合は E1 で行う。
- 最も重い障害は 5 つ。
  1. **知らない人が会議に入り、内容を見聞きする、または荒らす**（intent.md の Problem。[meeting-security.md](meeting-security.md)）。
  2. **サーバーの側から、会議の内容が漏れる**：Media Node・Recorder・Transcriber・Composer の上の平文のメディア、保存した録画・文字起こし・チャット。通常の会議では、サーバーは内容を扱える（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）。
  3. **E2EE の約束が破れる**：サーバーが鍵を持つ、録画や字幕が E2EE の会議で動く、偽の参加者を AS が作る（[e2ee.md](e2ee.md)）。
  4. **組織をまたいだ漏えい**：他の組織の会議・録画・参加者の情報が見える（intent.md の「守るべき振る舞い」）。
  5. **メディアが止まる**：Media Node・TURN への DDoS、TURN を踏み台にした攻撃。メディアの IP は公開の範囲にあり、ロードバランサーの後ろにない。
- **会議は通信である。** 内容と、通信の構成要素（誰がいつ誰と会議にいたか、IP）の扱いは、通信の秘密の整理（intent.md の L2）に従う。整理が済むまで、内容に触れる機能の spec は承認しない（intent.md の表）。
- **AI エージェント（コーディング・運用）は、本番に経路を持たない。**

## 2. 信頼境界

```
  ┌──────────────── インターネット（信頼しない）────────────────────────────────────┐
  │ 参加者のブラウザ（社内の人・社外のゲスト）   組織の管理者   攻撃者              │
  └──┬───────────────────────┬────────────────────────────────┬─────────────────┘
     │ HTTPS・WSS            │ UDP・TCP 20000–20255          │ UDP・TCP 3478、TLS 443
═════╪═ B1：入口（CloudFront＋WAF＋Shield Advanced、edge アカウント）═══╪══════════════════
     ▼                       │ B2：メディアの境界（ICE の認証＋DTLS）│
┌── prod（制御の側）─────────┐ │                                       │
│ ALB → API、Signaling       │ │  ┌── media-prod ───────────────────────▼──────────┐
│ Gateway、Actor Host、      │ │  │ Media Node（公開の IP、平文のメディア）  TURN  │
│ Assignment、Worker         │◀┼──┼─ B3：制御の API（mTLS、epoch、ピアリング）      │
│ Aurora、Valkey、SQS        │ └─▶│ Recorder・Transcriber・Composer（平文のメディア）│
└────────────────────────────┘    │ S3 raw/・final/・transcripts/（SSE-KMS）        │
                                  └──────────────────────────────────────────────────┘
═══ B4：管理プレーン ═══ CI/CD（OIDC）、運用者（SSO＋MFA、期限つき）、log-archive（Object Lock）
─ ─ ─ B5：E2EE の境界 … E2EE の会議の鍵は、参加者の端末の中だけ（サーバーは DS・AS）─ ─ ─
─ ─ ─ B6：開発環境（AI コーディングエージェント）… 本番への経路なし ─ ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 入口 | Web、API、シグナリング | TLS 1.2 以上、HSTS、WAF（参加の推測への CAPTCHA は [ADR-0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md)）、Shield Advanced（ADR-0045）。WebSocket の `Origin` の検査 |
| B2 メディア | RTP・RTCP・STUN・DTLS | ICE の認証（transport ごとの乱数の `ice-ufrag`・`ice-pwd`）、DTLS の指紋（シグナリングで受けたもの）、SRTP。送信元の数の制限は防御のモード（ADR-0045） |
| B3 制御 → メディア | Actor Host → Node Agent、Node → Assignment | VPC のピアリング、セキュリティグループの参照、相互 TLS（Private CA、7 日）、`epoch` のフェンシング（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)） |
| B4 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、期限つきの権限、監査（ADR-0046・0047） |
| B5 E2EE | MLS のメッセージ、SFrame のメディア | サーバーは中身を見ずに順序付けて配る。鍵はサーバーに出ない（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)） |
| B6 開発環境 | コード（PR としてのみ） | 本番の資格情報を置かない。試験に実在の人の声や顔を使わない（本題材の [AGENTS.md](../../AGENTS.md)） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主な脅威と対策だけを書く。

### 3.1 クライアント（Web、後のアプリ）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 改造したクライアントが、他人の `participant_id` や主催者を名乗る | 役割と身元は、API が署名した参加のトークンと Actor の状態で決める。クライアントの申告の役割を使わない（[signaling-and-meetings.md](signaling-and-meetings.md) の 13 節） |
| T | 改造したクライアントが、帯域を使い切るほど送る、層の申告を偽る | Media Node の `setMaxIncomingBitrate`、受け手ごとの consumer の上限（[media-server-sfu.md](media-server-sfu.md) の 11 節） |
| T | 偽の `media.stall` で、Node の付け替えを起こす | 1 人の報告では付け替えない。2 人以上か心拍の欠落（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)） |
| T | 偽の品質の数（`qos.report`）で SLI を歪める | SLI を Media Node の側の数と突き合わせる（[ADR-0051](../decisions/0051-qos-telemetry-pipeline.md)） |
| I | 画面の外への漏えい（XSS で会議の内容や参加のトークンを取る） | CSP（`script-src 'self' 'wasm-unsafe-eval'`）、表示の名前・チャットのエスケープ（[clients.md](clients.md) の 11 節） |
| I | 参加の鍵が URL から漏れる | 鍵は URL のフラグメントに置き、サーバーのログと `Referer` に残さない（[ADR-0006](../decisions/0006-meeting-id-and-join-url.md)） |
| I | ICE の候補から、利用者の内側の IP が相手に漏れる | Media Node はクライアントの候補を他の参加者に渡さない（SFU なので参加者どうしは直接つながらない）。候補の文字列を品質の報告に入れない |
| E | ブラウザの WebRTC の脆弱性 | 対応ブラウザを最新 2 メジャーに限る（[ADR-0021](../decisions/0021-web-client-browser-support.md)）。アプリの libwebrtc の更新の期限（[clients.md](clients.md) の 10 節） |

### 3.2 入口（CloudFront、WAF、ALB、API）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 会議の番号とパスコードの総当たり | 3 つの軸のトークンバケット、CAPTCHA、同じ応答と同じ時間（[ADR-0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md)） |
| S | 参加のトークンの使い回し | 120 秒、1 回限り（`jti` を Valkey で記録）、署名（ADR-0047 の `<brand>-join-signing`） |
| T | 録画の共有のリンクの推測 | 128 ビットの乱数、SHA-256 だけを保存、パスコード必須（[recording-and-transcription.md](recording-and-transcription.md) の 6.2 節） |
| I | 他の組織の録画・会議・レポートを読む | API の認可を `org_id` で必ず絞る。その下で、組織に属する表は `org_id` と FORCE RLS で分ける（[ADR-0058](../decisions/0058-tenant-tables-with-force-rls.md)）。組織をまたぐ読み取りの拒否の試験を持つ（10 節） |
| D | 参加の API とシグナリングへの L7 の洪水 | CloudFront、WAF のレート制限、Shield Advanced（ADR-0045）。`ops.join_admission` で参加の受付を絞る（[delivery.md](delivery.md) の 6 節） |
| R | 主催者・管理者の操作の否認 | 会議の監査・組織の監査（6 節） |

### 3.3 Signaling Gateway

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 別のオリジンのページから WebSocket を開く（CSWSH） | `Origin` の検査、参加のトークンの提示が最初のメッセージ |
| D | 大きなメッセージ、速すぎる送信、読まない接続 | 64 KiB の上限、`cmd` の流量の制限、送信の待ちの上限（[signaling-and-meetings.md](signaling-and-meetings.md) の 6.3 節） |
| D | 再接続の嵐（Gateway の入れ替え、網の瞬断） | クライアントの指数の待ちとゆらぎ、Gateway の段階的な切断（[runbooks/incident-response.md](../runbooks/incident-response.md) の「シグナリングの再接続の嵐」） |
| I | 品質の報告やログに、内容が混ざる | `qos.report` のスキーマに内容の項目を持たない。ログに書く項目の許可リスト（本題材の AGENTS.md） |

### 3.4 Meeting Actor（と Actor Host）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T | 2 つの Actor が同じ会議を動かす（分断、時計のずれ） | リースと `epoch`。Media Node・Gateway・Aurora が古い `epoch` を拒否する（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)） |
| E | 主催者の操作の判定の誤りで、参加者が主催者の力を得る | 決定表と性質ベーステスト（[ADR-0009](../decisions/0009-host-controls-enforcement.md)） |
| E | E2EE の会議で、録画・字幕の受け手を足す | API・Actor・Media Node の 3 か所で拒否（[ADR-0027](../decisions/0027-capture-consent-and-indicators.md)） |
| S | AS（本システム）が偽の参加者の資格情報を出す（E2EE） | 会議のセキュリティのコードの照合（[e2ee.md](e2ee.md)）。AS の中間 CA の鍵は KMS、発行は `e2ee_credentials` に記録 |
| I | 状態のスナップショット（Valkey）から、待合室の人の名前や設定が漏れる | Valkey の転送中の暗号化と AUTH、`prod` の VPC の中だけ。チャットの本文はスナップショットに入れない |

### 3.5 Media Node

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 他人の transport にパケットを差し込む | ICE の認証（乱数の資格情報）と DTLS の指紋。SRTP の認証タグ |
| T | 制御の API を偽の Actor が呼ぶ | 相互 TLS（Actor Host の証明書）、セキュリティグループの参照、`epoch` |
| I | 平文のメディアの取り出し（ダンプ、ログ、`tcpdump`） | ペイロードを保存・ログにしない。コアダンプを無効。パケットの取得はヘッダーまで（ADR-0047）。人のシェルは期限つき |
| I | 別の会議の producer を consume させる | Node Agent の API は `meeting_id` の router の中だけで consumer を作る。router を会議の間で共有しない |
| D | 公開の範囲への UDP の洪水、ENA の PPS の上限を超える攻撃 | 防御のモード、会議の移動、Shield Advanced の一時的な保護（ADR-0045）。`*_allowance_exceeded` の監視 |
| D | 1 つの worker の異常終了で、多くの参加者が落ちる | worker ごとの付け替え（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)） |
| E | mediasoup の C++ の worker の脆弱性（細工した RTP・RTCP・STUN） | 依存の監視、ファジング（10 節）、Node の権限を最小に（インスタンスのロールに EIP の付け替えを与えない。[ADR-0049](../decisions/0049-media-node-fleet.md)）、`nftables` の出の規則（ADR-0016） |

### 3.6 TURN（coturn）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 資格情報の使い回し、長期の悪用 | 一時的な資格情報（12 時間、HMAC）。参加の許可を得た人にだけ出す（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)） |
| E | TURN を踏み台に、VPC の中・メタデータ・任意の相手へ送る | 中継の相手を Media Node の範囲に限る。ループバック、プライベート、169.254.169.254 を拒否。TCP の中継を使わない |
| D | 割り当ての枯渇、帯域の独占 | 1 人 4 つの割り当て、1 つ 10 Mbps。割り当ての数の監視と警報（[observability.md](observability.md) の 6 節） |
| D | TLS 443 への洪水 | ADR-0045 の一時的な保護、台の追加。IP の範囲からの制限は WAF では掛けられない（UDP・TLS の直接の受け口のため） |
| E | coturn の脆弱性 | バージョンの固定と監視、11 節の期限 |

### 3.7 Recorder・Transcriber・Composer

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 録画の生の区切り・成果物の漏えい | `media-prod` のバケット、SSE-KMS（`org_id` の文脈）、公開のアクセスの禁止、署名付きの URL 10 分（[recording-and-transcription.md](recording-and-transcription.md) の 6 節） |
| I | 同意のない録音（表示なしで Recorder が動く） | 表示と同意の状態を Actor が持ち、Recorder の購読をその状態に結び付ける（[ADR-0027](../decisions/0027-capture-consent-and-indicators.md)） |
| I | 音声認識の外部の事業者への送信 | 音声だけを送る。名前・題名を送らない。委託の整理は L6 |
| T | 合成の結果の差し替え | `final/` への書き込みを Composer のロールだけに許す。`recording_files.sha256` を記録し、開示の請求や争いのときに照合する（再生のたびには照合しない） |
| D | 合成の待ち行列の詰まり | SQS の古さの監視（[recording-and-transcription.md](recording-and-transcription.md) の runbooks） |

### 3.8 データの置き場所と CI/CD

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | Aurora のバックアップ・スナップショットの持ち出し | `<brand>-data` の鍵、スナップショットの共有の禁止（SCP） |
| T | CI/CD・Terraform の改ざんで、セキュリティグループや KMS のポリシーが緩む | plan のポリシー検査（[infrastructure.md](infrastructure.md) の 9 節）、`security:sensitive` の 2 人の承認（他の題材と同じ） |
| T | 依存（mediasoup、coturn、OpenMLS、npm）への供給網の攻撃 | バージョンの固定、ハッシュの検証、SBOM、依存の更新は 1 PR ずつ |

## 4. 暗号化

### 4.1 転送中

| 区間 | 方式 |
| --- | --- |
| ブラウザ → CloudFront | TLS 1.2 以上、HSTS |
| CloudFront → ALB → タスク | TLS（オリジンの証明書は ACM、タスクは Private CA） |
| ブラウザ ↔ Media Node | DTLS-SRTP（[RFC 8827](https://www.rfc-editor.org/rfc/rfc8827)）。E2EE の会議は、その中を SFrame でさらに暗号化 |
| ブラウザ ↔ TURN | TURN の上の DTLS-SRTP（TURN は SRTP を解かない）。TLS 443 の経路は、その外側も TLS |
| Actor Host ↔ Node Agent | 相互 TLS（Private CA、7 日） |
| Media Node ↔ Media Node（S2 のカスケード） | PipeTransport の SRTP（[ADR-0012](../decisions/0012-media-assignment-and-cascading.md)） |
| Media Node → Recorder・Transcriber | PlainTransport の SRTP。会議ごとの鍵（[recording-and-transcription.md](recording-and-transcription.md) の 10 節） |
| タスク → Aurora・Valkey | TLS。Valkey は転送中の暗号化と AUTH |

### 4.2 保存時

鍵の階層は [ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md) の表のとおり。KMS の鍵は用途ごとに 6 つで、どれもマルチリージョン（主は東京、レプリカは大阪）。

- 録画・文字起こし・チャットのファイルは `<brand>-content`、パスコード・チャットの本文・カレンダーのトークンは `<brand>-meeting-secrets` で、どちらも暗号化の文脈に `org_id` を入れる。
- log-archive の監査ログは、log-archive のアカウントの鍵で暗号化する（prod・media-prod の主体が消せない・読めない）。
- **BYOK は MVP の後。** 顧客が鍵を止めたときの振る舞い（録画を読めない、新しい録画を止める）と、サポートの手順を先に決める。

## 5. 鍵と秘密

| 秘密・鍵 | 保存 | 入れ替え |
| --- | --- | --- |
| 参加のトークンの署名の鍵 | KMS（非対称。API のタスクが `Sign`） | 年 1 回と、漏えいの疑いのとき。新旧の公開鍵を 1 日並べて配る |
| パスコードの HMAC の pepper | `<brand>-meeting-secrets` で暗号化し Secrets Manager | 漏えいの疑いのとき。バージョンを付け、新しい会議から新しいバージョン（[meeting-security.md](meeting-security.md)） |
| `ip_prefix_hash` の pepper | 同上 | 30 日。前の pepper を 30 日残し、照合は今と前の両方で行う（[meeting-security.md](meeting-security.md) の 10 節） |
| TURN の静的な秘密 | Secrets Manager（今と次の 2 つ） | 90 日（[ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)）。手順は network-traversal の runbook（`turn-secret-rotation.md`） |
| E2EE の AS の中間 CA の鍵 | KMS（`<brand>-e2ee-as`） | [e2ee.md](e2ee.md) の決定に従う |
| E2EE の外部の送り手の鍵 | KMS（`<brand>-e2ee-external-sender`。Ed25519、Actor Host が `Sign`） | 月 1 回。新しい鍵を作って別名を替え、古い鍵を 24 時間残す（[e2ee.md](e2ee.md) の 6.5 節） |
| Media Node の DTLS の証明書 | 保存しない（Node の起動ごとに作る） | Node の入れ替えごと |
| PlainTransport の SRTP の鍵 | 保存しない（会議ごと、Actor のメモリ） | 会議ごと |
| 相互 TLS の証明書（Actor Host・Node Agent） | AWS Private CA | 7 日で自動 |
| TURN の TLS の証明書（`*.turn.<brand>.<domain>`） | ACM の書き出せる公開の証明書（exportable public certificate）で取り、書き出した証明書と秘密鍵を Secrets Manager に置く。TURN は起動の時に読む。ACM は EC2 を含む任意の場所へ書き出せる証明書を出し、有効期間は 198 日、期限の 45 日前に更新し、更新を EventBridge で知らせる（[ACM exportable public certificates](https://docs.aws.amazon.com/acm/latest/userguide/acm-exportable-certificates.html)、2026-09-27 に確認）。書き出しは追加の料金がかかる | ACM の更新（約 153 日ごと）の通知で、Lambda が書き出して Secrets Manager を替え、TURN を順に読み直させる |
| カレンダーの OAuth のクライアントの秘密 | Secrets Manager | 提供者の上限か 1 年（[scheduling-and-calendar.md](scheduling-and-calendar.md)） |
| Webhook の署名の秘密 | `<brand>-meeting-secrets` で暗号化（`webhook_endpoints.secret_ciphertext`） | 持ち主の操作。入れ替えの間は 2 つ（[api-and-webhooks.md](api-and-webhooks.md)） |
| 公開 API の OAuth のトークン、クライアントの秘密 | ハッシュだけ（`oauth_tokens.token_hash`、`client_secret_hash`） | アクセストークン 1 時間（[api-and-webhooks.md](api-and-webhooks.md)） |
| DB の認証情報、内部の API キー | Secrets Manager | 自動のローテーション（他の題材と同じ） |

- 本システムのトークンの接頭辞（参加のトークン、録画の共有のトークン、API のトークン）は `<brand>` の独自の形にし、GitHub のシークレットスキャンのパートナープログラムに登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 6. 監査ログ

方針は [ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)。

| 系統 | 記録するもの | 置き場所 |
| --- | --- | --- |
| 組織の監査（`admin_audit_events`） | ユーザー、ロール、SSO、設定と鍵、録画の保全と削除、レポートの書き出し、E2EE の許可 | Aurora → log-archive |
| 会議の監査（`meeting_audit_events`） | 主催者の操作（退出させる、ロック、活動の停止、役割、録画・字幕の開始と停止、E2EE の選択、会議の終了）。内容は含めない | 同上 |
| プラットフォームの監査（`platform_audit_events`） | 運用者の本番・`media-prod` へのアクセス、防御のモード、EIP の保護の付け外し、Trust & Safety の措置（全体の ban、アカウントの停止）、捜査機関への対応、リーガルホールド | 同上 |
| AWS の操作 | CloudTrail（組織の証跡）。KMS の `Decrypt`、キーポリシーの変更、SSM のセッション | log-archive |

- 行ごとに前の行のハッシュを持ち、毎日連鎖を検証する。失敗は呼び出しのアラート（[observability.md](observability.md) の 6 節）。
- 組織の管理者は、自分の組織の組織の監査と会議の監査を 1 年見られる。

## 7. 運用者のアクセス

方針は [ADR-0047](../decisions/0047-keys-and-operator-access-to-media.md)。

- 常設の権限は、ダッシュボード、メトリクス、内容を含まないログだけ。
- DB・シェル・KMS の管理は期限つき（最長 4 時間）。`media-prod` のシェルは、インシデントの指揮者の承認を要する。
- **会議に見えない形で入る機能を作らない。** サポートが会議を見るときは、参加者として名前を出して入り、主催者の許可（待合室）を受ける。
- 組織のデータの参照（録画、チャット）は、組織の管理者の許可を前提にする。組織の `owner` か `admin` が、問い合わせごとに、対象（録画・チャット）と期限（最長 7 日）を決めて許可する。許可と参照は、組織の監査とプラットフォームの監査の両方に残す。
- 四半期ごとにアクセスをレビューする。

## 8. 濫用への対策

### 8.1 会議の荒らし

- 仕組みの正本は [meeting-security.md](meeting-security.md)（待合室とパスコード、退出させた人の ban、活動の停止、報告、推測の防御）。
- この領域では、横断の対策だけを持つ。
  - **Trust & Safety の対応**：報告（`abuse_reports`）の優先度、アカウントの停止、全体の端末の ban は、プラットフォームの監査に残す。
  - **会議の数と人数の濫用**：契約のない組織（個人で登録した組織など）は、同時の会議 1 つ、1 会議 100 人、1 回 60 分までにする。ボットで会議を開いて Media Node を使い切る攻撃に備える。
  - **ゲストの大量の参加**：1 つの `ip_prefix` からの同時の参加の数の上限（[ADR-0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md) のバケットに足す）。

### 8.2 TURN の悪用

| 悪用 | 対策 |
| --- | --- |
| 踏み台（任意の相手、VPC の中への中継） | 中継の相手を Media Node の範囲に限る（ADR-0015）。セキュリティの試験で毎日確かめる（10 節） |
| 資格情報の流出と帯域の盗用 | 12 時間の期限。中継の先は Media Node だけなので、会議の外では使えない。割り当ての数と帯域の上限 |
| 割り当ての枯渇（1 人が多くの割り当てを作る） | 1 人 4 つ（`--user-quota`）。台ごとの割り当ての数が平常の 3 倍になったら警報 |
| TURN の過負荷（企業の網の参加者が集中） | 台の追加、ICE のサーバーの一覧の重み。[runbooks/incident-response.md](../runbooks/incident-response.md) の「TURN の過負荷」 |

### 8.3 メディアの IP への DDoS

方針は [ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md)。

- **平時**：Shield Standard（追加の料金なし）。Shield は EC2 に付いた EIP への通信を毎分評価し、インスタンスの種類と大きさから求めた容量を超えると緩和を置く。緩和は攻撃の通信を減らすが、なくすとは限らない。Shield Advanced を加えると、容量の半分で緩和を置き、公開のサブネットの NACL を緩和に取り込む（[Shield のインフラストラクチャの層の検知](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-event-detection-infrastructure.html)、[Shield Advanced の EIP の緩和](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-event-mitigation-logic-adv-eip.html)、2026-09-27 に確認）。ENA の上限まで余白（点 0.7）を残す。
- **攻撃の兆候**：Node の受信の bps・pps が平常の 5 倍、`pps_allowance_exceeded`・`bw_in_allowance_exceeded` の増加、ICE を通らない送信元からの受信の割合の増加。
- **対処の順**：
  1. 攻撃を受けた Node で防御のモード（`under_attack`）を入れる。ICE を通った送信元だけを通し、STUN の Binding は毎秒の上限つきで通す。防御のモードの Node は IPv6 の候補を出さない（Shield Advanced が IPv6 を守れないため。[network-traversal.md](network-traversal.md) の 9 節、ADR-0045 の注記）。
  2. 攻撃を受けた範囲の EIP を、Shield Advanced の保護に加える。SRT に連絡する（Business 以上のサポートが要る）。
  3. 防御のモードでも ENA の上限を超える Node は `draining` にし、会議を別の Node へ make-before-break で移す。
  4. 攻撃を受けた EIP は、会議がなくなったら外し、7 日は新しい Node に付けない。
  5. IPv6 の範囲だけが攻撃されるときは、`media.ipv6_candidates` を切る（Shield Advanced は IPv6 を守れない）。
- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md) の「メディアの IP への DDoS」。

## 9. データのライフサイクル

方針は [ADR-0046](../decisions/0046-audit-logs-and-data-lifecycle.md)。**期間はすべて既定案で、法務の確認（L2・L4・L6・L8）で確定する。**

| データ | 保持（既定案） | 期限後 | 決めた領域 |
| --- | --- | --- | --- |
| 会議の設定（`meetings`） | 主催者が消すまで。時刻の決まっていない会議（`recurring_no_fixed_time`・PMI の旧番号）は `expires_at`（最後の開催から 365 日） | 削除 | [scheduling-and-calendar.md](scheduling-and-calendar.md) |
| 開催と参加の記録（`meeting_instances`・`meeting_participations`） | 12 か月 | 削除（集計は残す） | [accounts-and-admin.md](accounts-and-admin.md) の 6.3 節 |
| 利用の集計（`usage_daily` など） | 36 か月 | 削除 | 同上 |
| 会議の中の状態（Valkey のスナップショット） | 24 時間（TTL） | 自動 | [signaling-and-meetings.md](signaling-and-meetings.md) |
| チャット（会議の間） | 会議の終了から 24 時間 | 自動 | [chat-and-reactions.md](chat-and-reactions.md) |
| チャット（`save_chat` のとき） | 組織の設定（既定 90 日） | 削除 | 同上 |
| 録画・文字起こし | 組織の設定（既定 365 日）＋ごみ箱 30 日 | S3 から削除（バージョンも） | [recording-and-transcription.md](recording-and-transcription.md) の 6.3 節 |
| 録画の生の区切り | 合成の成功から 7 日（失敗は 30 日） | 削除 | 同上 |
| 報告（`abuse_reports`） | 1 年。報告に添えた生の IP の暗号文は 90 日 | 削除 | [meeting-security.md](meeting-security.md) |
| 電話の通話の記録（`phone_calls`。MVP の後） | 12 か月。発信者の番号はハッシュと下 4 桁だけ | 削除 | [telephony.md](telephony.md) |
| Webhook の配送の記録（`webhook_deliveries`） | 7 日 | 削除 | [api-and-webhooks.md](api-and-webhooks.md) |
| 退出させた人の ban（`meeting_removals`） | 最後の開催から 30 日 | 削除 | [meeting-security.md](meeting-security.md) の 6.1 節 |
| 監査ログ（3 系統） | DB に 1 年、log-archive に 7 年 | 削除 | この文書 |
| Media Node・TURN・ALB・WAF のログ（IP を含む） | 30 日 | 自動 | この文書 |
| アプリのログ（内容と IP を含めない） | CloudWatch Logs 30 日、log-archive 13 か月 | 自動 | [observability.md](observability.md) |
| 品質の生の記録（参加者ごと 10 秒） | 30 日 | 自動（S3 のライフサイクル） | [observability.md](observability.md) |
| 参加ごとの品質の要約（`participant_quality_summaries`） | 12 か月 | 削除 | [observability.md](observability.md) |
| E2EE の資格情報の記録（`e2ee_credentials`） | 1 年 | 削除 | [e2ee.md](e2ee.md) |
| 同意（`capture_consents`） | 開催と同じ 12 か月。録画・文字起こしが残る間は残す | 削除 | [data-model/recording.md](data-model/recording.md) |
| 録画の再生の記録（`recording_access_events`） | 12 か月 | 削除 | 同上 |
| 録画の削除の記録（`recording_deletions`） | 7 年 | 削除 | 同上 |
| チャットのファイル（`chat_files`）と報告の添付 | チャットと同じ・報告と同じ | 削除（S3 も） | [data-model/meeting-runtime.md](data-model/meeting-runtime.md)、[data-model/safety.md](data-model/safety.md) |
| 全体の端末の ban（`global_device_bans`） | 90 日＋ 30 日 | 削除 | [data-model/safety.md](data-model/safety.md) |
| 会議の番号の履歴（`meeting_number_history`） | 再使用の禁止の 2 年の後、1 年ごとに削除 | 削除 | [data-model/scheduling.md](data-model/scheduling.md) |
| カレンダーの接続（`calendar_connections`） | 取り消しから 30 日 | 削除 | 同上 |
| 冪等のキー（`api_idempotency_keys`） | 24 時間 | 削除 | 同上 |
| 招待（`invitations`）、セッション・OTP（`sessions`・`verifications`） | 失効から 30 日、期限まで | 削除 | [data-model/identity.md](data-model/identity.md) |
| OAuth のトークン・許可（`oauth_tokens`・`oauth_grants`） | 失効・取り消しから 30 日 | 削除 | [data-model/platform-api.md](data-model/platform-api.md) |
| レポートの書き出し（`report_exports`） | 7 日 | 削除（S3 も） | [data-model/governance.md](data-model/governance.md) |
| リーガルホールド（`legal_holds`）、サポートの参照の許可（`support_access_grants`） | 解除から 7 年、期限から 1 年 | 削除 | 同上 |
| outbox | 送ってから 24 時間 | 削除 | 同上 |
| バックアップ（Aurora） | 35 日 | 期限で消える | [infrastructure.md](infrastructure.md) |

- リーガルホールドは、保持の期限に優先する。
- 組織の削除：猶予の後、組織の全行と S3 の実体を消す（[accounts-and-admin.md](accounts-and-admin.md)）。バックアップからの消去は、バックアップの期限（35 日）で終わる。

## 10. セキュリティの試験

| 種類 | 対象 | 頻度 | 合否 |
| --- | --- | --- | --- |
| SAST、シークレットスキャン、依存・イメージ・IaC の検査 | 全体（C++ の worker を含む） | PR、毎日 | High 以上 0 件（他の題材と同じ） |
| 組織をまたぐ読み取りの拒否 | API のすべての読み取り（会議、録画、レポート、チャット） | PR | 全件で 404 か 403 |
| E2EE の暗号文の確認 | Media Node が受けたペイロードが SFrame で、鍵がサーバーのどこにもない（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)） | E2EE に触れる PR、夜間 | 全件 |
| E2EE の会議で録画・字幕・電話を拒否 | API・Actor・Media Node | PR | 全件で拒否 |
| TURN の踏み台の試験 | Media Node の範囲の外、VPC の中、169.254.169.254、127.0.0.1 への `CreatePermission` | PR（TURN の設定）、本番で毎日の合成の試験 | 全件 403 |
| メディアのファジング | mediasoup の worker の RTP・RTCP・STUN・DTLS の受け口、RED の剥がし（[ADR-0017](../decisions/0017-opus-dtx-fec-red.md)） | PR（短）、夜間（長） | 異常終了 0 |
| シグナリングのファジング | Zod のスキーマの境界、Gateway の上限 | PR | 500 と接続の異常な保持が 0 |
| 秘密・内容の出力の走査 | テストのログ、本番のログ（パスコード、参加の鍵、チャットの本文の形） | CI、本番は常時 | 0 件 |
| DAST | staging の Web と API | 夜間とリリース前 | High 以上 0 件 |
| 外部のペンテスト | Web、API、シグナリング、Media Node の受け口、TURN、E2EE | E12 と、その後は年 1 回 | Critical・High がすべて修正済み |
| 防御のモードの試験 | Media Node への参加者でない送信元からの洪水（`media-lab`） | Media Node の変更の時、四半期 | 既存の参加者の途切れなし（ADR-0045） |
| IAM・ネットワークの静的検査 | Terraform | PR | [infrastructure.md](infrastructure.md) の 9 節の条件 |

## 11. 脆弱性の管理

他の題材の期限（Critical：緩和 24 時間・修正 7 日、High：30 日）を使う。加えて次のとおり。

- **会議の内容の漏えい、他の組織の会議への参加、E2EE の約束の破れ、TURN の踏み台につながる脆弱性は、CVSS にかかわらず Critical** とする。
- mediasoup、coturn、OpenMLS、libwebrtc（アプリ）、ブラウザの WebRTC の脆弱性は、公開から 24 時間以内に影響を判定する。Media Node と TURN の修正は、急ぎの入れ替え（[ADR-0055](../decisions/0055-media-node-rolling-replacement.md)）で出す。
- 上流に取り込まれていない mediasoup の変更（RED など）は、上流の修正を取り込むときの差分の試験を必須にする。

## 12. インシデントへの対応

- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md)。
- **調査のために会議の内容を取り出さない。** パケットの取得はヘッダーまで、録画を運用者が開くのは組織の許可があるときだけ。
- **個人データの漏えい等のおそれ**のとき、個人情報保護委員会への報告と本人への通知の要否、報告の主体（組織か本システムか）は法務が判断する。他の題材で確かめた期限の目安は、速報が概ね 3〜5 日以内、確報が 30 日以内（不正の目的によるものは 60 日以内）（Stripe の [security.md](../../../stripe/docs/architecture/security.md) の 12 節）。
- 通信の秘密の侵害のおそれ（内容や通信の構成要素の漏えい）は、電気通信事業法の上の扱いを法務が判断する（L1・L2）。
- 検知の源：GuardDuty、Security Hub、ENA の超過とメディアの受信の急増、秘密・内容の出力の走査、KMS の操作のアラート、TURN の拒否の急増、報告（`abuse_reports`）の急増、外部からの報告。
- 訓練は年 1 回（メディアの IP への DDoS と、録画の漏えいの机上訓練を含む）。

## 13. 法務の論点（法務の確認待ち）

**結論は出さない。** 設計は、どの結論にも対応できる形にする。下の表の「止まるもの」は、確認が済むまで PM・QA が承認しない。全体の一覧は [intent.md](../intent.md) の「法務の確認待ち」にある。

| # | 論点 | security の領域の設計への影響 | 止まるもの |
| --- | --- | --- | --- |
| L1 | 電気通信事業の登録か届出か。届出の時期。特定利用者情報の規律が将来かかるか | 9 節の保持、12 節の報告の手順、`media-prod` の管理の体制の文書化 | E2 の社外への公開（ベータを含む） |
| L2 | 通信の秘密：サーバーが平文のメディアを扱うこと（SFU、録画、字幕）、品質の診断の範囲、濫用の調査で内容に触れてよいか | ADR-0047（会議に見えない形で入らない、パケットの取得をヘッダーまで）、ADR-0051（数値だけ） | E8 の録画・字幕、E1 の品質の計測で内容を含むもの（含まない設計にしている） |
| L2 | 通信の構成要素（参加の記録、IP、品質の記録）を、どの目的でどれだけ持ってよいか | 9 節の保持、ADR-0046 | E12 の GA の判定 |
| L4 | 捜査機関への対応：通信の傍受の要請、記録の照会（会議の記録、参加者の IP）。E2EE の会議で応じられないことの扱い。30 日を過ぎた IP で応じられないことの扱い | 9 節、プラットフォームの監査、`recording-legal-hold.md` の手順 | E9 の E2EE の一般への提供、E12 の GA の判定 |
| L5 | 外部送信規律：品質の数値（`qos.report`）の送信の公表 | [ADR-0051](../decisions/0051-qos-telemetry-pipeline.md) の項目の一覧 | E2 の Web クライアントの公開 |
| L6 | データの所在（東京・大阪、CloudFront・WAF のログ、Transcribe）、音声認識の委託、保持の期間 | 9 節、[infrastructure.md](infrastructure.md) の 1 節の SCP | E1 のリージョンの構成、E8 の音声認識のエンジンの選定 |
| L8 | DPA、サブプロセッサーの一覧（AWS、音声認識、メール）、録画の開示・削除の請求の窓口 | 9 節、7 節 | E12 の GA の判定 |
| 新 | DDoS の対処で、攻撃を受けた Node の会議を別の Node へ移すこと、防御のモードで新しい参加者の一部が入れなくなりうることを、約款でどう書くか | ADR-0045 | E12 の GA の判定 |

## 14. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `accounts-media-prod` | `media-prod`・`media-staging`・`media-lab` のアカウント、SCP、ピアリング（[infrastructure.md](infrastructure.md)） |
| E1 | `kms-key-hierarchy` | 5 節・ADR-0047 の KMS の鍵、キーポリシーの文脈の条件、Terraform の検査 |
| E1 | `audit-log-three-streams` | 6 節の 3 系統、outbox、log-archive、ハッシュの連鎖の検証 |
| E1 | `content-leak-scanner` | 秘密・内容の出力の走査（CI と本番） |
| E1 | `operator-access-media-prod` | 期限つきのシェル、パケットの取得の制限、監査 |
| E2 | `turn-relay-restriction-tests` | 10 節の踏み台の試験、本番の毎日の合成の試験 |
| E2 | `cross-org-read-denial-suite` | 組織をまたぐ読み取りの拒否の試験 |
| E3 | `abuse-quotas` | 8.1 節の会議の数・人数・ゲストの上限 |
| E7 | `media-node-under-attack-mode` | ADR-0045 の防御のモード（`nftables` の集合、STUN の上限） |
| E7 | `shield-advanced-onboarding` | 入口の保護、EIP の一時的な保護の自動化、SRT の連絡の準備 |
| E7 | `media-fuzzing` | 10 節のメディアのファジング |
| E10 | `retention-jobs` | 9 節の保持の期限の削除のジョブと、毎日の監査 |
| E12 | `pentest-and-tabletop` | 外部のペンテスト、DDoS と録画の漏えいの机上訓練、`security.txt` |

## 15. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。保持の期間は法務の確認を待つ。

- **DDoS**：Shield Advanced で入口を常に守り、メディアの EIP は攻撃のときだけ（ADR-0045）。
- **監査ログ**：3 系統、DB 1 年・log-archive 7 年（ADR-0046）。
- **IP**：ログに 30 日。Aurora にはハッシュと報告の暗号文だけ（ADR-0046）。
- **鍵**：用途ごとの KMS の鍵と `org_id` の文脈。BYOK は MVP の後（ADR-0047）。
- **運用者**：`media-prod` の分離、会議に見えない形で入る機能を作らない（ADR-0047）。
- **サポートによる組織のデータの参照**：組織の `owner` か `admin` が、問い合わせごとに、対象（録画・チャット）と期限（最長 7 日）を決めて許可する。許可と参照は、組織の監査とプラットフォームの監査の両方に残す。
- **契約のない組織の上限**：個人で登録した組織など、契約のない組織は、同時の会議 1 つ、1 会議 100 人、1 回 60 分までにする（8.1 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Shield Advanced の EIP の保護を攻撃のときに加えた直後の緩和の振る舞い（事象の報告は保護から 15 分以上たってから。[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) の注記） | E7 の `shield-advanced-onboarding` で、SRT への問い合わせと `media-lab` の試験で確かめる |
| BYOK | MVP の後の Epic |

## 16. quality.md・runbooks への項目

### quality.md

- 10 節の試験の一覧と頻度。拒否の側の試験の件数の推移。
- 秘密・内容の出力の走査の検出の数（0 であること）。
- 保持の期限を過ぎたデータの件数（毎日の監査で 0）。
- 防御のモードの試験の結果（既存の参加者の途切れ）。

### runbooks

- [incident-response.md](../runbooks/incident-response.md)：共通の進め方と、メディアの IP への DDoS、TURN の過負荷（この文書で書いた）。
- `abuse-report-surge.md`：報告の急増（荒らしの波）のときの、Trust & Safety の体制と、推測の防御の強化。
- `content-leak-detected.md`：ログ・トレースに会議の内容や秘密が出たときの、出力の停止、消去、影響の判定。
- `law-enforcement-request.md`：捜査機関からの照会の受付と、法務への回付（L4 の結論の後に中身を書く）。
- `shield-eip-protection.md`：EIP の保護の付け外しの手順（incident-response の節から切り出す）。
