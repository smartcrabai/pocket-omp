# ADR-020: TUI/Pocket single-writer ownership

## 決定
1 session = 1 writerをownership lease、sidecar lock、file fingerprint監視、managed handoffで強制する。

## 背景
OMP TUIはPocket lockを認識しないため同時writeはsessionを破損し得る。

## 選択肢
楽観的merge、OS file lockのみ、層状検出と明示handoffを比較した。

## 結果
外部mutation検出時は新commandを止めRuntimeをdisposeし`CONFLICT`へ移る。

## 見直し条件
OMPがcross-process ownership protocolを公式提供する場合。
