# ADR-013: 公式アプリは公式Relayだけを利用

## 決定
Store配布MobileはControlが署名した公式Relay originだけへ接続する。

## 背景
課金、Push、security response、protocol compatibilityを一つの運用契約で保証する。

## 選択肢
任意self-hosted Relay、公式Relay、両対応を比較した。

## 結果
Relay originはコード固定ではなくTicket署名claimから取得し、任意URL入力は提供しない。

## 見直し条件
別製品lineとしてself-hosted提供を承認した場合。
