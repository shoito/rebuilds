---
status: accepted
date: 2026-09-27
---

# ADR-0028: 資格情報は論理クラスタに絞った API キーにし、SASL/PLAIN を TLS の上で使い、検証用のハッシュを内部のトピックで配る

## Context

テナントのアプリは、既存の Kafka のクライアントのまま接続する（intent.md の価値 1）。クライアントの設定を変えずに使える認証の機構と、キーの形、ブローカーでの検証の方式を決める。

事実（いずれも 2026-09-27 に確認）：

- 本家の Apache Kafka は、SASL/PLAIN を TLS の上だけで使うよう求め、本番では `sasl.server.callback.handler.class` で外部の資格情報を確かめるよう勧める（[Authentication using SASL](https://kafka.apache.org/43/security/authentication-using-sasl/)）。
- Confluent Cloud は、キーの ID を SASL の利用者名に使い、秘密を作成時に 1 回だけ表示する。クラスタに絞ったキーと、管理の API 向けのキーを分ける（[API keys](https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/service-accounts/api-keys/overview.html)）。OAUTHBEARER は Standard 以上（[OAuth overview](https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/identity-providers/oauth/overview.html)）。
- 本家の再認証（KIP-368）は `connections.max.reauth.ms` で有効になり、期限を過ぎて再認証しない接続をブローカーが切る。既定は 0（無効）（[KIP-368](https://cwiki.apache.org/confluence/display/KAFKA/KIP-368%3A+Allow+SASL+Connections+to+Periodically+Re-Authenticate)）。
- [ADR-0003](0003-kraft-metadata-and-cluster-placement.md) は、API キーの正本を制御面（ハッシュだけ）にし、ブローカーは制御面から配られた情報で確かめるとした。方式はこの領域に任された。
- [protocol-and-compatibility.md](../architecture/protocol-and-compatibility.md) は、SCRAM の資格情報の API と委任トークンを拒否し、機構は PLAIN だけを有効にするとした。

## Options

機構：

1. **SASL/PLAIN（TLS の上）。利用者名＝キーの ID、パスワード＝秘密**
2. SASL/SCRAM。資格情報を KRaft に入れる
3. mTLS（クライアント証明書）
4. OAUTHBEARER だけ

検証の方式：

- A. **制御面が物理クラスタごとの内部のトピックにハッシュを配り、ブローカーはメモリーのキャッシュで確かめる**
- B. ブローカーが接続のたびに制御面の API を呼ぶ（結果は短くキャッシュ）
- C. SCRAM の資格情報として KRaft に入れる（2 と組む）

## Decision

1 と A を採用する。OAUTHBEARER は S2 で足す。詳細は [security-and-acls.md](../architecture/security-and-acls.md) の 3・4 節にある。

- **キーの形**：キーの ID は `<brand>_key_` ＋ base32 の 20 文字、秘密は `<brand>_sec_` ＋ base62 の 43 文字（256 ビット）＋ CRC32 の 6 文字。接頭辞はリポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い、GitHub のシークレットスキャンのパートナープログラムに登録する。
- **範囲**：キーは 1 つの論理クラスタ、または管理 API、または（S2）1 つのスキーマレジストリに絞る。複数の論理クラスタに入れるキーは持たない。
- **保存**：制御面は秘密の SHA-256 だけを持つ。秘密は作成時に 1 回だけ表示する。
- **配布**：データ面のエージェントが、その物理クラスタの論理クラスタのキーだけを、内部の圧縮のトピック `__<brand>_credentials` に書く。ブローカーの SASL/PLAIN のコールバックは、このトピックを読んだキャッシュで、定数時間で比べる。記録に論理クラスタの ID と `cluster_role` を持たせ、KafkaPrincipalBuilder と Authorizer が使う。
- **反映の目標**：作成・失効とも、新しい接続に 60 秒以内。既存の接続は `connections.max.reauth.ms=900000`（15 分）の再認証で失効する。
- **利用者のキー**：利用者が組織を抜けたら、その人のキーを失効する。本番のアプリにはサービスアカウントを勧める。

2 を選ばない理由：SCRAM は接続のたびに反復のハッシュを計算し、利用者にもクライアントの SCRAM の設定を求める。資格情報を KRaft に入れると、テナントの数だけ KRaft のメタデータが増え、制御面の正本（ADR-0003）と 2 か所になる。

3 を選ばない理由：利用者に証明書の発行と更新の運用を求め、SC-3（5 分で最初のメッセージ）に届かない。SNI のプロキシは TLS を終端しないので、将来 Dedicated で足すことはできる。

4 を選ばない理由：IdP を持たない小さなテナントが使えない。

B を選ばない理由：接続の数（再接続の嵐を含む）が制御面の負荷になり、制御面の障害がデータの経路に及ぶ（ADR-0003 の原則に反する）。

## Consequences

- 良くなること：
  - すべてのクライアントが、標準の設定（`security.protocol=SASL_SSL`、`sasl.mechanism=PLAIN`）で接続できる。
  - 制御面が落ちても、既存のキーで接続できる。
  - 漏れたキーの範囲は 1 つの論理クラスタに限られ、シークレットスキャンで見つけやすい。
- 引き受けるコスト：
  - 資格情報の内部のトピックと、ブローカーのキャッシュを、自前で作って保つ。キャッシュが古いと、認証を誤る。
  - 失効が既存の接続に届くまで最長 15 分かかる。急ぎの失効の仕組みは E8 の PoC で決める。
  - 長寿命の秘密を使う。OAUTHBEARER（S2）までは、短命の資格情報を選べない。

## Confirmation

- 結合テスト：キーの作成から 60 秒以内に接続でき、失効から 60 秒以内に新しい接続が失敗し、15 分以内に既存の接続が切れる。
- 性質ベーステスト：任意の順序・重複で配った資格情報の記録について、ブローカーのキャッシュの最終の状態が制御面と同じ。
- 起動のテスト：ブローカーは、内部のトピックを読み終えるまでテナントの接続を受けない。
- ログの走査：秘密が、作成の応答以外（ログ、トレース、監査ログ、内部のトピック）に出ない。
