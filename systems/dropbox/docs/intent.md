# Intent: Dropbox を AI エージェント主体で再構築する

- Author: shoito
- Status: draft
- Date: 2026-10-09

## Problem

個人とチームは、仕事のファイルと写真を、複数の PC とスマートフォンで使う。ファイルの同期は単純に見えるが、次のところで壊れやすい。

- **ファイルが消える・上書きされる。** 2 台で同じファイルを編集する、オフラインで編集してから戻る、片方でフォルダーを消しながら他方でその中に保存する。こうした場面で、片方の編集が黙って失われる。
- **名前で壊れる。** macOS は濁点を分けた形（NFD）で名前を返すことがあり、Windows は大文字と小文字を区別せず、使えない文字と予約の名前がある。「が.txt」と「が.txt」、「Report.xlsx」と「report.xlsx」が、端末をまたぐと 2 つになったり、消し合ったりする。
- **大きなファイル・多くのファイルで遅い。** 数百 GB の動画、数十万のファイルのフォルダー、数万人のチームのフォルダーで、1 か所の変更のたびに全体を送り直す、全体を数え直す。
- **共有の範囲が分からない。** 誰に何が見えているか、リンクが誰に渡ったか、チームの外へ出たかを、管理者が把握できない。
- **戻せない。** 誤った一括の削除、ランサムウェアによる一斉の暗号化で、数万のファイルが壊れる。1 つずつ戻すしかない。

本家 Dropbox は、これらを大きな規模で解いている。デスクトップのクライアントの同期、オンラインのみのファイル、共有フォルダーと共有リンク、バージョン履歴、削除したファイルの復元、Rewind（巻き戻し）、LAN 同期、公開 API と Webhook を提供する（出典は末尾）。この題材では、これを日本の市場を最初の対象に、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。核（同期エンジン、分割、ブロックの索引、メタデータのジャーナル）は自分で設計する（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## Proposed outcome

個人とチームが、ファイルを失わず、どの端末でも同じ木を見られるストレージを使えるようにする。次の 4 つの価値を満たす。

1. **失わない・黙って上書きしない**：サーバーが確定を返したファイルの中身を失わない（NFR-005）。同時の編集は競合のコピーとして両方を残し、片方を黙って消さない（NFR-004）。
2. **すぐそろう**：ある端末で保存した小さなファイルが、他のオンラインの端末で p95 10 秒で開ける（NFR-002）。変わったブロックだけを送り、数百 GB のファイルも途中から再開できる（NFR-003）。
3. **共有の範囲が分かる**：共有フォルダー・共有リンク・チームの外への共有を、1 つの権限の判定で決め、管理者が方針で絞り、監査ログで追える（NFR-007）。
4. **戻せる**：ファイルのバージョン、削除したファイル、フォルダー全体を、プランの保持の期間の中で戻せる。一斉の変更を検知して知らせ、時点を選んで巻き戻せる（NFR-009）。

### MVP（S1）に含める

- **アカウントとチーム**：個人のアカウント（無料・有料）、チーム（会社・団体）。チームのメンバー・グループ、SSO（SAML・OIDC）と SCIM、管理者の役割
- **ファイルとフォルダー**：作成、変更、名前の変更、移動、コピー、削除。最大 2 TiB のファイル（本家と同じ上限）
- **デスクトップのクライアント**：macOS と Windows。手元のフォルダーの監視、差分の同期、オフラインの編集と復帰、競合のコピー、選択型の同期（フォルダーを手元に置かない）、オンラインのみのファイル（macOS の File Provider、Windows の Cloud Files API のプレースホルダー）、帯域の制限、一時停止、状態の表示
- **ブロックの保存**：内容で区切る分割（CDC）、SHA-256 の番地、テナントの中の重複排除、足りないブロックだけのアップロード、途中からの再開、S3 への直接のアップロードとダウンロード
- **名前空間と共有**：利用者のルート、共有フォルダー（編集・閲覧）、チームのフォルダー（チームのスペース）、チームの外への共有の方針
- **共有リンク**：閲覧のリンク、パスワード、期限、ダウンロードの禁止（有料のプラン）、リンクの無効化、アクセスの記録
- **バージョンと復元**：ファイルのバージョン履歴、削除したファイル・フォルダーの復元、名前空間の巻き戻し（時点を選ぶ）、一斉の変更の検知と通知
- **Web の画面**：一覧、アップロード（フォルダーごと）、ダウンロード、プレビュー、共有、復元、検索
- **プレビューとサムネイル**：画像、PDF、Office の文書、動画の最初の画面、テキスト
- **検索**：ファイルとフォルダーの名前（日本語の部分一致）、チームのプランでは本文（テキスト、PDF の文字、Office の文書）
- **モバイルのアプリ**：iOS と Android。一覧、プレビュー、オフラインの保存（指定したファイルだけ）、カメラのアップロード
- **公開 API と Webhook**：REST の API（OAuth 2.0）、カーソルでの差分の取得、変更の通知の Webhook（署名つき）
- **チームの管理と監査**：管理の画面（メンバー、グループ、共有の方針、端末の一覧と遠隔の切り離し）、監査ログ

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| LAN 同期 | 本家にはある（[LAN sync](https://help.dropbox.com/sync/lan-sync-overview)）。同じネットワークの端末の間で中身を直接送るには、端末どうしの認証・鍵の配布・ネットワークの方針の設計が要る。MVP はサーバーとの同期の正しさを先に確かめる（[architecture/](architecture/README.md) の 6 節） |
| 画像と走査した PDF の OCR（日本語）での検索 | 日本語の OCR の精度と計算の費用を測ってから決める。MVP は名前と本文だけ |
| Linux のクライアント、ヘッドレスの CLI | MVP は macOS・Windows・iOS・Android |
| 顧客の鍵（BYOK）、エンドツーエンドの暗号化のフォルダー | 重複排除、プレビュー、検索と両立しない。別の設計が要る |
| 電子署名、文書の共同編集、ファイルの依頼（他人からの受け取り） | 別の製品の論点 |
| 海外のリージョン | S3。テナントをリージョンに固定する形で足す |
| 本家・他社からの一括の移行 | 他社の API と規約の確認が要る |

### 守るべき振る舞い

- サーバーが確定を返したファイルのバージョンは、保持の期間の中で、どの経路からも中身を取り出せる。
- 同期は、2 つの端末の変更がぶつかったとき、片方を黙って捨てない。どちらかを競合のコピーとして残す。削除と変更がぶつかったら変更を残す。
- すべての端末が静かになった後、それぞれの手元の木は、選択型の同期で外したものを除いて、サーバーの木と一致する。
- 同じフォルダーの中に、`name_key`（NFC＋大文字小文字の畳み込み）が同じ名前の 2 つのノードはない。
- 利用者が読めない名前空間のファイルについて、その中身・名前・有無（重複排除の答えを含む）が、どの経路でも分からない。
- 共有リンクは、無効化・期限切れ・パスワードの不一致・方針の変更の後、中身を返さない。
- カーソルで取った変更を順に当てれば、全件を取り直した結果と同じになる。カーソルが使えないときは、黙って欠けた差分を返さず、取り直しを求める。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | 同期の正しさ | 決定的な同期のシミュレーターで、収束しない・中身を失う・黙って上書きする場合 0 件（夜間 1,000 万の場面）。本番で、利用者からの「ファイルが消えた」の調査で、本システムの誤りによるもの 0 件（NFR-004） | シミュレーター、本番の照合、サポートの調査 |
| K2 | 中身の耐久性 | 確定したバージョンの中身を取り出せなかった事象 0 件。参照のあるブロックの削除 0 件（NFR-005） | ブロックの参照の監査、抜き取りの読み出し |
| K3 | 伝播 | 1 MiB 以下のファイルの確定から、他のオンラインの端末で開けるまで p95 10 秒（NFR-002） | 合成監視の 2 つの端末 |
| K4 | 大きなファイル | 1 Gbps の回線で 100 GB のファイルを 30 分以内に送る。途切れても、確定したブロックを送り直さない（NFR-003） | 負荷試験、合成監視 |
| K5 | 名前 | 名前の試験の集まり（NFC・NFD、大文字小文字、Windows の予約の名前、長いパス）の全場面で、名前の重複・ループ・消し合い 0 件 | ファイルシステムの端の場合の試験 |
| K6 | 可用性 | メタデータの API と同期 月間 99.9%、ダウンロード 月間 99.9%（NFR-006） | 合成監視と 5xx の割合 |
| K7 | 権限の分離 | 読めない名前空間の名前・中身・有無が届いた事象 0 件（NFR-007） | 性質ベーステスト、本番の応答の監査 |
| K8 | 復元 | 10 万ファイルのフォルダーの復元 10 分以内、100 万ファイルの名前空間の巻き戻し 1 時間以内（NFR-009） | 負荷試験、訓練 |
| K9 | 端末の負荷 | 100 万ファイルを持つ端末で、静かなときの CPU 1% 未満、メモリー 300 MB 以下（NFR-008） | クライアントの計測 |

## Affected users and systems

- **個人の利用者**：写真、書類、仕事のファイル。無料のプランから有料のプランへ移る。スマートフォンの写真の自動のアップロードを求める。
- **チームの利用者**（主な利用者）：日本の中小・中堅企業の社員、設計・映像・建設など大きなファイルを扱う業種。社外の取引先とフォルダーやリンクで共有する。
- **チームの管理者**：メンバー、共有の方針、端末、監査ログ、復元の依頼を扱う。
- **共有リンクを受け取る外部の人**：アカウントを持たないことがある。
- **外部のシステム**：公開 API と Webhook の利用者（バックアップ、業務のシステム、ワークフロー）、IdP（Microsoft Entra ID、Okta など）、メールの送信、モバイルの OS の通知。
- **OS**：macOS（File Provider、FSEvents）、Windows（Cloud Files API、ReadDirectoryChangesW）、iOS・Android（写真のライブラリ、バックグラウンドの制約）。
- **社内の運用**：サポート、障害の対応、違法なコンテンツの通報と開示の請求への対応、データの復元の依頼。

## Constraints

- **核を自前で設計する。** 同期エンジン（3 つの木、計画、衝突）、分割、ブロックの索引、メタデータのジャーナルとカーソルは、自分で作る。本家のコードとプロトコルを使わない。S3 は汎用のオブジェクトストアとして使う（[リポジトリ共通の ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)、[ADR-0001](decisions/0001-platform-and-stack.md)）。
- サーバーの実行基盤と技術は、rebuilds の他の題材の決定（AWS 東京・大阪、TypeScript・Hono、Aurora PostgreSQL、Valkey、S3、SQS・SNS、ECS Fargate、Terraform、OpenTelemetry、AppConfig のフラグ）を引き継ぐ。クライアントの核（Rust）と検索の基盤は、[ADR-0001](decisions/0001-platform-and-stack.md) で足す。
- 本家の名前は識別子に使わない。ドメインは `<brand>.<domain>`、利用者の中身は `<brand>usercontent.<domain>`、Webhook の署名のヘッダーは `<Brand>-Signature` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の API・SDK とそのまま互換にすることは目標にしない。
- OS の仕組みに従う。macOS は File Provider、Windows は Cloud Files API を使い、カーネルの拡張・独自のファイルシステムのドライバーを作らない。
- データは日本（東京、DR は大阪）に置く。
- 日本の法令（電気通信事業法、情報流通プラットフォーム対処法、個人情報保護法など）への対応は、法務の確認を前提に設計する。結論は出さない（下の「法務の確認待ち」）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の 2 節）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| 自前のホスト（オンプレミス）での提供、NAS の機器 | 運用の形が別になる |
| 本家の API・SDK・同期のプロトコルとの互換 | 形は寄せるが、名前と識別子は独自にする（リポジトリ共通の ADR-0006）。プロトコルは本システムの設計（ADR-0007 の規則） |
| 独自のファイルシステムのドライバー、カーネルの拡張 | OS の公式の仕組み（File Provider、Cloud Files API）に従う |
| テナントをまたぐ重複排除 | 他人のファイルの有無が漏れる（[ADR-0003](decisions/0003-dedupe-scope-and-privacy.md)） |
| 自前のディスクの保存の層（消失訂正符号、複製） | S3 の役目。本システムは論理の耐久性（参照、削除の猶予、照合）を持つ（[ADR-0007](decisions/0007-block-storage-layout-on-s3.md)） |
| 汎用のバックアップの製品（PC 全体の退避） | 同期のフォルダーだけを扱う |
| メディアの配信（動画のストリーミングの変換） | プレビューの最初の画面と、短い低い画質の再生まで |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 電気通信事業法：利用者が自分のファイルを保存するだけの使い方と、共有フォルダー・共有リンク・コメントで他人とやり取りする使い方が、それぞれ届出の要る電気通信事業に当たるか。当たる場合、保存したファイルの中身が「通信の秘密」に当たるか。当たるなら、プレビュー・サムネイル・全文の索引・マルウェアの検査・違法なコンテンツの照合のために中身を機械で読むことに、利用者の同意が要るか、同意の取り方。Web の画面とアプリの外部送信規律の公表 | security、previews-and-thumbnails、search、shared-links の各領域 | E6 の共有リンクの公開、E9 のプレビューと本文の検索、E7 の分析の計測 |
| L2 | 違法・有害なコンテンツ：情報流通プラットフォーム対処法の対象（大規模特定電気通信役務提供者の指定を含む）に当たるか。共有リンクで不特定の人に公開されたファイルへの削除の請求・送信防止措置の手順と期限。児童の性的な画像などのハッシュの照合を、どの範囲（共有リンクだけか、保存したすべてか）で行ってよいか（L1 の通信の秘密と合わせて） | shared-links、security の各領域 | E6 の共有リンクの公開、E13 の GA の判定 |
| L3 | 発信者情報開示：開示の請求・裁判所の命令に応じるために、どの記録（アップロード・共有リンクの作成の IP アドレス、時刻、アカウント）を、何日持つか。捜査機関からの照会・差押えへの対応の手順 | security、observability の各領域 | E12 の監査ログ、E13 の GA の判定 |
| L4 | 個人情報保護法：ファイルの中身とメタデータを、チームからの委託として扱うか、本システムが取得するものとして扱うか。個人のアカウントの場合。外国にある第三者への提供（モバイルの通知の配信のサービス、メールの送信、サブプロセッサー）。漏えい等の報告の義務を負う者と手順 | accounts-and-teams、security の各領域 | E10 のモバイルの通知、E13 の GA の判定 |
| L5 | データの所在：「日本のデータを国外に出さない」をどこまで約束するか。DR（大阪は国内）、CDN の国外のエッジのキャッシュ（共有リンクのダウンロード、プレビュー）、サポートでの参照、サブプロセッサー | infrastructure、shared-links の各領域 | E1 のリージョンとエッジの構成、E13 の契約の文書 |
| L6 | 保持の期間と削除：バージョン履歴・削除したファイルの保持の期間をプランでどう約束するか。解約・アカウントの削除の後のデータとブロックの消去の期限（S3 のバージョニングの 30 日を含む）。チームの法的な保全（リーガルホールド）を MVP で持つか | versions-and-recovery、block-storage、security の各領域、[ADR-0007](decisions/0007-block-storage-layout-on-s3.md) | E8 の保持の期間、E13 の GA の判定 |
| L7 | 管理者によるアクセス：チームの管理者が、メンバーの個人のフォルダーの中身を見る・メンバーとしてログインする機能を持つか。労働者のプライバシーと、就業規則・社内規程での周知の要否。監査ログでの記録 | accounts-and-teams、security の各領域 | E12 の管理者の機能 |
| L8 | 電子帳簿保存法：チームが請求書などの電子取引のデータを保存する場所として使うとき、本システムが「訂正・削除の履歴が残る」などの要件への対応をうたうか。うたう場合のバージョン履歴と削除の制限の形 | versions-and-recovery の領域 | E8 の Story の対応の表示（うたわないなら止めない） |
| L9 | 顧客との契約：委託の契約（DPA）の雛形、サブプロセッサーの一覧と変更の通知、SLA の文言、利用者からの開示・削除の請求の窓口、無料のプランの利用規約（容量の超過、長期の未使用のアカウントの扱い） | security の領域 | E13 の GA の判定 |
| L10 | 画面の見た目と操作を本家に寄せる範囲：不正競争防止法（商品等表示、商品の形態の模倣）と著作権の観点で、どこまで似せてよいか。競合のコピーの名前の文言を含む | desktop-client の領域 | E5・E7 の画面の Story |

### 選定・計測で決めるもの（法務以外）

- 分割の母数（最小 1 MiB・平均 4 MiB・最大 16 MiB）：E2 の前の `chunking-dedupe-poc` で、合成と提供を受けた試験のデータの重複の率・ブロックの数・分割の速さを測って確かめる（[ADR-0002](decisions/0002-chunking-and-block-addressing.md)）。
- S3 の事前署名の URL で、SHA-256 のチェックサムを署名に含めて強制できるか：E2 の前の `presigned-upload-poc` で確かめる。できなくても、置いた後に S3 が計算したチェックサムを確かめてから正規のキーへ移すので、正しさは変わらない（[ADR-0007](decisions/0007-block-storage-layout-on-s3.md)）。
- 1 つの名前空間の書き込みの上限（1 秒 200 件）：E3 の前の `namespace-write-throughput-poc`（[ADR-0005](decisions/0005-namespace-journal-and-cursors.md)）。
- 検索の基盤の大きさ（S1 で 25 億ノードの名前の索引）：E9 の前の `search-sizing-poc`（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- macOS の File Provider と Windows の Cloud Files API の振る舞いの差（取り出し・追い出し・名前の制限）：E5 の前の `placeholder-platform-survey`。Apple の公式の資料で確かめられなかった点は**未検証**として扱う。
- 本家の API のアップロードのセッションの上限：公式の資料の写しに 350 GB とあり、本家の職員の投稿は 2 TiB に上げたとする。公式の文書の本文で確かめられなかった（**未検証**）。本システムの上限は 2 TiB（[ADR-0002](decisions/0002-chunking-and-block-addressing.md)）。
- 本家の共有フォルダーの容量の数え方（メンバー全員の容量に数えるか）、共有フォルダーのメンバーの上限、本家のサービスの SLA：公式の資料で確かめられなかった（**未検証**）。本システムの値は namespaces-and-sharing の領域で決める。

## 出典

いずれも 2026-10-09 に確認。

- Dropbox Help Center, [Upload limitations](https://help.dropbox.com/sync/upload-limitations)：アップロードできるファイルの最大は 2 TB（2,199,019,061,248 バイト）。ブラウザからの 375 GB を超えるアップロードは失敗しやすく、デスクトップのアプリか API を勧める
- Dropbox Help Center, [Version history overview](https://help.dropbox.com/delete-restore/version-history-overview)：バージョン履歴は Basic・Plus・Family で 30 日、Professional・Essentials・Business・Standard で 180 日、Business Plus・Advanced・Enterprise で 365 日。延ばす追加の製品がある
- Dropbox Help Center, [Recover deleted files](https://help.dropbox.com/delete-restore/recover-deleted-files-folders)：削除したファイルの復元の期間は上と同じ区分。大量の変更には Rewind を勧める
- Dropbox Help Center, [Rewind](https://help.dropbox.com/delete-restore/rewind)：アカウント全体かフォルダーを、バージョン履歴の範囲の中の時点へ戻す。活動のグラフで日を選び、細かく変更を選ぶ。チームのフォルダーは別に巻き戻す
- Dropbox Help Center, [Conflicted copy](https://help.dropbox.com/organize/conflicted-copy)：同じファイルが食い違って編集されると、編集した人の名前、「conflicted copy」、日付を名前に付けたコピーを作る。後に保存されたほうがコピーになる
- Dropbox Help Center, [LAN sync overview](https://help.dropbox.com/sync/lan-sync-overview)：同じネットワークの端末の間で中身を直接送る。UDP のブロードキャストで見つけ、暗号化した HTTPS で送る。中身だけを送り、名前・木・権限は送らない。macOS の File Provider 版では使えない
- Dropbox Help Center, [Dropbox on File Provider](https://help.dropbox.com/installs/dropbox-for-macos-support)：macOS の File Provider を使うバージョンは macOS 12.5 以降が要る。オンラインのみのファイルを他のアプリで開く問題を直すためのもの
- Dropbox Help Center, [Where is my data stored](https://help.dropbox.com/accounts-billing/security/physical-location-data-storage)：保存の主な場所は米国のデータセンター。条件を満たす利用者は、オーストラリア・EU・日本・英国に置ける。チームの移行は Standard 以上・10 ライセンス以上・年払いなどが条件
- Dropbox Developers, [Content hash](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash)：ファイルを 4 MB（4,194,304 バイト）の固定のブロックに分け、各ブロックの SHA-256 をつなげて、さらに SHA-256 を取る
- Dropbox Developers, [Webhooks](https://docs.dropboxapi.com/dropbox-api/docs/webhooks)：登録の確かめは `challenge` の値を返す。通知は本文に変更のあったアカウントの一覧だけを持ち、アプリの秘密の HMAC-SHA256 の署名をヘッダーに付ける。10 秒で応答し、失敗は約 10 分の指数の再試行。失敗が多いと止める
- Dropbox Developers, [HTTP API documentation](https://www.dropbox.com/developers/documentation/http/documentation) の「Path formats」：パスは大文字小文字を区別しない。名前の大文字小文字はできるだけ保つ。ID は大文字小文字を区別する
- dropbox.tech, [Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)（2020-03-09）：同期エンジン Nucleus を Rust で書き直した。大部分を 1 つの決定的な制御のスレッドで動かし、疑似乱数のシミュレーションで試す
- dropbox.tech, [Testing our new sync engine](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine)（2020-04-20）：Remote・Local・Synced の 3 つの木。Synced はマージの基準。計画の乱択の試験（CanopyCheck）と、ファイルシステム・ネットワーク・時計を模した全体の乱択の試験（Trinity）。シードから再現する
- dropbox.tech, [Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket)（2016-05-06）：最大 4 MB の暗号化したブロックを SHA-256 で名付け、1 GB のバケットにまとめて消失訂正符号をかける
- Microsoft Learn, [Build a Cloud Sync Engine that Supports Placeholder Files](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine)：Windows 10 1709 からの Cloud Files API。プレースホルダー・完全なファイル・固定した完全なファイルの 3 つの状態、取り出しの方針、NTFS だけ
- AWS, [Amazon S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)：どのクラスも 99.999999999% の耐久性の設計。Standard-IA と Glacier Instant Retrieval は 128 KB の最小の課金の大きさと、30 日・90 日の最小の保存の期間。Intelligent-Tiering は 128 KB 未満を監視しない
- AWS, [Checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)：SHA-256 を含むチェックサムを指定してアップロードでき、S3 が計算し直して一致を確かめてから保存する
- AWS, [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)：1 オブジェクト最大 48.8 TiB、部品 10,000、部品の大きさ 5 MiB〜5 GiB
