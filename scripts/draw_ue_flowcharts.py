"""Generate the three UE composition flowcharts with Graphviz.

Run from the project root:
    python scripts/draw_ue_flowcharts.py
"""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "前期调研" / "图表"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "Microsoft YaHei"
GRAPH_ATTRS = (
    'rankdir=TB; newrank=true; bgcolor="white"; pad="0.35"; nodesep="0.38"; ranksep="0.48"; '
    f'splines="polyline"; fontname="{FONT}"; fontsize=12;'
)
NODE_ATTRS = (
    f'fontname="{FONT}"; fontsize=12; shape=box; style="rounded,filled"; '
    'color="#7A8A99"; fillcolor="#F5F7FA"; penwidth=1.2; margin="0.22,0.12";'
)
EDGE_ATTRS = (
    f'fontname="{FONT}"; fontsize=11; color="#6B7C93"; arrowsize=0.8; penwidth=1.1;'
)

REV = 'fillcolor="#EAF2FB"; color="#3E6D9C"'
COST = 'fillcolor="#FCECEC"; color="#A94A45"'
OP_COST = 'fillcolor="#FDF0E3"; color="#B26A2E"'
TOTAL = 'fillcolor="#E8EEF7"; color="#2F4B6E"; penwidth=2.0'
RESULT = 'fillcolor="#E8F5E9"; color="#2E7D32"; penwidth=2.4'
DECISION = 'shape=diamond; fillcolor="#FFF4D6"; color="#A67C00"; penwidth=1.6; margin="0.04,0.02"'
NOTE = f'shape=note; style="filled"; fillcolor="#FAFAF3"; color="#B9B9A6"; fontsize=11; margin="0.18,0.10"'
GOOD = 'fillcolor="#E8F5E9"; color="#2E7D32"'
BAD = 'fillcolor="#FCECEC"; color="#A94A45"'


def node(name: str, label: str, extra: str = "") -> str:
    return f'  {name} [label="{label}"{"; " + extra if extra else ""}];\n'


def edge(a: str, b: str, label: str = "", extra: str = "") -> str:
    attrs = []
    if label:
        attrs.append(f'label=" {label} "')
    if extra:
        attrs.append(extra)
    return f"  {a} -> {b}" + (f" [{'; '.join(attrs)}]" if attrs else "") + ";\n"


def platform_dot() -> str:
    s = "digraph platform_ue {\n"
    s += f"  graph [{GRAPH_ATTRS} label=<<B>平台 UE：收入减成本</B>>; labelloc=t; fontsize=20; fontcolor=\"#22313F\"];\n"
    s += f"  node [{NODE_ATTRS}];\n  edge [{EDGE_ATTRS}];\n"

    s += '  subgraph cluster_rev {\n'
    s += '    label="平台收入"; fontsize=13; fontcolor="#2F5D8A"; style="rounded,dashed"; color="#A9C0D8"; margin=10;\n'
    s += node("commission", "技术服务费和佣金收入", REV)
    s += node("delivery", "配送收入\\n（商家配送服务费 + 顾客配送费）", REV)
    s += node("promotion", "推广和广告收入", REV)
    s += node("other", "其他收入", REV)
    s += "    { rank=same; commission; delivery; promotion; other; }\n"
    s += "  }\n"
    s += node("revenue", "平台总收入", TOTAL)

    s += '  subgraph cluster_cost {\n'
    s += '    label="平台成本"; fontsize=13; fontcolor="#8E3B36"; style="rounded,dashed"; color="#D8B3B0"; margin=10;\n'
    s += node("rider", "骑手配送成本", COST)
    s += node("subsidy", "平台补贴（用户和商家）", COST)
    s += node("rider_sub", "骑手补贴", COST)
    s += node("variable", "支付、客服等变动成本", COST)
    s += "    { rank=same; rider; subsidy; rider_sub; variable; }\n"
    s += "  }\n"
    s += node("cost_total", "平台成本合计", 'fillcolor="#F7E3E2"; color="#8E3B36"; penwidth=2.0')

    for n in ("commission", "delivery", "promotion", "other"):
        s += edge(n, "revenue")
    for n in ("rider", "subsidy", "rider_sub", "variable"):
        s += edge(n, "cost_total")

    s += edge("revenue", "ue", "+")
    s += edge("cost_total", "ue", "-")
    s += node("ue", "平台单均 UE\\n= 平台总收入 - 平台成本合计", RESULT)
    s += node("decision", "平台 UE ≥ 0？", DECISION)
    s += edge("ue", "decision")
    s += node("ok", "平台侧可持续", GOOD)
    s += node("bad", "平台侧亏损\\n调价 / 调补贴 / 调履约", BAD)
    s += edge("decision", "ok", "是")
    s += edge("decision", "bad", "否")
    s += "}\n"
    return s


def merchant_dot() -> str:
    s = "digraph merchant_ue {\n"
    s += f"  graph [{GRAPH_ATTRS} label=<<B>商家 UE：结算减经营成本</B>>; labelloc=t; fontsize=20; fontcolor=\"#22313F\"];\n"
    s += f"  node [{NODE_ATTRS}];\n  edge [{EDGE_ATTRS}];\n"

    s += '  subgraph cluster_gross {\n'
    s += '    label="结算前收入"; fontsize=13; fontcolor="#2F5D8A"; style="rounded,dashed"; color="#A9C0D8"; margin=10;\n'
    s += node("goods", "商品金额", REV)
    s += node("packaging", "包装费", REV)
    s += node("delivery_receivable", "商家应收配送费", REV)
    s += node("platform_subsidy", "平台补贴商家", REV)
    s += "    { rank=same; goods; packaging; delivery_receivable; platform_subsidy; }\n"
    s += "  }\n"
    s += node("gross", "商家结算前收入", TOTAL)

    s += '  subgraph cluster_deduct {\n'
    s += '    label="结算扣减"; fontsize=13; fontcolor="#8E3B36"; style="rounded,dashed"; color="#D8B3B0"; margin=10;\n'
    s += node("merchant_subsidy", "商家活动补贴", COST)
    s += node("tech_fee", "技术服务费", COST)
    s += node("delivery_fee", "配送服务费", COST)
    s += node("promo_fee", "推广服务费", COST)
    s += "    { rank=same; merchant_subsidy; tech_fee; delivery_fee; promo_fee; }\n"
    s += "  }\n"
    s += node("deduct_total", "结算扣减合计", 'fillcolor="#F7E3E2"; color="#8E3B36"; penwidth=2.0')

    for n in ("goods", "packaging", "delivery_receivable", "platform_subsidy"):
        s += edge(n, "gross")
    for n in ("merchant_subsidy", "tech_fee", "delivery_fee", "promo_fee"):
        s += edge(n, "deduct_total")

    s += edge("gross", "settlement", "+")
    s += edge("deduct_total", "settlement", "-")
    s += node("settlement", "商家结算金额\\n= 结算前收入 - 结算扣减合计", TOTAL)

    s += '  subgraph cluster_operating {\n'
    s += '    label="经营成本"; fontsize=13; fontcolor="#9A5A24"; style="rounded,dashed"; color="#E4C3A2"; margin=10;\n'
    s += node("food_cost", "食材成本", OP_COST)
    s += node("pack_cost", "包装成本", OP_COST)
    s += node("refund", "退款和赔付", OP_COST)
    s += node("labor", "增量人工", OP_COST)
    s += "    { rank=same; food_cost; pack_cost; refund; labor; }\n"
    s += "  }\n"
    s += node("cost_total", "经营成本合计", 'fillcolor="#FBE7D2"; color="#B26A2E"; penwidth=2.0')
    for n in ("food_cost", "pack_cost", "refund", "labor"):
        s += edge(n, "cost_total")

    s += edge("settlement", "contribution", "+")
    s += edge("cost_total", "contribution", "-")
    s += node("contribution", "商家单均贡献\\n= 商家结算金额 - 经营成本合计", RESULT)
    s += node("decision", "商家单均贡献 ≥ 0？", DECISION)
    s += edge("contribution", "decision")
    s += node("ok", "供给可持续", GOOD)
    s += node("bad", "供给不可持续\\n调价 / 调补贴 / 调成本", BAD)
    s += edge("decision", "ok", "是")
    s += edge("decision", "bad", "否")
    s += "}\n"
    return s


def sku_dot() -> str:
    s = "digraph sku_ue {\n"
    s += f"  graph [{GRAPH_ATTRS} label=<<B>SKU UE：单品直接取数，多品按规则分摊</B>>; labelloc=t; fontsize=20; fontcolor=\"#22313F\"];\n"
    s += f"  node [{NODE_ATTRS}];\n  edge [{EDGE_ATTRS}];\n"

    s += node("order", "订单级数据\\n商品金额、优惠、退款\\n平台费、补贴、配送费")
    s += node("decision", "一单一品？", DECISION)
    s += edge("order", "decision")

    s += node("single", "SKU UE = 订单 UE", RESULT)
    s += edge("decision", "single", "是")

    s += node("multi", "多品分摊", 'fillcolor="#FFF4D6"; color="#A67C00"')
    s += edge("decision", "multi", "否")

    s += node("split_goods", "商品金额、优惠、退款\\n按商品金额占比分摊")
    s += node("split_base", "餐盒费计入分摊基数\\n打包袋、配送费不摊入商品")
    s += node("split_delivery", "配送成本\\n按订单或距离单独分摊")
    s += node("sku_data", "SKU 收入与成本")
    s += node("sku_ue", "SKU UE", RESULT)
    s += edge("multi", "split_goods")
    s += edge("split_goods", "split_base")
    s += edge("split_base", "split_delivery")
    s += edge("split_delivery", "sku_data")
    s += edge("sku_data", "sku_ue")
    s += edge("single", "sku_ue", "")

    s += node(
        "rules",
        "分摊规则\\n单品优惠 = 单品金额 / 商品金额合计 × 优惠总额\\n只有参与优惠的商品分摊\\n小数只舍不入，最后一个商品倒算尾差",
        NOTE,
    )
    s += edge("rules", "split_goods", "", "style=dashed; arrowhead=none")
    s += node("diag", "用于诊断\\n价格 / 补贴 / 成本 / 需求 / 供给履约", 'fillcolor="#FAFAF3"; color="#B9B9A6"')
    s += edge("sku_ue", "diag")
    s += "}\n"
    return s


def build(name: str, dot: str) -> None:
    dot_path = OUT / f"{name}.dot"
    png_path = OUT / f"{name}.png"
    svg_path = OUT / f"{name}.svg"
    dot_path.write_text(dot, encoding="utf-8")
    subprocess.run(["dot", "-Tpng", "-Gdpi=170", str(dot_path), "-o", str(png_path)], check=True)
    subprocess.run(["dot", "-Tsvg", str(dot_path), "-o", str(svg_path)], check=True)
    print(f"wrote {png_path}")
    print(f"wrote {svg_path}")


if __name__ == "__main__":
    build("ue_platform", platform_dot())
    build("ue_merchant", merchant_dot())
    build("ue_sku", sku_dot())
