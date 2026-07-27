# ADR-014: Snapshotとcursor replay

## 決定
通常復旧はACK済みcursorからdelta replayし、retention gap時だけ暗号化snapshotへresetする。

## 背景
長いoffline期間と大きいtranscriptを無制限event保持なしで復元する必要がある。

## 選択肢
全履歴永久保持、snapshotのみ、snapshot + cursorを比較した。

## 結果
snapshotはstate hashとbase eventを内包し、Relayは暗号文だけを保持する。

## 見直し条件
retentionまたはsnapshot cadence変更時。
