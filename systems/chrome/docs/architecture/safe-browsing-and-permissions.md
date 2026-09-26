# Safe Browsing and Permissions: Chrome

危険なサイトからの保護（Safe Browsing）、脅威のリストのサービス、ダウンロードの保護、権限、パスワードマネージャ、パスキー、HTTPS-First。

| 関連 | 決定 |
| --- | --- |
| [ADR-0003](../decisions/0003-multi-process-site-isolation.md) | Browser は Renderer を信用しない |
| [ADR-0005](../decisions/0005-privacy-first-services.md) | 送るデータを最小にする。Safe Browsing はハッシュの接頭辞で照会する。同期は暗号化する |
| [ADR-0021](../decisions/0021-safe-browsing-list-source.md) | 脅威のリストは自前で作り、第三者のフィードを使う。Google の API は MVP で使わない |
| [ADR-0022](../decisions/0022-permission-model.md) | 権限は最上位のオリジンごと。一時の許可、自動の失効、静かな確認 |
| [ADR-0023](../decisions/0023-password-manager-encryption.md) | パスワードは OS の鍵ストアで守る鍵で暗号化し、同期は E2EE。漏洩の確認は k-匿名性 |

サンドボックスと脅威モデルは [sandbox-and-security.md](sandbox-and-security.md)、同期の鍵の階層は [sync-and-accounts.md](sync-and-accounts.md)、HSTS と証明書は [networking.md](networking.md) にある。

## 1. 目標と前提

- **URL を送らずに守る**（ADR-0005）。サービスに送るのは、URL のハッシュの接頭辞（4 バイト）と、利用者が選んだときのファイルのハッシュだけ。
- **NFR-009**：新しい危険なサイトがリストに入ってから、端末で判定できるまで 30 分以内。
- **NFR-010**：Safe Browsing のサービスは月間 99.95%。ただし、サービスが止まっても、端末は手元のリストで守り続ける（失敗しても閲覧は止めない）。
- 権限・パスワードの判断は、すべて Browser プロセスで、Browser が知っているフレームのオリジンで行う（Renderer が名乗るオリジンを使わない）。

## 2. Safe Browsing のクライアント

### 2.1 仕組み

本家の Safe Browsing API（v4 の Update API、v5）の考え方に寄せる。プロトコルは自前で定義する（ADR-0021）。

```
URL ─▶ 正規化 ─▶ 照合する式（ホストの接尾辞 × パスの接頭辞）─▶ SHA-256
                                                            │ 先頭 4 バイト
           ┌────────────────────────────────────────────────┤
           ▼                                                ▼
   手元のリスト（接頭辞）                         良性の可能性が高い式の一覧（global cache）
           │ 一致した                                       │ 一致しない
           ▼                                                ▼
   完全なハッシュの照会 ◀────────────────────────── リアルタイムの照会
   （接頭辞だけを OHTTP の中継で送る）
           │
           ▼
   完全なハッシュが一致 → 警告の画面
```

- **手元のリスト**：脅威の種類（フィッシング、マルウェア、望ましくないソフトウェア、悪用する通知など）ごとに、ハッシュの接頭辞の集合を持つ。大半は 4 バイト、衝突の多いものは長い接頭辞にする。
- **完全なハッシュの照会**：手元で接頭辞が一致したときだけ、接頭辞を送り、その接頭辞を持つ危険な URL の完全なハッシュを受け取って、手元で比べる。
- **リアルタイムの照会**：手元のリストの更新を待たずに新しい脅威を判定するため、良性の一覧に入っていない URL は、接頭辞をサービスに送って照会する。結果は、サービスが指定した時間（数分）だけ端末に記憶する。
- **OHTTP の中継**：照会は Oblivious HTTP で暗号化し、別の事業者が運用する中継を通す。中継は IP アドレスだけを見て中身を見ず、サービスは中身（接頭辞）だけを見て IP アドレスを見ない。本家は 2024 年から、この形でリアルタイムの照会を行っている。中継の事業者との契約は未解決の問い。
- **照合する時点**：主フレームとサブフレームのナビゲーション（リダイレクトを含む）とダウンロード。ナビゲーションは、応答の受信と並行して照会し、確定（commit）の前に結果を待つ。照会がサービスの指定の時間内に返らなければ、手元のリストの結果で進める。

### 2.2 保護の段階

| 段階 | 手元のリスト | リアルタイムの照会 | ダウンロードの照会 | 既定 |
| --- | --- | --- | --- | --- |
| 標準 | あり | 接頭辞を OHTTP で | ファイルのハッシュの接頭辞だけ | **既定** |
| 強化 | あり | 同左 | ファイルのハッシュと種類・大きさ（URL は送らない） | 利用者が選ぶ |
| オフ | なし | なし | なし | 設定で選べる。企業のポリシーで固定できる |

### 2.3 更新と NFR-009

| 区間 | 目標 | 方法 |
| --- | --- | --- |
| フィードの取り込み → リストの公開 | 5 分以内 | 3 節の流れ |
| リストの公開 → リアルタイムの照会に反映 | 即時 | 照会の API は最新のリストを引く |
| 端末の記憶の期限 | 5 分以内 | サービスが応答で指定する |
| 手元のリストの更新の間隔 | 15 分（ゆらぎを付ける） | サービスが最小の待ち時間を応答で指定する |

- リアルタイムの照会が有効な端末では、公開から判定まで最大でおよそ 10 分（取り込み 5 分＋記憶の期限 5 分）。リアルタイムを使えない端末（企業のポリシーなど）でも、およそ 20〜25 分で NFR-009 に収まる。
- 更新は差分で受け取る（追加と削除）。適用後の集合のチェックサムを比べ、合わなければ全体を取り直す。
- 更新の応答は署名し、端末で検証する。更新の解析は安全な Rust で行う（[sandbox-and-security.md](sandbox-and-security.md) の 5 節）。
- 失敗したら、指数的に間隔を空ける。サービスが止まっても、最後に受け取ったリストで判定を続け、リストの古さを指標で送る（テレメトリに同意した端末だけ）。

### 2.4 警告の画面

- 全画面の警告にし、危険の種類を説明する。「このまま進む」は、詳細を開いた先に置く。企業のポリシーで進めないようにできる。
- 誤検知の報告を、警告の画面から送れる（送るのは、利用者が明示的に送ると決めた URL だけ）。

## 3. 脅威のリストのサービス

自前で持つ（ADR-0021）。構成は [infrastructure.md](infrastructure.md) の AWS の方針に従う。

```
フィード（商用の契約・利用者の報告・自前の巡回）
   │ 取り込み（ECS のワーカー、5 分ごと＋プッシュ）
   ▼
正規化・重複の除去・採点 ──▶ 保護の一覧（主要サイト）との照合 ──▶ 人の確認（影響の大きい候補だけ）
   │
   ▼
リストの版を作る（全体のスナップショット＋差分）
   ├─▶ S3 ＋ CloudFront（手元のリストの配信）
   └─▶ 照会の API（完全なハッシュの照会・リアルタイムの照会）◀── OHTTP の中継 ◀── 端末
```

| 部品 | 役割 |
| --- | --- |
| フィードの取り込み | 商用のフィード（例：abuse.ch の商用の API、フィッシングの商用のフィード、業界団体の交換の枠組み）を、契約の条件の範囲で取り込む |
| 利用者の報告 | 警告の画面とメニューからの報告。自動の採点の後、人が確認する |
| 自前の巡回 | 報告された URL と、フィードの周辺の URL を、隔離した環境で開いて分類する（MVP の後） |
| 保護の一覧 | 利用者の多いサイト・共有のホスティングのドメインを、ドメイン全体で載せないようにする。誤検知の影響が大きいものを人の確認に回す |
| 異議の受付 | サイトの運営者が、載ったことへの異議を申し立てる窓口。確認の目標は 24 時間 |
| 配信 | 版ごとのスナップショットと差分を、CDN で配る（S2 から CDN に寄せる。[README.md](README.md) の規模の段階） |
| 照会の API | 接頭辞を受け取り、完全なハッシュを返す。OHTTP のゲートウェイを前に置く |

- サービスが持つのは、脅威の URL（公開の情報）とハッシュだけ。端末からの照会は、接頭辞を集計の指標に使うだけで、記録しない。
- 手元のリストの配信の CDN のログは、IP アドレスを含むため、保持を短くする（期間は [observability.md](observability.md)）。

## 4. ダウンロードの保護

| 検査 | 場所 | 内容 |
| --- | --- | --- |
| ファイルの種類の危険度 | Browser | 拡張子と中身の種類で、実行できる形式（`.exe`、`.msi`、`.dmg`、`.pkg`、`.deb`、`.sh` など）を危険度で分ける |
| 取得元の URL の連鎖 | Browser | リダイレクトを含む URL の連鎖を、2 節の仕組みで照合する |
| ファイルのハッシュ | Browser ＋ サービス | 実行できる形式は、SHA-256 の接頭辞で、既知の危険なファイルの一覧と照合する |
| アーカイブの中身 | Utility（サンドボックス） | ZIP などを展開し、中の実行できるファイルを同じく検査する（Rule of 2） |
| 安全でない取得 | Browser | HTTPS のページから HTTP で取得するダウンロードを止める |
| OS との連携 | Browser | Windows は Mark of the Web（ゾーンの情報）と添付ファイルの実行のサービス、macOS は隔離の属性（quarantine）を付け、OS の検査（SmartScreen、Gatekeeper）に渡す |

- 危険と判定したら、ダウンロードの一覧で止め、利用者が明示的に「保存する」を選ぶまで開けない。
- 強化の段階を選んだ利用者は、判定できないファイルのハッシュと種類をサービスに送り、判定を受ける（URL は送らない）。

## 5. 権限

### 5.1 モデル

ADR-0022 で決める。

- **単位**：要求したオリジン（スキーム・ホスト・ポート）と、最上位のフレームのオリジンの組。iframe の中の要求は、最上位が Permissions Policy（`allow` 属性）で委ねたときだけ扱い、確認の画面には最上位のオリジンを表示する。
- **状態**：確認する・許可・ブロック。許可は「常に」と「今回だけ」（タブを閉じるなど、一定の時間の後に消える）を選べる。
- **前提**：安全なコンテキスト（HTTPS）でだけ要求できる。多くの権限は、利用者の操作（user activation）の直後だけ確認を出す。
- **OS の権限**：カメラ・マイク・位置は、OS の許可も要る。OS で拒否されていたら、OS の設定への案内を出す。
- **同期しない**：MVP では、サイトの権限を端末の間で同期しない（別の端末では、あらためて確認する）。

| 権限 | 永続の許可 | 備考 |
| --- | --- | --- |
| 位置、カメラ、マイク | 常に・今回だけ | 使用中はアドレスバーに表示する |
| 通知 | 常に | 静かな確認と自動の失効の対象 |
| クリップボードの読み取り | 常に | |
| 画面の共有 | なし（毎回確認） | 共有中は表示する |
| MIDI（SysEx） | 常に | |
| ポップアップ・リダイレクト、自動のダウンロードの複数 | 設定（コンテンツ設定） | 確認ではなく、ブロックした旨を表示する |
| 保存領域へのアクセス（Storage Access API） | 常に | [networking.md](networking.md) の Cookie の制限と合わせる |

### 5.2 確認の画面

- アドレスバーに結び付けた吹き出しで出す（ページが描けない領域。[sandbox-and-security.md](sandbox-and-security.md) の 9 節）。
- **一時の抑止（embargo）**：同じオリジンの確認を利用者が続けて閉じたら、一定の期間、自動でブロックする。回数と期間は本家と同じ 3 回・7 日（`kDefaultDismissalsBeforeBlock = 3`、`kDefaultEmbargoDays = 7`。無視は 4 回。静かな確認では閉じる 1 回・無視 2 回。[permission_decision_auto_blocker.cc](https://source.chromium.org/chromium/chromium/src/+/main:components/permissions/permission_decision_auto_blocker.cc)、2026-09-27 に確認）。
- **静かな確認**：通知の確認は、次のときに、吹き出しではなくアドレスバーの小さな表示にする。
  - 利用者が「静かな確認」を選んだ。
  - 利用者が通知の確認を何度も拒否している（端末の中の判断）。
  - そのサイトが、悪用する通知のリスト（3 節のサービスが配る）に入っている。
  - 本家は、サイトごとの許可率（多くの利用者の集計）で静かな確認を決める。ここでは、利用者の閲覧のデータを集めないため、許可率による判断は使わない（ADR-0005）。

### 5.3 自動の失効

- **使っていないサイト**：60 日（本家と同じ。`kUnusedSitePermissionsRevocationThreshold = base::Days(60)`。[unused_site_permissions_manager.cc](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/ui/safety_hub/unused_site_permissions_manager.cc)、2026-09-27 に確認）訪れていないサイトの許可を外し、安全の確認の画面で知らせる。利用者は戻せる。
- **通知の多いサイト**：関わりの少ないサイトが大量の通知を送るとき、通知の許可を外す。関わりの度合いは端末の中で計算する。
- **悪用するサイト**：悪用する通知のリストに入ったサイトの通知の許可を外す。
- 企業のポリシーで許可を固定した権限は、自動では外さない。

## 6. パスワードマネージャ

### 6.1 保存

ADR-0023 で決める。

- プロファイルごとの DB（SQLite）に、ログインの記録（オリジン、ユーザー名、暗号化したパスワード、作成・使用の日時）を持つ。
- パスワードの値は、プロファイルごとのデータ鍵で AEAD（AES-256-GCM）で暗号化する。データ鍵は OS の鍵ストアで守る。

| OS | データ鍵の保護 |
| --- | --- |
| Windows | DPAPI。加えて、ブラウザの実行ファイルに結び付ける保護（本家の app-bound encryption の形）を検討する（本家は Chrome 127 から。[Improving the security of Chrome cookies on Windows](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html)。自前で作れるかは未検証で、E5 で確かめる） |
| macOS | キーチェーン（ブラウザのアプリに限った項目） |
| Linux | Secret Service（libsecret）か KWallet。どちらも使えない環境では、平文に近い保護しかないことを設定の画面で示す |

- パスワードの表示・書き出し（CSV）・編集の前に、OS の再認証（Windows Hello、Touch ID、OS のパスワード）を求める。

### 6.2 入力

- 保存したオリジンと完全に一致するフレームにだけ、自動で入力の候補を出す。同じ登録可能ドメインの別のサブドメインは、候補に出すが、利用者が選ぶまで入力しない。
- 値は、入力する瞬間に、そのフレームのプロセス（鍵が合うもの）にだけ渡す（[sandbox-and-security.md](sandbox-and-security.md) の 3 節）。
- HTTP のページでは、自動の入力をしない（利用者が選べば入力する）。
- 強いパスワードの生成と、保存の提案を持つ。

### 6.3 同期

- パスワードは必ずエンドツーエンドで暗号化して同期する（ADR-0005）。同期の鍵の階層（利用者の鍵、回復用のコード、端末の追加）は [sync-and-accounts.md](sync-and-accounts.md) にある。
- パスワードの記録は、記録ごとに、同期の鍵から導いたパスワード用の鍵で暗号化する。サービスは暗号文と、衝突を避けるための不透明な識別子だけを持つ。オリジンも暗号文の中に入れる。

### 6.4 漏洩の確認

- 保存したパスワードが、公開された漏洩のデータに含まれているかを、**k-匿名性**で確かめる（ADR-0023）。
- 方式：パスワードの SHA-1 の先頭 5 文字（16 進）だけを送り、その範囲に入るハッシュの後半の一覧（詰め物を加えて件数を隠したもの）を受け取り、端末で比べる。Have I Been Pwned の Pwned Passwords の範囲 API と同じ形。
- 照会先：Pwned Passwords のデータを自前の CDN に写して配るか、範囲 API を直接使う。全体のデータは公式の PwnedPasswordsDownloader で取れるが、取ったデータの利用と再配布の条件は書かれていない。利用規約は、同等のサービスを作ることを禁じる一般の条項を持つ（[Terms of Use](https://haveibeenpwned.com/TermsOfUse)）。自前の写しは法務の確認（[intent.md](../intent.md) の L5）の後に限る。範囲 API は、API キーが要らず、「ライセンスと帰属の要件はない」とされる。`Add-Padding: true` で応答の件数を揃えられる（[HIBP API v3](https://haveibeenpwned.com/API/v3)、2026-09-27 に確認）。商用の利用を明示的に認める文言はない。
- 照会は OHTTP の中継を通し、IP アドレスと接頭辞を結び付けられないようにする。
- 確認する時点：パスワードを保存・使用したとき（既定で有効。送るのは接頭辞だけ）と、パスワードの確認の画面を開いたとき。
- 本家の Password Checkup は、ユーザー名とパスワードの組を、ハッシュの接頭辞と秘匿集合演算で照会する。ユーザー名との組で確かめる方式は、漏洩のデータの入手と秘匿集合演算の実装が要るため、MVP の後に検討する。

## 7. パスキー

- WebAuthn（Level 3）の API を実装する。**RP ID の検査とクライアントのデータの作成は Browser プロセスで行う。** RP ID は、フレームの確定したオリジンの登録可能な接尾辞でなければならない。Renderer が作ったクライアントのデータは使わない。
- 認証器：

| 認証器 | MVP | 方法 |
| --- | --- | --- |
| セキュリティ キー（USB・NFC） | あり | CTAP2。デバイスへのアクセスは Browser プロセス |
| OS のプラットフォームの認証器 | あり | Windows は Windows Hello の WebAuthn の API、macOS は OS のパスキーの API（ブラウザ向けの entitlement `com.apple.developer.web-browser.public-key-credential` が要る。macOS 13.3 以降。Account Holder が申請し、Apple が既定のブラウザの基準で審査して与える。[Apple のドキュメント](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)、2026-09-27 に確認）。Linux は OS の仕組みがないため、自前の提供者だけ |
| 自前のパスキーの提供者（パスワードマネージャに保存し、E2EE で同期） | MVP の後（E8） | 秘密鍵は端末の外では暗号文だけにする。本家の Google Password Manager と同じ考え方 |
| 他の端末（スマートフォン）による認証（hybrid） | MVP の後 | |

- 条件付きの UI（ユーザー名の欄の自動入力の候補にパスキーを出す）を、MVP に含める。

## 8. HTTPS-First

- **既定で有効にする。** 本家は 2026 年 10 月の Chrome 154 で「常に安全な接続を使用する」を既定にした。これに合わせる。
- ナビゲーションは、HTTP の URL でも、まず HTTPS で試す。HTTPS で失敗したら、公開のサイトについては警告の画面を出し、利用者の確認の後に HTTP で開く。
- 次のものは警告しない：`localhost`、プライベートの IP アドレス、単一のラベルのホスト名、`.local` など、組織の中のもの。企業のポリシーで対象外のホストを指定できる。
- 利用者が HTTP で進んだサイトは、一定の期間、警告を出さない（15 日。本家と同じ。`kHTTPSFirstModeBypassExpirationInSeconds = 1296000`。[stateful_ssl_host_state_delegate.cc](https://source.chromium.org/chromium/chromium/src/+/main:components/security_interstitials/content/stateful_ssl_host_state_delegate.cc)、2026-09-27 に確認）。
- 混在コンテンツ：サブリソースは HTTPS に自動で格上げし、できなければブロックする。
- HSTS と HSTS のプリロードの一覧は [networking.md](networking.md) にある。

## 9. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - Safe Browsing：正規化と照合する式の生成を、本家の v4 の文書の例で表駆動テストにする。リストの差分の適用の性質（差分を順に適用した結果が全体の取り直しと一致する）を性質ベースのテストにする。NFR-009 を、テスト用の URL を載せてから端末で判定されるまでの時間で、本番で常時測る。
  - 権限：侵害された Renderer が他のオリジンの名で権限を求めても、Browser のオリジンで判断されることを確かめる。
  - パスワード：鍵の合わないフレームに値が渡らないこと。同期のデータに平文が無いこと（ADR-0005 の検査）。
  - パスキー：RP ID の検査を、正しい・誤った組み合わせの決定表でテストする。
- [runbooks/](../runbooks/) に入れる候補：Safe Browsing のリストの配信・照会の障害（端末は手元のリストで続けるため、復旧の優先度と、古さの指標の見方）、誤検知の大規模な発生（主要サイトを載せた場合の緊急の削除）、フィードの停止・契約の終了。
- [data-model.md](data-model.md) の索引に入れる候補：
  - 端末：Safe Browsing の手元のリスト（接頭辞・版・チェックサム）、照会の結果の記憶、サイトの権限（コンテンツ設定）、一時の抑止の記録、ログインの DB、パスワードのデータ鍵（OS の鍵ストア）、ダウンロードの判定の記録。
  - サービス：脅威の URL とハッシュ、リストの版（スナップショット・差分）、利用者の報告、異議の申し立て、保護の一覧、パスワードの暗号文（同期のサービス）。

## 10. 未解決の問いと未検証の事項

- OHTTP の中継を、どの事業者に運用してもらうか（中継とサービスが結託しないことの担保）。
- 商用の脅威のフィードの選定と費用。Google との契約（Web Risk、Safe Browsing の商用の枠組み）を後で結ぶか（ADR-0021）。
- Pwned Passwords のデータを自前で写して配ってよいか（配布の条件）。
- 2026-09-27 に確かめたもの：一時の抑止の回数と期間（3 回・7 日）、使っていないサイトの許可を外すまでの日数（60 日）、HTTPS-First で警告を出さない期間（15 日）、macOS のパスキーの entitlement の条件。どれも本家の値と同じにした。
- 未検証：Windows の app-bound encryption に相当する保護を自前で作れるか。E5 の Story で実機で確かめる。

## References

- Google: [Safe Browsing API（v5）Overview](https://developers.google.com/safe-browsing/reference)（ハッシュの接頭辞、リアルタイム・手元のリストのモード、OHTTP、非商用の限定）
- Google: [Safe Browsing Update API（v4）](https://developers.google.com/safe-browsing/v4/update-api)（手元の接頭辞の DB、最小の待ち時間、記憶の期間）
- Google: [Safe Browsing の利用の制限](https://developers.google.com/safe-browsing/v4/usage-limits)（非商用に限る。商用は Web Risk）
- Google Cloud: [Web Risk Overview](https://docs.cloud.google.com/web-risk/docs/overview)、[Web Risk Pricing](https://cloud.google.com/web-risk/pricing)
- Google Online Security Blog: [Real-time, privacy-preserving URL protection（2024-03）](https://security.googleblog.com/2024/03/blog-post.html)
- Google Online Security Blog: [Protect your accounts from data breaches with Password Checkup（2019-02）](https://security.googleblog.com/2019/02/protect-your-accounts-from-data.html)
- Have I Been Pwned: [API v3（Pwned Passwords の範囲 API）](https://haveibeenpwned.com/API/v3)
- Chromium Blog: [Introducing quieter permission UI for notifications（2020-01）](https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html)
- Chromium Blog: [Reducing notification overload for a quieter browsing experience in Chrome（2025-10）](https://blog.chromium.org/2025/10/automatic-notification-permission.html)
- Google Chrome Help: [Manage Chrome safety and security](https://support.google.com/chrome/answer/10468685)（使っていないサイトの権限の自動の削除）
- Google: [HTTPS by default](https://blog.google/security/https-by-defau/)（Chrome 154 で既定に）
- Google: [More users can now save passkeys in Google Password Manager（2024-09）](https://blog.google/innovation-and-ai/technology/safety-security/google-password-manager-passkeys-update-september-2024/)
- W3C: [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
