# ADR-015: Paired-region同期durability

## 決定
`Accepted`はhomeとstandby双方のmessage・dedupe・sequenceがdurableになり、homeがdeliverable確定した後に返す。

## 背景
Region loss後もAccepted messageのRPO 0が必要である。

## 選択肢
単一region、非同期cross-region、同期paired-regionを比較した。

## 結果
standby障害時は成功を返さずrepair outboxへ残す。Latencyとavailabilityに同期write分の費用を受け入れる。

## 見直し条件
SLOまたは利用地域のlatencyが規定を満たせない場合。
