---
status: accepted
date: 2026-10-09
---

# ADR-0017: 手元の名前は OS のバイト列のまま持ち、`name_key` で比べる。表せない名前・同じ `name_key` の 2 つ目・シンボリックリンク・固定の無視の一覧は「同期しない項目」として状態に出す。属性は実行の属性だけを同期し、拡張属性・ACL・タグは同期しない

## Context

[ADR-0008](0008-node-identity-and-names.md) は、サーバーの名前を NFC で持ち、一意を `name_key` で決め、OS で表せない名前は端末で「同期できない名前」として示すと決めた。端末の側の詳細（どの名前・項目を同期しないか、属性をどこまで同期するか、リンクの扱い）は file-system-integration の領域に残した。

- Windows は `<>:"/\|?*`、制御文字、予約の名前、末尾の空白とピリオドを使えない（[ADR-0008](0008-node-identity-and-names.md)）。
- macOS は NFD の名前を返すことがある。大文字小文字を区別するボリュームもある（Apple の [APFS Guide の FAQ](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/FAQ/FAQ.html)、2026-10-09 に確認）。
- OS とアプリは、同期すべきでないファイル（`.DS_Store`、`Thumbs.db`、Office のロック）を作る。
- 拡張属性・ACL は OS ごとに形が違い、他の OS で表せない。
- 本家の無視の一覧、シンボリックリンク・拡張属性の扱いは、公式の資料で確かめなかった（**未検証**）。

## Options

1. **手元の名前をバイト列のまま持ち、`name_key` で比べる。同期しない項目を理由のコードで示す。属性は実行の属性だけ**
2. 手元の名前を NFC に直して書き換える
3. 表せない名前を、手元で別の名前（置き換えた文字）にして同期する
4. 拡張属性と ACL も同期する

## Decision

1 を採用する。詳細は [file-system-integration.md](../architecture/file-system-integration.md) の 8 節。

- 手元の名前を `local_name` にバイト列のまま持つ。比べるのは `name_key` だけ。
- 同期しない項目の理由のコード：`invalid_char`・`reserved_name`・`trailing_space_dot`・`path_too_long`・`name_too_long`・`name_collision`・`invalid_encoding`・`symlink`・`ignored`・`special_file`。状態の表示に件数と項目を出す。サーバーの名前を変えない。
- 固定の無視の一覧：`.DS_Store`、`.localized`、`Thumbs.db`、`desktop.ini`、`ehthumbs.db`、`~$*`、`.~lock.*#`、`Icon\r`、同期のルート直下の `.<brand>.cache`。利用者が足す規則は MVP では持たない。
- 実行の属性（POSIX の `x`）だけを同期する。拡張属性・Finder のタグ・ACL・所有者は同期しない。
- シンボリックリンク・ジャンクションはたどらず、上げない。ハードリンクは独立のファイルとして同期する。
- Windows で 260 文字を超えるパスは同期し、32,767 UTF-16 単位を超えたら `path_too_long` にする。

### 他の案を選ばなかった理由

- **2（NFC に書き換え）**：他のアプリが NFD で書き戻し、名前の変更が往復する（[ADR-0008](0008-node-identity-and-names.md)）。
- **3（別の名前で同期）**：手元の名前とサーバーの名前の対応が 2 重になり、手元で名前を変えたときにどちらを変えたかが曖昧になる。他の端末から見えない名前の差が残る。
- **4（属性も同期）**：OS の間で表せない値の往復が起き、置き換えのたびに属性の変化が「中身の変更」に混ざる。

## Consequences

- 良くなること：
  - 名前の往復が起きない。表せない名前があっても、他の端末とサーバーに影響しない。
  - 同期しない理由が、理由のコードで利用者と匿名の計測に分かる。
- 引き受けるコスト：
  - Windows の利用者には、macOS で作られた名前が同期できないまま残ることがある。
  - Finder のタグなど、利用者が使う属性が端末の間で移らない。
  - シンボリックリンクに頼る開発の木は、そのままでは同期できない。

## Confirmation

- 表駆動テスト：DT-FS-001（理由のコード × OS）。
- 性質ベーステスト：PROP-FS-004（名前の往復なし）。
- 実機の試験：[quality.md](../quality.md) の 2.2.1 節 B の名前とファイルの種類の場面。
