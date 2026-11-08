"""Price-gap and over-subsidy engine demo for takeout competition analysis.

Reads a JSON file of aligned observations from three platforms, computes the
out-of-pocket price gap against the cheapest competitor, decomposes the gap
into business levers, estimates over-subsidy, ranks the findings, and writes
a two-column Markdown daily report.

The input is assumed to be pre-aligned: every SKU row has a canonical sku_id
and a store_id. POI/SKU matching is described in the research docs and is
intentionally out of scope for this demo.

Run:
    python price_engine.py --input sample_data.json --out daily_report.md \
        --target-advantage 1.0
"""

import argparse
import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

JD_PLATFORM = "京东外卖"
COMPETITORS = ("美团", "淘宝闪购")

CAUSE_LABELS = {
    "menu": "菜单价高",
    "packaging": "包装费高",
    "delivery": "配送费高",
    "merchant": "商家活动弱",
    "platform": "平台券少",
    "member": "会员权益弱",
    "payment": "支付优惠少",
    "other": "其他差异",
    "over_subsidy": "补贴超发",
    "none": "无劣势",
}

RECOMMENDATIONS = {
    "menu": ("谈调价或换对标套餐", "BD/商家"),
    "packaging": ("调整包装费或合并包装", "商家/运营"),
    "delivery": ("履约补贴或距离定价", "履约"),
    "merchant": ("加商家满减或联合补贴", "BD/商家"),
    "platform": ("申请平台券或活动报名", "平台策略"),
    "member": ("补会员权益", "会员团队"),
    "payment": ("支付立减合作", "支付/财务"),
    "other": ("人工复核价差来源", "运营"),
    "over_subsidy": ("降补或调拨到打不过的店", "补贴运营"),
    "none": ("保持观察", "运营"),
}


def money(value: float) -> str:
    if abs(value) < 0.005:
        value = 0.0
    return f"{value:.2f}"


def load_data(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def index_by_id(rows: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    return {row[key]: row for row in rows}


def group_observations(data: dict[str, Any]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for obs in data["observations"]:
        groups.setdefault((obs["store_id"], obs["sku_id"]), []).append(obs)
    return groups


def priority_band(score: int) -> str:
    if score >= 75:
        return "P0"
    if score >= 50:
        return "P1"
    if score >= 25:
        return "P2"
    return "P3"


def analyze(data: dict[str, Any], target_advantage: float = 1.0) -> dict[str, Any]:
    stores = index_by_id(data["stores"], "store_id")
    skus = index_by_id(data["skus"], "sku_id")
    groups = group_observations(data)

    items: list[dict[str, Any]] = []

    for (store_id, sku_id), rows in groups.items():
        jd_rows = [r for r in rows if r["platform"] == JD_PLATFORM]
        comp_rows = [r for r in rows if r["platform"] in COMPETITORS]
        if not jd_rows or not comp_rows:
            continue

        jd = jd_rows[0]
        comp = min(comp_rows, key=lambda r: r["final_price"])
        gap = round(jd["final_price"] - comp["final_price"], 2)

        # Positive component = makes JD more expensive than this competitor.
        decomposition = {
            "menu": round(jd["list_price"] - comp["list_price"], 2),
            "packaging": round(jd["packaging_fee"] - comp["packaging_fee"], 2),
            "delivery": round(jd["delivery_fee"] - comp["delivery_fee"], 2),
            "merchant": round(-(jd["merchant_discount"] - comp["merchant_discount"]), 2),
            "platform": round(-(jd["platform_discount"] - comp["platform_discount"]), 2),
            "member": round(-(jd["member_discount"] - comp["member_discount"]), 2),
            "payment": round(-(jd["payment_discount"] - comp["payment_discount"]), 2),
        }
        explained = round(sum(decomposition.values()), 2)
        if abs(gap - explained) > 0.01:
            decomposition["other"] = round(gap - explained, 2)

        # Over-subsidy: the part of JD's own subsidy that is not needed to stay
        # at the target price (competitor price minus a small advantage).
        jd_subsidy = float(jd.get("platform_subsidy_cost", 0.0) or 0.0)
        price_before_subsidy = round(jd["final_price"] + jd_subsidy, 2)
        target_price = round(comp["final_price"] - target_advantage, 2)
        necessary_subsidy = round(max(0.0, price_before_subsidy - target_price), 2)
        over_subsidy = round(max(0.0, jd_subsidy - necessary_subsidy), 2)

        if gap > 0:
            main_cause = max(decomposition, key=lambda k: decomposition[k])
            recommendation, owner = RECOMMENDATIONS[main_cause]
            status = "价格劣势"
            action_type = "close_gap"
        elif over_subsidy > 0.005:
            main_cause = "over_subsidy"
            recommendation, owner = RECOMMENDATIONS["over_subsidy"]
            status = "补贴超发"
            action_type = "reduce_subsidy"
        else:
            main_cause = "none"
            recommendation, owner = RECOMMENDATIONS["none"]
            status = "价格优势"
            action_type = "hold"

        store = stores[store_id]
        sku = skus[sku_id]
        item = {
            "store_id": store_id,
            "store_name": store["name"],
            "store_category": store["category"],
            "monthly_gmv": store["monthly_gmv"],
            "sku_id": sku_id,
            "sku_name": sku["name"],
            "spec": sku["spec"],
            "sku_category": sku["category"],
            "jd_final": jd["final_price"],
            "competitor_platform": comp["platform"],
            "competitor_final": comp["final_price"],
            "gap": gap,
            "jd_subsidy": jd_subsidy,
            "price_before_subsidy": price_before_subsidy,
            "target_advantage": target_advantage,
            "target_price": target_price,
            "necessary_subsidy": necessary_subsidy,
            "over_subsidy": over_subsidy,
            "decomposition": decomposition,
            "main_cause": main_cause,
            "main_cause_label": CAUSE_LABELS.get(main_cause, "无劣势"),
            "recommendation": recommendation,
            "owner": owner,
            "status": status,
            "action_type": action_type,
            "evidence": [jd["observation_id"], comp["observation_id"]],
            "jd_observation": jd,
            "competitor_observation": comp,
        }
        items.append(item)

    # Two separate priority scales: one for closing a gap, one for reducing
    # over-subsidy. Both are normalized to 0-100 within their own list.
    gap_raw = {
        id(item): max(item["gap"], 0.0) * math.log10(1 + item["monthly_gmv"])
        for item in items
    }
    subsidy_raw = {
        id(item): max(item["over_subsidy"], 0.0) * math.log10(1 + item["monthly_gmv"])
        for item in items
    }
    max_gap_raw = max(gap_raw.values(), default=0.0)
    max_subsidy_raw = max(subsidy_raw.values(), default=0.0)

    for item in items:
        gap_score = round(100 * gap_raw[id(item)] / max_gap_raw) if max_gap_raw else 0
        subsidy_score = (
            round(100 * subsidy_raw[id(item)] / max_subsidy_raw)
            if max_subsidy_raw else 0
        )
        item["gap_priority"] = gap_score if item["gap"] > 0 else 0
        item["subsidy_priority"] = subsidy_score if item["over_subsidy"] > 0 else 0
        item["priority"] = max(item["gap_priority"], item["subsidy_priority"])
        item["priority_band"] = priority_band(item["priority"])

    items.sort(key=lambda x: (-x["priority"], -x["gap"], -x["over_subsidy"]))

    # Store summary.
    store_summary: list[dict[str, Any]] = []
    for store_id, store in stores.items():
        store_items = [i for i in items if i["store_id"] == store_id]
        if not store_items:
            continue
        disadvantaged = [i for i in store_items if i["gap"] > 0]
        oversubsidized = [i for i in store_items if i["over_subsidy"] > 0]
        avg_gap = (
            round(sum(i["gap"] for i in disadvantaged) / len(disadvantaged), 2)
            if disadvantaged else 0.0
        )
        max_gap = max((i["gap"] for i in store_items), default=0.0)
        top_cause = (
            max(disadvantaged, key=lambda i: i["gap"])["main_cause_label"]
            if disadvantaged else "无"
        )
        max_gap_priority = max((i["gap_priority"] for i in store_items), default=0)
        max_subsidy_priority = max((i["subsidy_priority"] for i in store_items), default=0)
        if max_subsidy_priority > max_gap_priority:
            top_cause = "补贴超发"
        store_summary.append({
            "store_id": store_id,
            "store_name": store["name"],
            "category": store["category"],
            "sku_count": len(store_items),
            "disadvantaged_count": len(disadvantaged),
            "oversubsidy_count": len(oversubsidized),
            "oversubsidy_amount": round(sum(i["over_subsidy"] for i in oversubsidized), 2),
            "avg_gap": avg_gap,
            "max_gap": max_gap,
            "monthly_gmv": store["monthly_gmv"],
            "priority": max((i["priority"] for i in store_items), default=0),
            "top_cause": top_cause,
        })
    store_summary.sort(key=lambda x: (-x["priority"], -x["max_gap"]))

    disadvantaged = [i for i in items if i["gap"] > 0]
    oversubsidized = [i for i in items if i["over_subsidy"] > 0]
    summary = {
        "stores": len({i["store_id"] for i in items}),
        "skus": len(items),
        "observations": sum(len(v) for v in groups.values()),
        "disadvantaged_skus": len(disadvantaged),
        "oversubsidy_skus": len(oversubsidized),
        "jd_cheapest_skus": len([i for i in items if i["gap"] < 0]),
        "avg_gap": round(
            sum(i["gap"] for i in disadvantaged) / len(disadvantaged), 2
        ) if disadvantaged else 0.0,
        "max_gap": max((i["gap"] for i in items), default=0.0),
        "total_over_subsidy": round(sum(i["over_subsidy"] for i in oversubsidized), 2),
        "avg_over_subsidy": round(
            sum(i["over_subsidy"] for i in oversubsidized) / len(oversubsidized), 2
        ) if oversubsidized else 0.0,
        "target_advantage": target_advantage,
        "high_risk_stores": len([s for s in store_summary if s["priority"] >= 75]),
    }

    return {
        "meta": data["meta"],
        "summary": summary,
        "items": items,
        "stores": store_summary,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def render_markdown(result: dict[str, Any]) -> str:
    meta = result["meta"]
    summary = result["summary"]
    items = result["items"]
    stores = result["stores"]
    gap_items = [i for i in items if i["gap"] > 0]
    over_items = [i for i in items if i["over_subsidy"] > 0]

    lines: list[str] = []
    lines.append("# 外卖价格力与补贴效率日报（示例）")
    lines.append("")
    lines.append(
        f"> 日期：{meta['date']} ｜ 范围：{meta['city']}·{meta['business_district']} "
        f"｜ 平台：美团、淘宝闪购、京东外卖"
    )
    lines.append(f"> 数据说明：{meta['note']}")
    lines.append("")

    lines.append("## 今日结论")
    lines.append("")
    if items:
        top_gap = gap_items[0] if gap_items else None
        top_over = max(over_items, key=lambda i: i["over_subsidy"]) if over_items else None
        lines.append(
            f"- 共比对 {summary['skus']} 个可比商品，京东有 {summary['disadvantaged_skus']} 个"
            f"到手价高于最低竞对，平均高 {money(summary['avg_gap'])} 元。"
        )
        if top_gap:
            lines.append(
                f"- 最大价差出现在 {top_gap['store_name']} 的 {top_gap['sku_name']}，"
                f"京东 {money(top_gap['jd_final'])} 元，{top_gap['competitor_platform']} "
                f"{money(top_gap['competitor_final'])} 元，价差 {money(top_gap['gap'])} 元，"
                f"主要原因是{top_gap['main_cause_label']}。"
            )
        lines.append(
            f"- 另有 {summary['oversubsidy_skus']} 个商品存在超补，"
            f"按单次观测合计 {money(summary['total_over_subsidy'])} 元，"
            f"平均每个 {money(summary['avg_over_subsidy'])} 元。"
        )
        if top_over:
            lines.append(
                f"- 最大超补出现在 {top_over['store_name']} 的 {top_over['sku_name']}，"
                f"京东到手价 {money(top_over['jd_final'])} 元，竞对 "
                f"{money(top_over['competitor_final'])} 元，平台补贴 "
                f"{money(top_over['jd_subsidy'])} 元，必要补贴 "
                f"{money(top_over['necessary_subsidy'])} 元，可省 "
                f"{money(top_over['over_subsidy'])} 元。"
            )
        lines.append(
            f"- 共 {summary['high_risk_stores']} 家门店进入 P0 优先级，建议今天处理。"
        )
    else:
        lines.append("- 今日没有可比样本。")
    lines.append("")

    lines.append("## 关键指标")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("|---|---:|")
    lines.append(f"| 覆盖门店 | {summary['stores']} |")
    lines.append(f"| 可比商品 | {summary['skus']} |")
    lines.append(f"| 观测记录 | {summary['observations']} |")
    lines.append(f"| 京东价格劣势商品 | {summary['disadvantaged_skus']} |")
    lines.append(f"| 京东价格优势商品 | {summary['jd_cheapest_skus']} |")
    lines.append(f"| 京东超补商品 | {summary['oversubsidy_skus']} |")
    lines.append(f"| 单次观测超补金额 | {money(summary['total_over_subsidy'])} 元 |")
    lines.append(f"| 平均价差（劣势商品） | {money(summary['avg_gap'])} 元 |")
    lines.append(f"| 最大价差 | {money(summary['max_gap'])} 元 |")
    lines.append(f"| 目标优势 | {money(summary['target_advantage'])} 元 |")
    lines.append("")

    lines.append("## 打不过清单")
    lines.append("")
    if gap_items:
        lines.append(
            "| 优先级 | 门店 | 商品 | 京东到手价 | 最低竞对 | 竞对平台 | 价差 | 主因 | 建议 | 责任方 |"
        )
        lines.append("|---|---|---|---:|---:|---|---:|---|---|---|")
        for item in gap_items:
            lines.append(
                f"| {item['priority_band']} ({item['gap_priority']}) | {item['store_name']} "
                f"| {item['sku_name']}({item['spec']}) | {money(item['jd_final'])} "
                f"| {money(item['competitor_final'])} | {item['competitor_platform']} "
                f"| {money(item['gap'])} | {item['main_cause_label']} "
                f"| {item['recommendation']} | {item['owner']} |"
            )
    else:
        lines.append("今日没有价格劣势商品。")
    lines.append("")

    lines.append("## 超补清单")
    lines.append("")
    if over_items:
        lines.append(
            "| 优先级 | 门店 | 商品 | 京东到手价 | 最低竞对 | 平台补贴 | 必要补贴 | 超补 | 建议 | 责任方 |"
        )
        lines.append("|---|---|---|---:|---:|---:|---:|---:|---|---|")
        for item in over_items:
            lines.append(
                f"| {item['priority_band']} ({item['subsidy_priority']}) | {item['store_name']} "
                f"| {item['sku_name']}({item['spec']}) | {money(item['jd_final'])} "
                f"| {money(item['competitor_final'])} | {money(item['jd_subsidy'])} "
                f"| {money(item['necessary_subsidy'])} | {money(item['over_subsidy'])} "
                f"| {item['recommendation']} | {item['owner']} |"
            )
    else:
        lines.append("今日没有识别到超补商品。")
    lines.append("")

    if gap_items:
        lines.append("## 价差分解（Top 5）")
        lines.append("")
        lines.append(
            "| 商品 | 菜单价 | 包装费 | 配送费 | 商家活动 | 平台券 | 会员 | 支付 | 合计 |"
        )
        lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for item in gap_items[:5]:
            d = item["decomposition"]
            lines.append(
                f"| {item['store_name']}·{item['sku_name']} "
                f"| {money(d.get('menu', 0))} | {money(d.get('packaging', 0))} "
                f"| {money(d.get('delivery', 0))} | {money(d.get('merchant', 0))} "
                f"| {money(d.get('platform', 0))} | {money(d.get('member', 0))} "
                f"| {money(d.get('payment', 0))} | {money(item['gap'])} |"
            )
        lines.append("")
        lines.append(
            "> 正数表示该项让京东更贵，负数表示京东更有优势。"
            "分解按最低竞对逐项相减，交互项暂不单独拆分。"
        )
        lines.append("")

    lines.append("## 门店汇总")
    lines.append("")
    lines.append(
        "| 门店 | 品类 | 可比 SKU | 劣势 SKU | 超补 SKU | 超补金额 | 平均价差 | 最大价差 | 月 GMV | 优先级 | 主因 |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|")
    for store in stores:
        lines.append(
            f"| {store['store_name']} | {store['category']} | {store['sku_count']} "
            f"| {store['disadvantaged_count']} | {store['oversubsidy_count']} "
            f"| {money(store['oversubsidy_amount'])} | {money(store['avg_gap'])} "
            f"| {money(store['max_gap'])} | {store['monthly_gmv']:,} "
            f"| {store['priority']} | {store['top_cause']} |"
        )
    lines.append("")

    lines.append("## 证据示例")
    lines.append("")
    evidences = gap_items[:2] + over_items[:2]
    if not evidences:
        evidences = items[:3]
    for item in evidences:
        jd = item["jd_observation"]
        comp = item["competitor_observation"]
        lines.append(
            f"- {item['store_name']}·{item['sku_name']}：京东观测 {jd['observation_id']}"
            f"（探针 {jd['probe_id']}，{jd['captured_at']}），"
            f"{comp['platform']}观测 {comp['observation_id']}"
            f"（探针 {comp['probe_id']}，{comp['captured_at']}）。"
        )
    lines.append("")

    lines.append("## 方法说明")
    lines.append("")
    lines.append(
        "- 到手价 = 商品原价 + 打包费 + 配送费 - 商家优惠 - 平台券 - 会员权益 - 支付优惠。"
    )
    lines.append(
        "- 价差 = 京东到手价 - 最低竞对到手价。正数表示京东更贵，负数表示京东更便宜。"
    )
    lines.append(
        "- 目标价 = 竞对到手价 - 目标优势。必要补贴 = max(0, 京东补贴前价格 - 目标价)。"
        "超补 = max(0, 实际补贴 - 必要补贴)。"
    )
    lines.append(
        "- 价差分解把总价差拆到菜单价、包装费、配送费、商家活动、平台券、会员、支付七项，"
        "用来定位可执行的动作。"
    )
    lines.append(
        "- 两类优先级分别 = 价差或超补 × log(1 + 月 GMV)，各自归一化到 0 到 100。"
        "它用于排序，不直接代表业务收益。"
    )
    lines.append(
        "- 超补金额按单次观测计算，乘订单量才能估算月度可节省金额。"
    )
    lines.append(
        "- 本报告使用模拟数据，只演示计算和报告格式，不构成任何真实商户或平台的价格结论。"
    )
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compute takeout price gaps and over-subsidy from aligned observations."
    )
    parser.add_argument("--input", default="sample_data.json", help="Input JSON file")
    parser.add_argument("--out", default="daily_report.md", help="Output Markdown report")
    parser.add_argument("--alerts", default="alerts.json", help="Output alerts JSON")
    parser.add_argument(
        "--target-advantage",
        type=float,
        default=1.0,
        help="Yuan advantage JD wants to keep over the cheapest competitor",
    )
    args = parser.parse_args()

    base = Path(__file__).resolve().parent
    input_path = (base / args.input) if not Path(args.input).is_absolute() else Path(args.input)
    out_path = (base / args.out) if not Path(args.out).is_absolute() else Path(args.out)
    alerts_path = (base / args.alerts) if not Path(args.alerts).is_absolute() else Path(args.alerts)

    data = load_data(input_path)
    result = analyze(data, target_advantage=args.target_advantage)

    out_path.write_text(render_markdown(result), encoding="utf-8")
    alerts_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"report: {out_path}")
    print(f"alerts: {alerts_path}")
    print(
        f"items={result['summary']['skus']} "
        f"disadvantaged={result['summary']['disadvantaged_skus']} "
        f"over_subsidy={result['summary']['oversubsidy_skus']} "
        f"max_gap={result['summary']['max_gap']}"
    )


if __name__ == "__main__":
    main()
