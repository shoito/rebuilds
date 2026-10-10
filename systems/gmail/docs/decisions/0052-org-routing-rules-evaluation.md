---
status: accepted
date: 2026-10-10
---

# ADR-0052: 組織の配送の規則は、受信・送信の 2 つの段ごとに順序の決まった規則の列とし、条件（宛先・送り手・組織の単位・ドメイン・大きさ）と動作（分けた配送、送信のゲートウェイ、全受け、写しの宛先の追加、送信のフッター、外への送信の禁止）を決定表 DT-ORG-001 で合わせる。送信のフッターは DKIM の署名の前に text の葉の終わりに足し、署名・暗号化された形には足さない。分けた配送と送信のゲートウェイも `outbound-gate` を通す

詳細は [organizations-domains-and-routing.md](../architecture/organizations-domains-and-routing.md) の 8 節。

## Context

- 組織は、移行の期間の分けた配送（本システムにいない宛先を旧いサーバーへ）、外への送信の記録・暗号化の製品（送信のゲートウェイ）、全受け、監査の写し、免責の文（フッター）を求める（[intent.md](../intent.md) の「組織」）。
- 利用者のフィルターは組織の規則の後に当てる（[ADR-0047](0047-user-filter-evaluation.md)）。組織の規則の評価の順序と合わせ方を決める必要がある。
- 受け取ったバイトは変えない（[ADR-0003](0003-message-storage-layout-and-dedupe.md)）。送信のバイトを変えると、DKIM の署名と S/MIME の署名が壊れる。
- 送信は必ず評判の関門を通す（`AGENTS.md`）。分けた配送と送信のゲートウェイは、本システムの IP から外の機械へ送る。
- 分けた配送の先が拒んだときの DSN は、受け付けた後の DSN になる。後方散乱を作らない（[ADR-0002](0002-accept-then-filter.md)）。

## Options

1. **段ごとの順序の決まった規則の列と、動作の合わせの決定表**
2. Sieve のような汎用の規則の言語で組織が書く
3. 規則の種類ごとに別の設定（分けた配送の設定、フッターの設定、…）

## Decision

1 を採用する。

- 段：`inbound`（選別とグループの展開の後、利用者のフィルターの前）と `outbound`（関門の後、DKIM の署名の前）。各段 200 規則まで。上から評価し、「終わる」動作（`split_delivery` の組織にない宛先、`catch_all`、`block_external`）で止める。`add_recipient` は重ねて当て、`footer` は最初の 1 つだけ。
- 分けた配送：`domains.unknown_rcpt = route` で RCPT の「ない宛先」を 250 にし、`forward` のプールから封筒を変えずに主機へ送る。TLS と証明書の名前の検証を既定で求める。主機の 5xx の DSN は、MAIL FROM が SPF か DKIM で確かめられたときだけ返す。
- 送信のゲートウェイ：関門と DKIM の署名の後、組織のプール（`org-a`・`org-b`）から主機へ送る。落ちていても MX に回さない。
- フッター：最初の `text/plain` の葉の終わりと、最初の `text/html` の葉の `</body>` の前に足す。`multipart/signed`、`application/pkcs7-mime`、`multipart/encrypted` には足さず `footer_skipped` を記録する。送信済みの写しは足す前の形。
- 規則の変更は `version` を進め、60 秒以内に配送の道に効く。

### 他の案を選ばなかった理由

- **2**：組織の管理者に言語を書かせることになり、誤りの検査（終わる動作の後の規則、ループ）が難しい。利用者のフィルターでも Sieve を中の形式に使わない（[ADR-0047](0047-user-filter-evaluation.md)）。
- **3**：動作の間の順序（全受けと分けた配送のどちらが先か）が設定の間で決まらず、試験の組み合わせが増える。

## Consequences

- 良くなること：
  - 組織の規則の順序と合わせが 1 つの決定表で決まり、表駆動テストで確かめられる。
  - 分けた配送と送信のゲートウェイも関門と評判のプールを通る。
  - フッターで署名を壊さない。
- 引き受けるコスト：
  - 分けた配送の主機の応答で、宛先の探りを数える仕組みが要る。
  - フッターの HTML の位置を決めるため、HTML5 の構文解析を `outbound-gate` で使う（[ADR-0062](0062-generic-components-additions-and-supply-chain.md)）。
  - 送信のゲートウェイが中身を変えると DKIM が壊れることを、組織に案内で知らせる。

## Confirmation

- 表駆動テスト：DT-ORG-001（動作の合わせ）。
- 結合：分けた配送（`smtp-peer-sim` の主機の 4xx・5xx・TLS の失敗）、フッターの後の DKIM の検証、S/MIME の形の素通り。
- 試験：後方散乱 0（分けた配送の DSN が、確かめられない MAIL FROM に送られない）。
