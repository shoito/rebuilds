# Update and release: Chrome

チャンネルと周期、リリースのブランチ、更新のクライアントとサーバー、段階的な配信と自動の停止、差分の更新、コード署名と鍵の保管、緊急のセキュリティ修正、クラッシュの収集、テレメトリとフィールドトライアル。

| 対象 | 方針 |
| --- | --- |
| チャンネルと周期 | [ADR-0004](../decisions/0004-release-channels-and-updates.md) |
| 更新のプロトコルとアップデータ | [ADR-0029](../decisions/0029-updater-protocol-and-staged-rollout.md) |
| ビルドと成果物 | [ADR-0030](../decisions/0030-build-system.md)、[build-and-test.md](build-and-test.md) |
| CI の段とリリースのブランチ | [ADR-0031](../decisions/0031-ci-tiers-wpt-and-release-branches.md) |
| クラッシュ・テレメトリのプライバシー | [ADR-0005](../decisions/0005-privacy-first-services.md)、[ADR-0032](../decisions/0032-crash-and-telemetry-privacy.md) |
| サービスの基盤、署名の鍵の保管 | [ADR-0033](../decisions/0033-service-infrastructure-and-dr.md)、[infrastructure.md](infrastructure.md) |
| 手順 | [runbooks/bad-release-rollback.md](../runbooks/bad-release-rollback.md)、[runbooks/emergency-security-release.md](../runbooks/emergency-security-release.md) |

原則は 3 つ。

- **修正を速く、全員に届ける。** 更新は既定で自動にし、止める手段（段階の凍結、機能の停止）を先に用意しておく。
- **更新の経路そのものを、攻撃の経路にしない。** サーバーが侵害されても、署名のない版を端末に入れられない（5 節）。
- **品質の判断に使うデータは、同意した利用者のものだけ。** 同意のない端末から送るのは、更新に欠かせない最小限の情報に限る（ADR-0005、ADR-0032）。

数値のうち「初期見積もり」と書いたものは、Canary の運用の前の仮の値である。公式の資料で確かめられないものは「未検証」と書く。

## 1. チャンネルと周期

| チャンネル | 元 | 周期 | 対象 |
| --- | --- | --- | --- |
| Canary | `main` の先端 | 毎日（自動） | 開発者、早く試したい人。Stable と並べて入れられる |
| Dev | `main` の、その週の Canary のうち良いもの | 毎週 | 開発者 |
| Beta | リリースのブランチ | 4 週ごと＋ブランチ中は毎週 | 早く試したい利用者、企業の検証 |
| Stable | リリースのブランチ | 4 週ごと＋毎週の修正の版 | 全員 |

- 周期は ADR-0004 のとおり 4 週とする。本家は 2026-09-08 の Chrome 153 から、Stable と Beta を 2 週ごとに変えた（[Chrome for Developers](https://developer.chrome.com/blog/chrome-two-week-release)、[Chromium の release cycle](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/process/release_cycle.md)）。2 週にすると、1 回のリリースは小さくなる。一方で、ブランチ・検証・承認の運用が倍になる。小さなチームで 4 週を安定して回せるようになってから、2 週にするかを判断する（S2 の前。判断したら ADR-0004 を置き換える ADR を書く）。
- 本家には、企業向けに 8 週ごとの Extended Stable がある（同上）。MVP では持たない。企業の管理者の要望が来たら検討する。
- 版の番号は `M.0.B.P`（M：マイルストーン、B：ブランチの番号、P：パッチ）。更新のプロトコルで比べられる 4 つ組にする。

### 1.1 マイルストーンの暦（4 週）

```
週 0          週 4 （ブランチ）         週 8（Stable）         週 12
main ─────────┬───────────────────────────────────────────────▶
              │ release/M を切る
              └─ Beta M（毎週） ─────────┬─ Stable M（段階配信）─ 修正の版（毎週）
                                         └─ 次の release/M+1 のブランチ
```

- ブランチを切ってから Stable まで 4 週。その間に Beta で毎週の版を出す。
- Stable を出す 1 週前に、Beta の最後の版を Stable の候補（RC）にし、Stable の 1% に出す（本家の early stable と同じ考え方。[release cycle](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/process/release_cycle.md)）。
- Stable M のブランチは、M+1 が Stable の 100% に達するまで保守する（重なりは 4 週）。

## 2. リリースのブランチ

リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md) は「リリースのためのブランチを作らない」とする。配布型のブラウザでは、Stable の修正の版に、4 週ぶんの新しい変更を混ぜられない。そこで、Chrome に限り、次の形のブランチを認める（[ADR-0031](../decisions/0031-ci-tiers-wpt-and-release-branches.md)）。

- `release/M` は、`main` のある 1 コミットからの**スナップショット**である。ブランチの上で開発しない。
- ブランチへの変更は、**先に `main` へ入れた修正の cherry-pick だけ**にする。`main` にない変更は入れない（ブランチでしか直せない場合は、release owner と Dev（テックリード）が承認し、理由を記録する）。
- cherry-pick の PR は、release owner（Ops のうち、そのマイルストーンの担当）が承認する。Beta の後半（ブランチから 3 週目以降）は、セキュリティ修正と、リリースを止めるほどの回帰の修正に限る。
- ブランチは保守の期間が終わったら、保護したまま読み取り専用にする。

## 3. 更新のクライアント（アップデータ）

### 3.1 構成

アップデータは、ブラウザとは別のプログラムにする。ブラウザが起動していなくても更新を確かめ、ブラウザの版が壊れていても自分を更新できるようにするため。本家の Chromium updater の設計に倣う（[Chromium updater の設計](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/updater/design_doc.md)）。

| OS | 導入の範囲 | 常駐の方式 | 権限の昇格 |
| --- | --- | --- | --- |
| Windows | システム（既定。管理者で導入したとき）またはユーザー | システム：サービス＋タスクスケジューラ。ユーザー：タスクスケジューラ | システムの導入は高い整合性レベルのサービスが行う。ブラウザからはサービスに IPC で頼む |
| macOS | システム（`/Applications` に入れたとき）またはユーザー | LaunchDaemon（システム）、LaunchAgent（ユーザー） | システムの導入は特権のヘルパーが行う |
| Linux | パッケージ管理（apt・dnf） | 独自の常駐はしない。OS のパッケージ管理が更新する | パッケージ管理に任せる |

- 本家の updater は、Windows で COM のサービス、macOS で LaunchDaemon・LaunchAgent を使い、約 5 時間ごとに、ばらつきを入れて更新を確かめる（上の設計文書）。同じ周期にする。
- **Linux は、本家と同じくパッケージのリポジトリで配る。** パッケージを入れると、リポジトリと署名の公開鍵が登録される（[Google の Linux リポジトリ](https://www.google.com/linuxrepositories/)）。更新はディストリビューションの自動更新の設定に依存するので、NFR-006 の達成が他の OS より遅れうる。ブラウザが自分の版の古さを検知したら（6 節の `urgency`）、更新を促す表示を出す。Flatpak・Snap での配布は MVP の後に検討する。
- アップデータの複数の版は並べて置けるが、動くのは 1 つだけにする。新しい版は、自分で動作を確かめてから有効になる（上の設計文書の qualification と同じ）。
- アップデータ自身も、同じプロトコルで更新する（アプリの ID を分ける）。

### 3.2 更新の適用

1. アップデータが更新を確かめ、差分（7 節）か全体をダウンロードする。
2. ハッシュ（リリースの署名に含まれる。5 節）とコード署名を確かめる。どちらかが合わなければ捨て、失敗のイベントを送る。
3. 新しい版を、今の版と並べて置く（Windows は版ごとのディレクトリ、macOS はバンドルの差し替えを次の起動時に行う）。
4. ブラウザが起動中なら、再起動を促す。再起動のときにタブを復元する。
5. 古い版は、新しい版が 1 回正常に起動してから消す。

### 3.3 再起動の促し方

更新はダウンロードしても、再起動するまで効かない。NFR-006 の達成は、再起動の率で決まる。

| 更新の `urgency` | 表示 | 自動の再起動 |
| --- | --- | --- |
| `normal` | 2 日後からツールバーに印。4 日後から印の色を強める | しない |
| `critical`（6 節） | すぐにダイアログで促す。「後で」は 1 時間後にもう一度 | 操作のない状態が 30 分続き、シークレットのウィンドウと、送信中のフォーム・ダウンロードがなければ、タブを復元できる形で再起動する |

- 企業の管理者は、ポリシーで再起動の促し方と期限を決められる（[browser-ui.md](browser-ui.md) の企業のポリシー）。
- 数値は初期見積もり。Canary・Beta で、再起動までの時間の分布を見て決め直す。

### 3.4 ロールバックとプロファイルの互換

- **基本は前へ進める（roll forward）。** 不具合は、修正の版を出すか、機能を止めて直す（10 節、[runbooks/bad-release-rollback.md](../runbooks/bad-release-rollback.md)）。
- 端末の版を下げる（ダウングレード）のは最後の手段とする。プロファイルの形式は、新しい版で書き換えた後でも、**1 つ前のマイルストーン**の版が読めるように保つ（[data-model.md](data-model.md) の 3 節）。この規則を守れない変更は、2 回のマイルストーンに分ける。

## 4. 更新のサーバーとプロトコル

### 4.1 プロトコル

本家の Omaha のプロトコル 4 と互換の形にする（[ADR-0029](../decisions/0029-updater-protocol-and-staged-rollout.md)）。プロトコル 4 は JSON で、更新の確認・ダウンロード・結果の報告の 3 段で進む。応答は CUP（Client Update Protocol）で署名され、TLS が破られても完全性を保つ。応答の中の「パイプライン」で、`download`・`zucc`（Zucchini の差分）・`puff`（Puffin の差分）・`crx3`・`run` などの操作を順に指定できる（[Omaha プロトコル 4](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/updater/protocol_4.md)）。旧版の 3 は XML だった（[Omaha プロトコル 3](https://github.com/google/omaha/blob/main/doc/ServerProtocolV3.md)）。

クライアントが送るもの（すべて）：

| 項目 | 例 | 理由 |
| --- | --- | --- |
| アプリの ID、今の版、チャンネル | `org.example.browser`、`130.0.6100.2`、`stable` | 次の版を決める |
| OS、アーキテクチャ、OS の版 | `win`、`x64`、`10.0.22631` | 対応する成果物を選ぶ |
| 配信の区画（rollout bucket） | 0〜999 の整数 | 段階的な配信（4.3）。端末で乱数から作り、変えない |
| 手元にある成果物のハッシュ（`cached_items`） | SHA-256 | 差分の元を決める（プロトコル 4 の仕組み） |
| 活動の日数の数え方（ping-freshness） | プロトコル 4 の形 | ID なしに、1 日あたりの活動中の端末を数える（プロトコル 4 の client-regulated counting） |
| 企業のポリシーの有無と、版の固定 | 管理下かどうか、固定する版の接頭辞 | 管理者の指定に従う |
| 前回の更新の結果（イベント） | 成功、エラーの種類、所要時間 | 配信の失敗を検知する |

- **永続の端末 ID を送らない。** セッション ID とリクエスト ID は、プロトコル 4 の要件どおり 128 ビット以上の乱数で、リクエストごとに作る。
- 配信の区画は 1,000 通りしかないので、端末の識別には使えない。IP アドレスは、レート制限のためだけに短時間扱い、保存しない（[observability.md](observability.md) の 5 節）。
- 更新の確認と結果の報告は、テレメトリの同意と無関係に送る。更新の機能そのものだからである。送る項目は上の表がすべてで、プライバシーの説明に公開する（ADR-0005、ADR-0032）。

### 4.2 サーバーの構成

```
アップデータ ─POST─▶ CloudFront ─▶ ALB ─▶ update-server（ECS、状態を持たない）
                                              │ 配信の設定をメモリに持つ（30 秒ごとに更新）
                                              ▼
                                         Aurora（リリース・配信の段階・停止の状態）
アップデータ ─GET──▶ CloudFront ─▶ S3（成果物：全体・差分。不変のパス）
アップデータ ─GET──▶ CloudFront ─▶ S3（静的な予備のマニフェスト。4.4）
rollout-guard（定期実行）─ AMP の指標を読む ─▶ 条件を外れたら配信を止める（4.3）
```

- update-server は、配信の設定を DB から読んでメモリに持つ。DB が止まっても、最後に読んだ設定で応答し続ける。
- 応答は区画ごとに変わるので、CDN でキャッシュしない。成果物は、内容のハッシュを含む不変のパスに置き、CDN で長くキャッシュする。
- 詳細な構成は [infrastructure.md](infrastructure.md)、負荷は [capacity.md](capacity.md)。

### 4.3 段階的な配信と自動の停止

ADR-0004 の段階（1% → 10% → 50% → 100%）で配る。区画が段階の割合より小さい端末にだけ、新しい版を返す。

| 段階 | 最低の滞在時間 | 次へ進む条件（すべて） |
| --- | --- | --- |
| 1% | 24 時間 | 新しい版の同意済みのセッションが 2 万以上。自動の停止の条件に当たらない |
| 10% | 24 時間 | 同上 |
| 50% | 24 時間 | 同上。release owner の承認 |
| 100% | — | — |

- **S1 では、セッションの数が段階を決める。** S1 の利用者は 10 万で、クラッシュの報告に同意する人の割合を 20%（初期見積もり）とすると、1% の段階の同意済みの利用者は約 200 人しかいない。これでは NFR-005（1,000 セッションあたり 0.5 件）の悪化を見分けられない。S1 では 1% の段階で時間ではなくセッション数を待ち、Beta の結果を重く見る。S2 以降は時間の条件が先に満たされる。
- **自動の停止（rollout-guard）。** 5 分ごとに、新しい版と、同じチャンネルの 1 つ前の版を比べる。次のどれかに当たったら、その版の段階を凍結する（新しい端末に配らない。すでに更新した端末はそのまま）。

  | 指標（同意済みの端末から。[observability.md](observability.md) の 3 節） | 停止の条件 |
  | --- | --- |
  | Browser プロセスのクラッシュ率（1,000 セッションあたり） | 前の版の 1.5 倍を超え、かつ 0.5 を超える（NFR-005） |
  | 起動直後（30 秒以内）のクラッシュ率 | 前の版の 2 倍を超える |
  | Renderer・GPU のクラッシュ率 | 前の版の 2 倍を超える |
  | 更新の失敗率（4.1 の結果のイベント。全端末） | 5% を超える |
  | 起動の時間 p75（NFR-001） | 前の版より 20% 以上遅い |

  - 比べるのは、同じ期間・同じ OS の組み合わせで、どちらも最低 5,000 セッションあるときだけにする。少ないうちは判定しない（進めもしない）。
  - 停止したら、release owner を呼び出す（[runbooks/bad-release-rollback.md](../runbooks/bad-release-rollback.md)）。再開は人が判断する。自動では再開しない。
  - 閾値は初期見積もり。Beta と Stable の最初の数回のリリースで、誤った停止と見逃しを見て決め直す。
- 企業のポリシーで版を固定した端末には、固定した範囲の外の版を返さない。

### 4.4 更新のサーバーが止まったとき

- アップデータは、主の URL が 3 回続けて失敗したら、予備の URL（別の CloudFront のディストリビューションと S3）から、チャンネルごとの静的なマニフェストを GET で取る。静的なマニフェストは「全員に配ってよい最新の版」だけを持ち、リリースの署名（5 節）で守る。
- CloudFront のオリジンのフェイルオーバーは GET・HEAD・OPTIONS にしか効かない（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)）。プロトコル 4 の更新の確認は POST なので、フェイルオーバーはクライアントの側で行う。
- 段階的な配信は、予備の経路では効かない。予備のマニフェストは、100% に達した版だけを載せる。

## 5. 署名と鍵の保管

### 5.1 信頼の連鎖

端末が新しい版を入れる前に、3 つの独立した署名を確かめる。

| 署名 | 何を守るか | 鍵 | 置き場所 |
| --- | --- | --- | --- |
| CUP の署名（ECDSA） | 応答が本物で、古い応答の再送でない | update-server の CUP 鍵。公開鍵はアップデータに埋め込み、鍵の番号で交換できる | update-server のメモリ（Secrets Manager から）。90 日で交換 |
| リリースの署名（ECDSA P-256） | 版・成果物のハッシュ・チャンネルの組が、リリースの工程を通ったもの | リリースの鍵。公開鍵はアップデータに埋め込む | release-signing アカウントの KMS（外に出せない）。リリースの工程だけが使う |
| OS のコード署名 | 実行ファイルが私たちのもの。OS の警告を出さない | 5.2 | 5.2 |

- update-server が侵害されても、CUP の鍵だけでは端末に新しい版を入れられない。リリースの署名が合わないため。
- リリースの署名は、KMS の非対称鍵で行う。KMS の HSM は FIPS 140-3 のレベル 3 の認証を受けていて、鍵の材料は HSM の外に出ない。ECC_NIST_P256 で署名できる（[AWS FIPS 140-3](https://aws.amazon.com/compliance/fips/)、[KMS の暗号](https://docs.aws.amazon.com/kms/latest/developerguide/kms-cryptography.html)）。
- フィールドトライアルの設定（12 節）と Safe Browsing のリスト（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)）も、別の KMS の鍵で署名し、公開鍵をブラウザに埋め込む。

### 5.2 OS のコード署名

| OS | 方式 | 鍵の保管 |
| --- | --- | --- |
| Windows | Authenticode。すべての実行ファイル・DLL・インストーラーに署名し、タイムスタンプを付ける | release-signing アカウントの CloudHSM。SignTool から KSP 経由で使う（[CloudHSM と SignTool](https://docs.aws.amazon.com/cloudhsm/latest/userguide/third-signtool-toplevel.html)） |
| macOS | Developer ID で署名し、Hardened Runtime を有効にし、セキュアなタイムスタンプを付ける。`notarytool` で公証し、チケットをステープルする（[Apple のドキュメント](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)） | 署名専用の EC2 Mac の上の、ハードウェアの鍵。方式は未検証（CloudHSM から `codesign` を使えるかは確かめていない。EC2 Mac には物理のスマートカードを挿せないので、方式は E9 の PoC で選び直す。決まるまで macOS の Stable は出さない） |
| Linux | apt・dnf のリポジトリのメタデータとパッケージに GPG で署名する | CloudHSM を PKCS#11 で使う想定。GnuPG から使う方式は未検証 |

- **コード署名の鍵は、ハードウェアの中で作り、外に出さない。** CA/Browser Forum の要件で、2023-06-01 から、コード署名の証明書の鍵は FIPS 140-2 レベル 2 以上の機器で作って保管することが求められる（[CA/Browser Forum の Code Signing Baseline Requirements](https://cabforum.org/working-groups/code-signing/requirements/)）。
- **SmartScreen の評判は時間をかけて貯まる。** EV の証明書でも、最初のダウンロードの警告は消えない。評判は、ファイルのハッシュと、署名の発行者の両方で貯まる（[Microsoft のドキュメント](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)）。したがって、署名の主体を変えない。証明書の更新は、同じ発行者の名前で、期限の 60 日前に行う。Canary から先に新しい証明書に切り替える。
- 署名の工程は、release-signing アカウントの中の、署名専用の CI の実行環境だけが行える（[infrastructure.md](infrastructure.md) の 1 節）。人が署名の鍵を使う経路はない。緊急時のロールは、2 人の承認で有効になり、使うたびに通知する。

## 6. 緊急のセキュリティ修正（NFR-006）

NFR-006：重大な脆弱性の修正を、Stable への配信の開始から 48 時間以内に Stable の 90% の利用者へ届ける。

- **起点と終点の解釈**：起点は、修正の版の Stable への配信の開始とする。終点は、直近 48 時間に活動した Stable の端末（4.1 の活動の数え方）のうち、修正の版が動いている割合が 90% に達した時刻とする。脆弱性の公表から配信の開始までの時間は、別の内部の目標（悪用が確認されたものは 24 時間以内、上流の部品の Critical・High は上流の公開から 3 日以内）で追う。この解釈は既定案として決めた（[README.md](README.md) の「決定」）。OS ごとの値も記録する。
- **対象**：重大度が Critical・High で、悪用が確認されたか、公表が迫っているもの。部品（V8 など。ADR-0002）の修正を含む。

### 6.1 流れと時間の予算

| 時刻 | すること | 誰が |
| --- | --- | --- |
| T−8h | 修正を `main` に入れる。コミットのメッセージは中立にし、Issue は非公開にする | Dev、セキュリティの担当 |
| T−6h | Stable・Beta のブランチに cherry-pick。緊急の CI（[build-and-test.md](build-and-test.md) の 4 節）で、3 OS のビルド・署名・スモーク | release owner |
| T−1h | Beta に配り、自動のスモークの結果を確かめる | release owner |
| T0 | Stable に `urgency=critical` で配る。10% で 1 時間、自動の停止の条件は「起動直後のクラッシュ率 3 倍」だけにする | release owner |
| T+1h | 100% | release owner |
| T+6h | 活動中の端末の大半がダウンロード済み（5 時間ごとの確認） | — |
| T+48h | 90% を確かめ、記録する（ADR-0004 の Confirmation） | Ops |

- ダウンロードは差分が主なので、CDN の帯域は S1・S2 では問題にならない。S3 では、全員が数時間に集中すると CloudFront のディストリビューションの既定の上限（150 Gbps）を超えうる（[capacity.md](capacity.md) の 2.1 節）。
- 手順は [runbooks/emergency-security-release.md](../runbooks/emergency-security-release.md)。

## 7. 差分の更新

- **Zucchini** で、実行ファイルの差分を作る。Zucchini は、実行ファイルの中の参照（ジャンプ先など）を解析して、生のバイトの差分より小さな差分を作る（[Zucchini の README](https://chromium.googlesource.com/chromium/src/+/HEAD/components/zucchini/README.md)）。本家が以前使った Courgette との関係と、どちらが今の本家の既定かは未検証。新しく作るので、Zucchini だけを使う。
- 圧縮されたファイル（リソースのパック）は **Puffin** で差分にする。プロトコル 4 のパイプラインは、どちらの操作も持つ（[Omaha プロトコル 4](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/updater/protocol_4.md)）。
- 差分は、リリースの工程で、各チャンネルの直近の 3 つの版から作る。それより古い版の端末と、差分の適用に失敗した端末には、全体を返す（応答のパイプラインに、差分と全体の両方の URL を並べる）。
- 差分の大きさは初期見積もり（全体の約 10%。[capacity.md](capacity.md)）。Canary の実績で決め直す。

## 8. 部品の脆弱性への追従

- `third_party` の目録（ADR-0002）の各部品について、上流のセキュリティ勧告を自動で受け、Issue を起票する。V8 は本家の Stable の修正の版を毎週確かめる。
- V8 などの C++ の部品は、事前にビルドした成果物を固定して使う（[ADR-0030](../decisions/0030-build-system.md)）。部品の更新は、成果物のビルド（V8 は 1 回に 30 分程度。[rusty_v8](https://github.com/denoland/rusty_v8)）から緊急の CI までを 6 時間以内に終える。

## 9. クラッシュの収集

### 9.1 クライアント

- **Crashpad を使う。** Crashpad は、クラッシュしたプロセスの外の、別の handler プロセスでダンプを取る。ダンプは minidump の形式で、ローカルのデータベースに置き、同意があるときだけアップロードする。アップロードはクライアント側で 1 時間に 1 件に抑えている（[Crashpad の設計](https://chromium.googlesource.com/crashpad/crashpad/+/HEAD/doc/overview_design.md)）。
- Crashpad は C++ の部品なので、Rust から FFI で登録する（ADR-0001・0002）。handler はブラウザの起動時に 1 つ立ち上げ、すべての子プロセスを登録する。
- **ダンプに入れるもの**：スレッドのスタック、レジスタ、モジュールの一覧、許可リストにある注釈（版、チャンネル、プロセスの種類、有効なフィールドトライアル、GPU のベンダー）。ヒープは入れない。URL、ページのタイトル、プロファイルのパスは注釈に入れない（ADR-0032）。
- 同意がないときも、ダンプはローカルに 7 日だけ置く。利用者は、クラッシュの一覧のページから、1 件ずつ送ることを選べる。同意がないときは、自動では 1 件も送らない。

### 9.2 サーバー

```
Crashpad ─POST（gzip）─▶ CloudFront ─▶ crash-ingest（ECS）
                                         ├─ minidump を S3 へ（KMS、30 日で削除）
                                         └─ SQS ─▶ symbolicator（ECS）
                                                     ├─ シンボルの S3 から .sym を読む
                                                     ├─ minidump-stackwalk でスタックを復元
                                                     └─ シグネチャを付け、crash DB（Aurora）へ
リリースの工程 ─ dump_syms でシンボルを作り、S3 のシンボルの置き場へ
```

- **シンボル化**は、rust-minidump の `minidump-stackwalk` を使う。Breakpad の `.sym` 形式のシンボルを読める。Mozilla のクラッシュの収集（Socorro）で本番に使われている（[rust-minidump](https://github.com/rust-minidump/rust-minidump)）。PDB・DWARF・Mach-O から `.sym` を作る道具（Mozilla の `dump_syms`）の対応範囲は未検証。
- シンボルは、Canary を含むすべての成果物について、リリースの工程で作って置く。シンボルのない版のクラッシュは、ビルドの工程の失敗として扱う。
- **シグネチャ**：復元したスタックの上位のフレーム（部品の中の共通の関数を飛ばす）を正規化したもの。シグネチャごと・版ごと・チャンネルごとに件数を数え、[observability.md](observability.md) の指標にする。
- 新しいシグネチャが、ある版で上位 20 件に入ったら、開発リポジトリに Issue を起票する。Issue にはスタックとシグネチャだけを書き、minidump は添付しない。
- crash-ingest は、送信元の IP アドレスを保存しない。レポートの ID は、レポートごとの乱数にする。

## 10. テレメトリ

- **同意した利用者だけが送る**（ADR-0005）。初回の起動で選ばせ、既定は「送らない」。設定からいつでも変えられる。
- 送るのは、事前に登録した指標だけ。指標の登録簿（開発リポジトリの 1 ファイル）に、名前・種類・単位・持ち主・期限・プライバシーの区分を書く。本家のヒストグラムの規則（持ち主と期限を必須にし、期限が切れたら記録のコードを消す。[histograms の README](https://chromium.googlesource.com/chromium/src/+/HEAD/tools/metrics/histograms/README.md)）に倣う。
- 登録簿は、利用者向けのページとして公開する（「内容の範囲を公開する」。ADR-0005）。
- **永続の端末 ID を持たない。** 1 つのレポートは、ブラウザのセッション 1 回ぶんの集計で、セッションの中でだけ同じ乱数の ID を持つ。利用者の数ではなく、セッションあたりの率で判断する（クラッシュ率、起動の時間の分布）。
- 送る頻度は 30 分に 1 回と、終了時。1 レポートの上限は 64 KB（初期見積もり）。
- 受け取る側は [observability.md](observability.md) の 3 節。

## 11. 機能のフラグ（クライアント）

- 未完成の振る舞いは、ブラウザの中の機能のフラグの裏に置いて `main` に入れる（ルートの AGENTS.md）。フラグの既定は「無効」で、コードに持つ。
- フラグには、持ち主と、消す予定のマイルストーンを書く。予定から 3 マイルストーン過ぎたフラグは、CI で失敗させる。本家の `chrome://flags` の期限の考え方と同じ（[flag expiry](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/flag_expiry.md)）。
- 利用者が試すためのフラグの画面（`about:flags` に相当）は、Canary・Dev・Beta だけで既定で見せる。

## 12. フィールドトライアル（段階的な有効化と停止）

- フラグを段階的に有効にするための設定（seed）を、サーバーから配る。本家では、seed を variations のサーバーから取り、開発版とテストでは `fieldtrial_testing_config.json` を使う（[variations の README](https://chromium.googlesource.com/chromium/src/+/HEAD/testing/variations/README.md)）。同じ形にする。
- **seed は静的なファイルにし、チャンネルごとに CDN で配る。** ブラウザは起動時と、起動中は 30 分ごとに取る（ETag で差分がなければ本体を取らない）。seed は KMS の鍵で署名し、署名が合わなければ前の seed を使い続ける。
- **グループの割り当ては端末の中で行う。** 端末でだけ持つ乱数で、どのグループに入るかを決める。乱数もグループもサーバーには送らない。同意した利用者のテレメトリには、有効なグループを載せる（効果の分析のため）。
- **止める手段（kill switch）として使う。** 不具合のある機能は、seed で無効にすれば、起動中の端末にも 30 分程度で効く。版を配り直すより速い（[runbooks/bad-release-rollback.md](../runbooks/bad-release-rollback.md)）。
- seed の変更は、2 人の承認で行い、Canary → Beta → Stable の順に広げる。機能を止める変更だけは、全チャンネルに同時に出してよい。
- 企業のポリシーで、フィールドトライアルを無効にできる。

## 13. リリースの判断と役割

| 判断 | 誰が |
| --- | --- |
| ブランチを切る、Beta・Stable の版を作る | release owner（Ops） |
| Stable の RC を 1% に出す | release owner。QA が、Beta の結果とリリースの基準（[quality.md](../quality.md)）で受け入れていることが前提 |
| 50% → 100% | release owner。PM がリリースノートを確認する |
| 配信を止める | 誰でもよい（rollout-guard、オンコール、release owner）。止めたら release owner に連絡する |
| 緊急のセキュリティ修正を出す | セキュリティの担当と release owner の 2 人 |
| フィールドトライアルで機能を広げる | PM。止めるのは誰でもよい |

## 14. リスクと未解決事項

- **再起動しない利用者**：NFR-006 の 90% は、3.3 の促し方に強く依存する。Canary・Beta の実績で、48 時間で届く割合を見積もり直す。
- **Linux**：パッケージ管理に任せるので、48 時間の目標を OS ごとに分けて測る。
- **S1 の標本の小ささ**：同意する利用者の割合が見積もりより低いと、自動の停止が働かない。Beta の利用者を増やす施策（企業の検証の枠）を PM と検討する。
- **2 週の周期**：本家に合わせるかは、S2 の前に判断する（1 節）。
