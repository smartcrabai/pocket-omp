# ADR-003: Bounded ContextごとのClean Architecture

## 決定
Relay、Control、Host/Runtime、MobileごとにDomain・Application・Adapter・Composition Rootを分離する。

## 背景
Framework型や生成型が業務規則へ流入すると交換性と単体検証性を失う。

## 選択肢
レイヤなし、repository全体の単一レイヤ、Context単位のレイヤを比較した。

## 結果
CoreからConnect、DB、Expo、OMP SDKへの依存をarchitecture scannerとcrate graphで拒否する。

## 見直し条件
Context境界または責務が変わるとき。
