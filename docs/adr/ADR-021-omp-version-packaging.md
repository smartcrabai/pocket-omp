# ADR-021: OMP SDK/TUI exact-version packaging

## 決定
Host releaseはexact OMP SDK、同release TUI、Runtime、Daemon、CLIを署名済み原子release setとして配布する。

## 背景
SDK/TUI/session format skewは破壊的migrationやresume失敗を起こす。

## 選択肢
system OMP依存、semver range、exact bundled releaseを比較した。

## 結果
初回write前backup、compatibility probe、`NEWER_THAN_RUNTIME` write拒否、rollback manifestを必須にする。

## 見直し条件
OMPが長期安定session ABIを保証した場合。
