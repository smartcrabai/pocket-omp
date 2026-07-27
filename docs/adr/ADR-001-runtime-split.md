# ADR-001: Rust Relay / Bun Services / Expo Mobile

## 決定
長時間接続と配送はRust、Control・Host・WorkerはBun/TypeScript、MobileはExpoで実装する。

## 背景
配送経路には予測可能なメモリ使用量と高い接続密度、周辺機能にはTypeScriptエコシステムが必要である。

## 選択肢
全TypeScript、全Rust、責務別の言語分割を比較した。

## 結果
言語境界はProtobufと暗号vectorに限定する。運用対象は増えるが各責務に適したruntimeを使える。

## 見直し条件
実測負荷または保守コストがこの分割の利点を否定した場合。
