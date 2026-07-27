# ADR-010: ControlとRelayのDB ownership分離

## 決定
本番ではControlと各Relay regionが独立DB owner/clusterを持ち、cross-context joinと直接参照を禁止する。

## 背景
障害・権限・migrationの境界をContext責務と一致させる必要がある。

## 選択肢
共有schema、共有cluster別schema、独立owner/clusterを比較した。

## 結果
連携はTicket、internal event、private Connect serviceに限定する。

## 見直し条件
Context統合またはデータ所有権変更時。
