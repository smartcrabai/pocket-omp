# ADR-009: 短期Relay Ticketとdurable invalidation

## 決定
ControlがEd25519署名の10分以下Ticketを発行し、RelayがJWKSでlocal検証する。即時失効はdurable eventで伝える。

## 背景
Relay requestごとのControl同期問い合わせを避けつつ失効遅延を制限する。

## 選択肢
長期credential、opaque token introspection、短期署名Ticketを比較した。

## 結果
Ticketへdevice、route、region、epoch、entitlementをbindingする。event欠落時もTTLが上限となる。

## 見直し条件
Ticket TTLまたは失効SLOを満たせない場合。
