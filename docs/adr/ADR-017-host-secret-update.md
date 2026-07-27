# ADR-017: Cross-platform Host secret storageと署名更新

## 決定
OS credential storeを優先し、Linux headlessだけArgon2id vaultをfallbackとする。更新manifestはEd25519署名しrelease setを原子的に適用する。

## 背景
秘密鍵を通常file/SQLiteへ保存せず、部分更新によるSDK/TUI skewを防ぐ必要がある。

## 選択肢
設定file、独自keyring、OS store +限定fallbackを比較した。

## 結果
platform adapter contract、staged rollout、checksum、rollbackを必須にする。

## 見直し条件
OS APIまたは配布方式の変更時。
