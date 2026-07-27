# ADR-012: RevenueCatによる単一entitlement

## 決定
月額・年額productを`relay_pro`へ正規化し、Control DBの`usableUntil`をRelay許可の正本とする。

## 背景
iOS/Android Store差、grace、billing retry、返金を一貫して扱う必要がある。

## 選択肢
Store直接統合、自前billing集約、RevenueCatを比較した。

## 結果
Webhookを署名検証・event IDで冪等化し、periodic reconciliationで欠落を補う。

## 見直し条件
RevenueCatのSLO、価格、Store対応が製品要件を満たさなくなった場合。
