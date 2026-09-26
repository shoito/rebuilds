# Decisions: Auth0

Auth0 の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤の上に、検証済みの部品で認可サーバーを自前で実装する | proposed |
| [0002](0002-tenancy-and-isolation.md) | テナントを分離と設定の単位にし、共有スキーマと RLS で分ける | proposed |
| [0003](0003-token-formats-and-signing-keys.md) | アクセストークンと ID トークンはテナントの鍵で署名した JWT にし、秘密鍵は Signer の中だけで使う | proposed |
| [0004](0004-credential-storage.md) | パスワードは Argon2id、高エントロピーの秘密はハッシュ、戻す必要のある秘密はエンベロープ暗号化で持つ | proposed |
| [0005](0005-authentication-path-availability.md) | 認証の経路を管理の経路から分け、依存先が落ちても縮退して動かし続ける | proposed |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。
