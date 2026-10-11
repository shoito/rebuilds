# Design log: Gmail

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-10：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E17 の PoC・試験で覆りうる。

- **メールの面の言語**：Rust。接続の数（IMAP 20 万）、MIME の解析の安全、選別の CPU の効率を理由にした（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **SES を使わない**：送信の IP と評判、DSN、受信の SMTP の時点の判定を自分で持つ。Google Calendar の題材の iMIP は SES のままでよい（別の製品）。
- **SMTP の時点の拒否と、受け付けた後の選別**：安く確かなものだけを SMTP で拒み、残りは 250 の後に選別する（[ADR-0002](../decisions/0002-accept-then-filter.md)）。
- **グレーリスト**：使わない。正規のメールを数分〜数十分遅らせ、NFR-001 を満たせない。評判の分からない IP の急な量にだけ、421 での一時の絞り（同じ IP を 15 分まで）を使う（[ADR-0002](../decisions/0002-accept-then-filter.md)）。
- **MTA-STS と TLS-RPT**：本システムのドメインに `mode: enforce` で公開し、TLS-RPT の報告を受ける。送信は相手の MTA-STS を守り、相手が TLS-RPT を公開していれば報告を送る。送信の DANE は MVP の後。
- **BIMI**：MVP では表示しない（`BIMI-Location` と VMC の有無を記録だけする）。MVP の後に、VMC・CMC の検証、SVG の安全な描画、DMARC の条件（`quarantine` 以上、`pct=100`）で表示する。
- **同期のプロトコル**：JMAP を主の API、IMAP を既存のアプリ向けにする。独自の同期の API は作らない。POP3 は MVP の後（[ADR-0006](../decisions/0006-sync-protocol-jmap-imap-and-modseq.md)）。
- **アプリのパスワード**：作らない。IMAP と submission は OAuth（`OAUTHBEARER`・`XOAUTH2`）だけ。複合機などの機器の送信は、組織の SMTP のリレー（IP の許可の一覧）で MVP の後に扱う。
- **S/MIME**：MVP では扱わない（署名は普通の添付として見える）。MVP の後に組織向けに、受信の署名の検証と表示から足す。
- **機密モード**：作らない（1.4 節）。延期の一覧に置く。
- **URL の書き換え**：しない（1.4 節）。外部の画像は `<brand>usercontent.<domain>` の代理で取得して表示する（利用者の IP と既読を送り手に渡さない）。迷惑メールの箱の画像は表示しない。
- **一括の配信停止**：受信したメールに `List-Unsubscribe-Post: List-Unsubscribe=One-Click` があり、DKIM の署名がそのヘッダーを含んで通るとき、Web とアプリに配信停止のボタンを出し、本システムの egress から POST する（法務の L2 の (d)）。送信の側は、組織の利用者が大量に送る宣伝のメールに付けられるようにする。
- **元に戻す送信**：5・10・20・30 秒（本家に合わせる。既定は 5 秒。本家の既定は**未検証**）。窓の間は `mailstore` の送信の依頼として持ち、MTA に渡さない。
- **予約の送信**：アカウントあたり 100 通、1 年先まで。
- **不在の返信**：本家に合わせ、同じ差出人へは 4 日に 1 回。迷惑メール、`List-Id`・`Precedence: bulk`・`Auto-Submitted` を持つメールには返さない（RFC 3834）。
- **ゴミ箱と迷惑メールの箱**：30 日で自動で消す（本家の日数は**未検証**）。
- **容量の超過**：受信を RCPT の 452 4.2.2 で一時の拒否にする（送り手の再試行の期限で送り手が DSN を出す）。送信は止めない。長期の超過の消去は法務の L6。
- **受信箱の分類（タブ）と「重要」の自動の判定**：MVP の後。中身による分類は法務の L1 の範囲を見てから。MVP の「重要」は利用者の印と連絡先の規則だけ。
- **送信の IP プール**：個人、組織（評判の層ごと）、本システムの通知と DSN、転送、疑い（評判の低い送信を隔てる）、ウォームアップ中の 6 つに分ける（outbound-smtp-and-reputation の領域）。
- **外部の評判のデータ**：公開・商用のブロックリストを、判定の入力の 1 つとして使い、それだけで拒まない（自社の評判と組み合わせる）。照会に送るのは IP とドメインだけ（法務の L5・L10）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-10-10：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆した・具体にしたところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **スレッドの合わせの見え方**（[ADR-0005](../decisions/0005-threading-algorithm.md) の注記）：「JMAP では `threadId` の変更として届く」は RFC 8621 の 3 節（`threadId` は変わらない。合わせは消して新しい ID で入れ直す、MUST）に反する。[ADR-0034](../decisions/0034-threading-implementation-and-merge.md) のとおり、移るメッセージを新しいオブジェクトの世代にし、JMAP は `destroyed` と `created`、IMAP は `VANISHED` と新しい UID で届ける。
- **JMAP の箱と送信の保留**（[ADR-0006](../decisions/0006-sync-protocol-jmap-imap-and-modseq.md) の注記）：「`sendAt` で窓と予約を表す」は、`sendAt` がサーバーの決める性質なので成り立たない。予約は FUTURERELEASE（`HOLDUNTIL`・`HOLDFOR`）、窓はサーバーが足す（[ADR-0041](../decisions/0041-jmap-extensions-and-mailbox-mapping.md)）。役 `all` の仮想の箱を足し、IMAP の `[<Brand>]/All Mail` も同じ集合（`SPAM`・`TRASH`・`SCHEDULED` を除く）にした。
- **窓だけの送信の `sendAt`**（[ADR-0041](../decisions/0041-jmap-extensions-and-mailbox-mapping.md) の注記）：RFC 8621 の 7 節は、FUTURERELEASE を使わない送信の `sendAt` を作成の時刻とする（MUST）。`sendAt = 作成の時刻 + 窓` をやめ、窓の終わりを拡張の性質 `<brand>:releaseAt` で返す（[client-sync-and-protocols.md](client-sync-and-protocols.md) の 6.6 節、[web-client.md](web-client.md) の 6 節）。
- **返すバイト**（[ADR-0003](../decisions/0003-message-storage-layout-and-dedupe.md) の注記）：「前置き＋本文の blob」を、[ADR-0032](../decisions/0032-served-view-edits.md) の「配る形」（blob に編集の表を当てたもの）に置き換えた。編集は、偽の `Authentication-Results` の名前の変更と、止めた添付の置き換えの 2 つだけ。配った後に添付が止まったら新しい世代にする。sender-authentication・attachment-and-url-scanning の持ち越しはこれで閉じた。
- **テナントをまたぐ経路**（[ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md) の本文と注記、[ADR-0061](../decisions/0061-operator-access-cross-tenant-paths-and-audit.md) の注記）：X4 に時刻の仕事（予約の送信と元に戻す送信の解放、スヌーズの起こし、不在の返信の終わり）とドメインの検査を含めた。X9（`fbl_trace` の引き）と X10（法務の手順の保全と書き出し。法務の L4 まで無効）を本文の一覧に足した。
- **汎用の部品**（[ADR-0001](../decisions/0001-platform-and-stack.md) の注記）：一覧から [ADR-0062](../decisions/0062-generic-components-additions-and-supply-chain.md) を参照した（HTML5 の構文解析、SAML、JWT、WebAuthn、Argon2id、地理の DB）。web-client の持ち越し（`thread-view-and-safe-html` の承認の止め）は外れた。
- **鍵**（[ADR-0030](../decisions/0030-blob-format-v1-and-envelope-keys.md) の注記）：「KMS のテナントの鍵」は [ADR-0060](../decisions/0060-key-hierarchy-and-crypto-erasure.md) の 4 段の鍵の TRK を指す。KMS の鍵はテナントごとに作らない。
- **`mx2` の IP**：BYOIP の範囲は同時に 1 つのリージョンだけなので、`mx2` を大阪の別の /24（`in-osa`）に移した（[inbound-smtp.md](inbound-smtp.md) の 4 節、[ADR-0063](../decisions/0063-network-byoip-ranges-and-egress.md)）。
- **`hold` の参照**：保留を掛けた時でなく、消す時に保全の行ごとに 1 つ足す（`hold:<tenant_id>:<message_id>`。[message-parsing-and-storage.md](message-parsing-and-storage.md) の 8.1 節を [ADR-0053](../decisions/0053-retention-rules-holds-and-preservation.md) に合わせた）。
- **`PRESERVED` と `preserved` の印**：足す。利用者は保留を見ないが、eDiscovery は利用者が消した保全のメッセージを同じ索引で探すので、墓標にして合わせで落とすと探せない。`search-node` の `PRESERVED` のビットマップ（[search.md](search.md) の 7 節）と、change log の `destroyed` の `preserved` の印・`preserved_purged`（[client-sync-and-protocols.md](client-sync-and-protocols.md) の 4.1 節）を足した。JMAP・IMAP・プッシュには出さず、型ごとの `modseq` も進めない。
- **配送の待ち行列の 2 つの層**：`inbound-delivery` と `inbound-delivery-low`（`unknown`・`suspicious` の層）に分け、前者を先に読む（[inbound-smtp.md](inbound-smtp.md) の 11.2 節、[ADR-0011](../decisions/0011-spool-commit-and-sweeper.md) の注記）。
- **S3 の PUT の削減**：`spool-done` の印をタスクごとに束ね（ADR-0011 の注記）、小さな索引のセグメントを S3 に書かずに `search-node` の組へ直接渡す（[ADR-0037](../decisions/0037-segment-format-and-query-execution.md) の注記）。PUT は 1 日 2.4 億から約 1.25 億になる。
- **費用（仮。PM の判断待ち）**：S1 の見積もりは 1 年目 0.19・3 年目 0.21 USD/アカウント・月で、仮の予算 0.15 USD を超えた。手段は A（PUT の削減、月 約 1.6 万 USD）、B（予約の割引 3 割、約 2.1 万、割引の率は**未検証**）、C（JMAP をエッジの外で受ける、約 1.3 万）、D（迷惑メールの箱の blob を大阪へ写さない、約 0.2 万）。推奨の既定案は A＋B＋C で、1 年目 約 0.135 USD、3 年目 約 0.156 USD（データモデルの工程のメタデータの見直しの後は 1 年目 約 0.148・3 年目 約 0.189 USD。下の「決定（2026-10-10、データモデル）」）。D は採らない。C は E8 の前に Dev と Ops が構成を確かめてから 1.2 節の図を直す（[capacity.md](capacity.md) の 8.1 節、[ADR-0068](../decisions/0068-capacity-model-and-headroom.md) の注記）。
- **一括の配信停止のボタン**：既定案の条件に、DKIM の署名のドメインが From に揃うことを足した（[sender-authentication.md](sender-authentication.md) の 10.1 節）。
- **本家との意図した違い**（1.4 節）：IMAP の読み出しの量、一括の配信停止の From の揃い、送信の上限で中の宛先を数えること、アプリ パスワードを作らないこと、SMS を使わないこと、パスキーの待ちを置かないこと、プッシュに中身を入れないこと、確かめの前の第三者のアプリの上限の行を足した。予約の送信の 100 通の未検証を外した。
- **runbooks の名前**：`delivery-queue-backlog.md` を [mail-delivery-backlog.md](../runbooks/mail-delivery-backlog.md)、`account-takeover-wave.md` を [account-takeover.md](../runbooks/account-takeover.md) にそろえた（[runbooks/README.md](../runbooks/README.md) の 4 節）。
- **検証の工程での直し（2026-10-10）**：公式の資料を取得し直して、次を確かめ・直した。
  - DMARCbis：RFC 9989（DMARC、Proposed Standard、2026 年 5 月、RFC 7489 と RFC 9091 を置き換え、`pct` を除き `t` を持ち、DNS の木の歩きは 8 回まで）、RFC 9990（集計の報告）、RFC 9991（失敗の報告）を rfc-editor.org と datatracker で確かめた。group A の記述のまま（確認のみ）。
  - RFC 8621：2 節（Email は 1 つ以上の箱に属する、MUST）、3 節（合わせは消して新しい ID で入れ直す、MUST）、7 節（`sendAt` はサーバーが決め、FUTURERELEASE がなければ作成の時刻、MUST）。7 節に合わせて `sendAt` を直した。
  - RFC 5321 の 4.5.3.2.6 節は送り手が終わりの 250 を待つ 10 分で、DATA の塊の 3 分は 4.5.3.2.5 節。[inbound-smtp.md](inbound-smtp.md) の 5.3 節の根拠を直した。
  - RFC 5322（2.1.1 節の 998）、RFC 7208（4.6.4 節の 10 回）、RFC 6376、RFC 8617、RFC 8461（`max_age` 最大 31,557,600）、RFC 8460、RFC 8058（4 節：DKIM の署名が 2 つの欄を覆う MUST、3.1 節：クッキーを送らない）、RFC 8601（5 節：自分の authserv-id を名乗る外からの欄を消すか隠す MUST）、RFC 8620、RFC 9051、RFC 7162、RFC 8628、RFC 8474（5.2 節：`THREADID` を変えない MUST）は、引いた節の中身を確かめた（確認のみ）。
  - IANA の「IMAP Mailbox Name Attributes」に `Scheduled`・`Snoozed` が RFC 9979 で登録されていた。client-sync の未検証を外し、役として出す。
  - 本家：予約の送信 100 通（公式のヘルプで確かめ、未検証を外した）、IMAP の読み出し 1 日 2,500 MB、アプリ パスワードと SMS の 2 段階の確認、送信者のガイドライン（2024-02-01、0.3%、5,000 通、1024 ビット）を確かめた。元に戻す送信の既定の秒数と、配信停止の反映の期限は公式の資料に書かれていない（**未検証**のまま）。
  - AWS：BYOIP は IPv4 /24・公開の IPv6 /48 が最小、1 つの範囲は同時に 1 つのリージョン、リージョンあたり IPv4 と IPv6 で合わせて 5 つ（申請で増やせる）を確かめた（東京は S1 で 5 つを使い切る）。EC2 のポート 25 の制限の解除は Support への申請（逆引きの文書で確かめた）。リージョンごとの申請と処理の時間は re:Post の本文を取得できず**未検証**。
  - 日本の法令：最初は総務省の懇談会の整理を報道だけで引き、条件を 3 つと書いていた。総務省の「同意取得の在り方に関する参照文書」で 5 つの条件（合理的な推定と事前の説明を含む）を確かめ、[intent.md](../intent.md)・[ADR-0008](../decisions/0008-spam-pipeline-boundary-and-secrecy.md) を直した。総務省の「DMARC導入に関する法的な留意点」（報告に本文と件名を含めないことなど）を出典に足した。当てはめはどれも**法務の確認待ち**（L1）。
- **品質と運用**：
  - 各領域の文書の「テストと性質」と「data-model への項目」を反映した。[quality.md](../quality.md) に性質と決定表の一覧（2.2.2 節）と、Epic の合否基準の補いを足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[ip-blocklisted.md](../runbooks/ip-blocklisted.md)、[spam-wave.md](../runbooks/spam-wave.md)、[account-takeover.md](../runbooks/account-takeover.md)、[mail-delivery-backlog.md](../runbooks/mail-delivery-backlog.md)）と計画のものに分けて一覧にした。
  - 表と置き場所の索引は [data-model.md](data-model.md)（その後のデータモデルの工程で正本に書き直した。下の「決定（2026-10-10、データモデル）」）。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。
  - SMTP の上限（SIZE 50 MiB、宛先 100、検査の予算 10 秒、確定の予算 5 秒）は [ADR-0002](../decisions/0002-accept-then-filter.md)・[ADR-0011](../decisions/0011-spool-commit-and-sweeper.md)。MIME の上限（入れ子 32、パート 1,000、ヘッダーの部 256 KiB、2 秒、256 MiB）は [ADR-0029](../decisions/0029-mime-parsing-limits-and-charsets.md)。選別の閾値（`p_phish` 0.80・`p_spam` 0.90 ほか）は [ADR-0022](../decisions/0022-verdict-score-composition-and-overrides.md)。送信の再試行（1・5・15・30 分、1・2 時間、以後 4 時間、5 日、24 時間で遅れの通知）は [ADR-0019](../decisions/0019-mta-out-queues-throttling-and-retries.md)。元に戻す送信（5・10・20・30 秒、既定 5 秒）と不在の返信（96 時間）は [ADR-0049](../decisions/0049-timed-jobs-vacation-and-scheduled-send.md)。IP の範囲は [ADR-0063](../decisions/0063-network-byoip-ranges-and-egress.md)。
  - 負荷と費用のモデルは [capacity.md](capacity.md)、単位あたりの原価は [infrastructure.md](infrastructure.md) の 9 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-10：データモデル

[data-model.md](data-model.md) を、索引から正本（規約、表の目録、ER 図、形式、不変条件）に書き直した。表の目録は [data-model/](data-model/) の 16 本。名前・列の食い違いを 31 件の決定（D-1〜D-31）で解き、領域の文書を直した（[data-model.md](data-model.md) の 7 節）。ADR の決定は変えていない。アーキテクチャに関わるのは次の 4 件で、どれも推奨の既定案。D-1・D-20・D-21 は決定、D-22 は数を直したうえで未解決に残す。

- **配送の記録の置き場所**（D-1。残る未解決事項だったもの）：`delivery_log` を directory でなく、受け手のメールボックスのシャードに置き、`mailstore` が配送と同じトランザクションで書く。配送の冪等の鍵 `(spool_id, account_id)` の正本を兼ね、PK に `spool_id` の時刻から決まる日（分割の鍵）を含める。1 日約 7,200 万行（1 シャード約 900 万行）、90 日で約 1.3 TB。directory に 1.3 TB と書き込みを足さず、RLS の外の表も増やさない。保持の 90 日は法務の L1・L6 の確認待ち。[capacity.md](capacity.md) の 4 節に入れた。`mailbox-shard-poc` で書き込みの費用を確かめる。
- **端末の認可を RLS の外に置く**（D-20。決定）：`device_authorizations` は承認の前にアカウントが決まらず、`tenant_id` の RLS に置けない。[ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md) の RLS の外の一覧の「`sessions`、`oauth_tokens_index`（トークンのハッシュ → アカウント）」と同じ区分として扱い、ADR-0007 に 2026-10-10 の注記を足した。
- **アドレスの HMAC の鍵**（D-21。決定）：`mx-edge` は RCPT のたびに「テナントの鍵の HMAC」で `address_index` を引く（[ADR-0013](../decisions/0013-recipient-validation-and-transaction-splitting.md)）が、TRK の `Decrypt` を持たない。テナントごとのアドレスの鍵を作り、KMS の専用の `address-index` の鍵で包んで `tenant_keys.addr_key_wrapped` に置く。`Decrypt` は `mx-edge`・`inbound-pipeline`・`accounts`・`admin-api`・`report-ingest` で、`mx-edge` が持つのはこの鍵の `Decrypt` だけ。TRK の破棄と同時に消す。[ADR-0060](../decisions/0060-key-hierarchy-and-crypto-erasure.md) に 2026-10-10 の注記を足し、[security.md](security.md) の 5.4 節を合わせた。
- **メッセージの行の大きさの見直し**（D-22）：列から見積もると、メッセージの行は索引を含めて約 2.3 KB で、所属とスレッドの表を足すと 3 年後のメタデータは約 78 TB（2 節の「1 行 600 バイトで 16 TB」の約 5 倍）。1 シャード約 10 TB で、段階を上げる準備の基準（2.5 TB、[ADR-0065](../decisions/0065-stage-up-criteria-and-cells.md)）を 1 年目の後半に超える。Aurora の保存の費用は、東京と大阪で 1 年目 月 約 1.3 万 USD、3 年目 月 約 3.3 万 USD 増え、1 アカウント・月の原価は削減の前で 0.20・0.24 USD、A＋B＋C の後で 約 0.148・0.189 USD になる。[capacity.md](capacity.md) と 2 節・2.1 節の数をこの値に直した。シャードの数（8 のままか、増やすか）と行を小さくする手段は、`mailbox-shard-poc` で測ってから決めるため、下の残る未解決事項に残す。
