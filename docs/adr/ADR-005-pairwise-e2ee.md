# ADR-005: Pairwise E2EE

## 決定
Hostと各Mobileの組ごとにX25519、HKDF-SHA-256、XChaCha20-Poly1305で暗号化する。

## 背景
RelayとControlへsession本文やcontent keyを開示せず、端末単位で失効可能にする必要がある。

## 選択肢
Server-side encryption、account共有鍵、pairwise鍵を比較した。

## 結果
複数Mobileへのeventは個別暗号化する。Canonical AADと共通vectorで実装差を検出する。

## 見直し条件
暗号primitiveの脆弱性、platform Secure Store制約、端末数上限の変更時。
