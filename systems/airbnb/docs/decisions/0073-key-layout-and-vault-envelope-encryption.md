---
status: accepted
date: 2026-10-10
---

# ADR-0073: KMS の鍵を用途ごとに分け、vault の列と旅券の画像を主体ごとのデータの鍵で封筒の暗号化にする。主体は位置がリスティング、名簿と旅券が（届出住宅、年度）、口座がホストのアカウント、本人確認と連絡先が利用者。復号の権限は持ち主のサービスの役割だけに置き、消去は主体の鍵の破棄で行う

## Context

- [ADR-0001](0001-platform-and-stack.md) は、正確な住所と位置、宿泊者名簿、旅券の番号と画像の参照、送金の口座、本人確認の結果を vault のクラスタに置き、封筒の暗号化で持ち、4 つのサービス（`listings`、`compliance-jp`、`identity`、`payouts`）だけが接続すると決めた。鍵の分け方と主体の単位は決めていない。
- 名簿は住宅宿泊事業者が作成日から 3 年保存する（観光庁の [住宅宿泊事業者の義務](https://www.mlit.go.jp/kankocho/minpaku/business/host/index.html)、2026-10-10 に確認）。旅券の画像は大きく、DB でなく S3 に置く。保存の上限と扱いは法務の確認待ち（L3・L8）。
- 1 つのサービスの侵害で、他の用途の vault のデータが読めてはならない。人（運用者、break-glass）が vault の平文を直接読めてはならない（[security.md](../architecture/security.md) の T5・T7）。
- 期限で消すとき、行ごとの削除はバックアップとレプリカに残る。鍵の破棄なら、暗号文が残っても読めなくなる。
- Mercari の題材は、用途ごとの KMS の鍵と利用者ごとのデータの鍵を決めた（[Mercari の ADR-0069](../../../mercari/docs/decisions/0069-key-layout-and-vault-envelope-encryption.md)）。この題材は、名簿のように主体が利用者でないデータを持つ。

## Options

1. **用途ごとの KMS の鍵と、主体ごとのデータの鍵（主体は用途で決める。名簿は届出住宅と年度）**
2. 用途ごとの KMS の鍵で、行ごとに KMS で直接暗号化する（データの鍵なし）
3. vault のクラスタの保存時の暗号化だけに頼る

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 5 節。

- **用途の鍵**：`kms-vault-location`（`listings`）、`kms-vault-registry`（`compliance-jp`）、`kms-vault-kyc`（`identity` の本人確認の Worker）、`kms-vault-bank`（`payouts`。事業者のホストの所在地は `identity` が別の文脈で使う）、`kms-contact-pii`（`identity`、`notifier` の送信）、`kms-pms-secrets`（`partner-api`、`webhook-sender`）。保存時の暗号化は `kms-core`・`kms-ledger`・`kms-content`・`kms-vault-storage`。他に `kms-audit`、`kms-lake`、`kms-secrets`、`kms-ops-exports`。
- **主体の鍵**：用途ごと・主体ごとの 256 ビットの鍵を、用途の KMS の鍵で包んで `subject_keys` に置く。主体は、位置＝リスティング、名簿と旅券＝（届出住宅、年度）、口座＝ホストのアカウント、本人確認・連絡先＝利用者。
- **行の暗号**：AES-256-GCM、行ごとの 96 ビットの nonce、追加の認証データ（用途、主体、行の ID、列の組のバージョン）。
- **旅券の画像**：画像ごとのデータの鍵で暗号化し、それを主体の鍵で包んでオブジェクトの付帯の情報に置く。S3 は `kms-vault-storage` の SSE-KMS も掛ける。署名つきの URL を出さない。
- **権限**：鍵の政策で、`kms:Decrypt` を持ち主のサービスの役割と暗号化の文脈（`purpose`）の組に限る。人の権限のセットに置かない（plan のポリシー検査）。
- **キャッシュ**：平文の主体の鍵は持ち主のタスクのメモリーに 5 分・1 万件だけ。
- **消去**：主体の鍵の行を消す。名簿は年度の鍵を保持の期限の後に破棄して、その年度をまとめて消す（自動の破棄は法務の結論の後。[ADR-0075](0075-data-classes-and-retention.md)）。バックアップ（35 日）の後に完全に読めなくなる。
- **大阪**：用途の鍵は複数のリージョンの鍵にする。

### 他の案を選ばなかった理由

- **2（行ごとの KMS）**：名簿の画面、検索の後の正確な位置の確かめで KMS の呼び出しが行の数だけ増え、費用と速さの上限に当たる。主体の単位でまとめて消せない。
- **3（保存時の暗号化だけ）**：DB に接続できる役割と break-glass の人が平文を読める。用途の分離がない。

> 2026-10-10 の注記：データモデルの工程で、取り込む iCal のアドレス（秘密の URL を含む）を `kms-pms-secrets` の鍵の暗号化の文脈 `ical-url` で暗号化して持つことにした。復号するのは DB に接続しない `ical-fetcher` だけで、人の役割には復号の権限を置かない（[data-model.md](../architecture/data-model.md) の D-30）。鍵の階層は変えていない。

## Consequences

- 良くなること：
  - 1 つのサービスの侵害で読めるのは、その用途の、その間に扱った主体だけ。
  - 名簿を年度ごとの鍵の破棄で、行と画像をまとめて消せる。
  - 人は vault の平文を直接読めない。
- 引き受けるコスト：
  - `subject_keys` の管理と、鍵の交換の時の包み直し。
  - 年度の鍵は、その年度の全部の名簿に効くので、1 つの主体の鍵の漏れの範囲が 1 つの届出住宅の 1 年分になる。
  - 旅券の画像を画面に出すとき、持ち主のサービスが復号して透かしを入れる処理が要る。

## Confirmation

- 性質ベーステスト：行を別の主体・行へ写した暗号文は復号できない（PROP-SEC-001）。破棄した鍵の行と画像は読めない（PROP-SEC-002）。
- plan のポリシー検査：vault の用途の鍵の `kms:Decrypt` が持ち主の役割にだけある。vault のクラスタへの接続が 4 サービスだけ。
- E20 の外部のペンテストで vault の経路を確かめる。
