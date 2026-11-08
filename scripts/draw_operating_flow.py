"""Draw the operating loop as one decision-oriented flowchart.

Solid boxes are operating actions. Dashed boxes are inputs, outputs, metrics
and selection constraints. Diamonds are decisions. Green dashed arrows are
review feedback; orange dashed arrows are failed-gate returns.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "前期调研" / "图表"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "Microsoft YaHei"
INK = "#22313F"
MUTED = "#647385"
LINE = "#CFD8E2"
BG = "#F7F9FB"
ARROW = "#53677A"
FEED = "#2E6B57"
BACK = "#B26A2E"

plt.rcParams["font.family"] = FONT
plt.rcParams["axes.unicode_minus"] = False


def wrap_mixed(text: str, max_units: float) -> str:
    lines = []
    current = ""
    units = 0.0
    for ch in text:
        if ch == "\n":
            lines.append(current)
            current, units = "", 0.0
            continue
        u = 1.0 if ord(ch) > 127 else 0.55
        if current and units + u > max_units:
            lines.append(current)
            current, units = "", 0.0
        current += ch
        units += u
    if current:
        lines.append(current)
    return "\n".join(lines)


def box(
    ax,
    x,
    y,
    w,
    h,
    fc="#FFFFFF",
    ec=LINE,
    lw=1.05,
    rad=0.06,
    z=2,
    dashed=False,
    shadow=False,
):
    if shadow:
        ax.add_patch(
            FancyBboxPatch(
                (x + 0.03, y - 0.035),
                w,
                h,
                boxstyle=f"round,pad=0,rounding_size={rad}",
                linewidth=0,
                facecolor="#E1E6EC",
                zorder=z - 1,
            )
        )
    ax.add_patch(
        FancyBboxPatch(
            (x, y),
            w,
            h,
            boxstyle=f"round,pad=0,rounding_size={rad}",
            linewidth=lw,
            edgecolor=ec,
            facecolor=fc,
            linestyle=(0, (4, 2)) if dashed else "-",
            zorder=z,
        )
    )


def text(
    ax,
    x,
    y,
    s,
    size=6.7,
    color=INK,
    weight="normal",
    ha="left",
    va="top",
    z=6,
    style="normal",
    linespacing=1.25,
    bbox=None,
):
    ax.text(
        x,
        y,
        s,
        fontsize=size,
        color=color,
        fontweight=weight,
        ha=ha,
        va=va,
        zorder=z,
        style=style,
        linespacing=linespacing,
        bbox=bbox,
    )


def arrow(ax, x1, y1, x2, y2, color=ARROW, lw=0.95, ms=7.5, ls="-", z=4, rad=0.0):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=ms,
            linewidth=lw,
            color=color,
            linestyle=ls,
            connectionstyle=f"arc3,rad={rad}",
            zorder=z,
            shrinkA=0,
            shrinkB=0,
        )
    )


def diamond(ax, cx, cy, w, h, s, size=6.3):
    ax.add_patch(
        Polygon(
            [(cx, cy + h / 2), (cx + w / 2, cy), (cx, cy - h / 2), (cx - w / 2, cy)],
            closed=True,
            facecolor="#FFF8E6",
            edgecolor="#B8862E",
            linewidth=0.95,
            zorder=4,
        )
    )
    text(ax, cx, cy, s, size=size, ha="center", va="center", weight="bold", z=6)


def process(ax, y, h, num, title, body, color):
    x, w = 4.30, 4.70
    box(ax, x, y, w, h, fc="#FFFFFF", ec="#B9C5D2", lw=1.05, rad=0.06, shadow=True)
    ax.add_patch(Rectangle((x + 0.03, y + 0.06), 0.07, h - 0.12, facecolor=color, edgecolor="none", zorder=5))
    text(ax, x + 0.19, y + h - 0.10, f"{num}  {title}", size=9.6, weight="bold", color=INK, va="top", z=6)
    text(ax, x + 0.19, y + h - 0.40, wrap_mixed(body, 28), size=7.3, color="#3B4B5C", va="top", linespacing=1.18, z=6)


def side(ax, x, y, w, h, label, body, kind="input"):
    if kind == "input":
        fc, ec = "#F2F7FC", "#8FA8BF"
    elif kind == "output":
        fc, ec = "#F3F8F4", "#8FAF9C"
    else:
        fc, ec = "#FBF6EC", "#C9A86A"
    box(ax, x, y, w, h, fc=fc, ec=ec, lw=0.9, rad=0.05, dashed=True)
    text(ax, x + 0.10, y + h - 0.07, label, size=6.7, weight="bold", color=ec, va="top", z=6)
    body_size = 6.55
    text(
        ax,
        x + 0.10,
        y + h - 0.29,
        wrap_mixed(body, (w - 0.18) * 72 / (body_size * 1.05)),
        size=body_size,
        color="#3B4B5C",
        va="top",
        linespacing=1.15,
        z=6,
    )


def link_label(ax, x, y, s, color=MUTED, size=5.8, ha="center"):
    text(
        ax,
        x,
        y,
        s,
        size=size,
        color=color,
        weight="bold",
        ha=ha,
        va="center",
        z=7,
        bbox=dict(facecolor=BG, edgecolor="none", pad=1.0),
    )


# ---------------------------------------------------------------------------
# canvas
# ---------------------------------------------------------------------------
fig = plt.figure(figsize=(14, 19.6), dpi=200)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 14)
ax.set_ylim(0, 19.6)
ax.axis("off")
ax.set_facecolor(BG)
fig.patch.set_facecolor(BG)

ax.add_patch(Rectangle((0, 19.48), 14, 0.12, facecolor=INK, edgecolor="none", zorder=1))

text(ax, 0.45, 19.10, "经营循环", size=22, weight="bold", color=INK)
text(ax, 0.45, 18.73, "从入池到复盘：每个节点都带输入、判断、输出和指标", size=8.8, color=MUTED)
text(ax, 13.55, 19.18, "京东外卖 · 包销品 UE", size=7.8, color=MUTED, ha="right")

# legend
box(ax, 0.45, 18.08, 0.32, 0.20, fc="#FFFFFF", ec="#3E5266", lw=0.9, rad=0.04)
text(ax, 0.84, 18.18, "经营动作", size=5.9, color=INK, va="center")
box(ax, 1.90, 18.08, 0.32, 0.20, fc="#F2F7FC", ec="#8FA8BF", lw=0.8, rad=0.04, dashed=True)
text(ax, 2.29, 18.18, "输入 / 输出 / 指标 / 约束", size=5.9, color=INK, va="center")
ax.add_patch(
    Polygon(
        [(5.05, 18.28), (5.25, 18.18), (5.05, 18.08), (4.85, 18.18)],
        closed=True,
        facecolor="#FFF8E6",
        edgecolor="#B8862E",
        lw=0.8,
        zorder=4,
    )
)
text(ax, 5.34, 18.18, "判断 / 闸门", size=5.9, color=INK, va="center")
ax.plot([6.95, 7.40], [18.18, 18.18], color=FEED, lw=1.1, ls=(0, (3, 2)), zorder=4)
text(ax, 7.47, 18.18, "复盘回流", size=5.9, color=FEED, va="center")
ax.plot([8.55, 9.00], [18.18, 18.18], color=BACK, lw=1.1, ls=(0, (3, 2)), zorder=4)
text(ax, 9.07, 18.18, "不通过，回策略", size=5.9, color=BACK, va="center")

# ---------------------------------------------------------------------------
# 01 入池
# ---------------------------------------------------------------------------
process(ax, 17.025, 0.85, "01", "入池", "读取现成内部包销品表，确定 SKU 池", "#2F6B9A")
side(ax, 0.45, 17.025, 2.95, 0.85, "输入", "内部包销品表（现成）")
side(ax, 9.75, 17.025, 3.75, 0.85, "输出", "包销 SKU 清单\n只取是 / 否", kind="output")
arrow(ax, 3.40, 17.45, 4.30, 17.45, lw=0.85)
arrow(ax, 9.00, 17.45, 9.75, 17.45, lw=0.85)
arrow(ax, 6.65, 17.025, 6.65, 16.625)

# ---------------------------------------------------------------------------
# 02 建基线
# ---------------------------------------------------------------------------
process(ax, 15.675, 0.95, "02", "建基线", "连续 4 周订单，按五维分组；样本不足只标记", "#347A6B")
side(ax, 0.45, 15.675, 2.95, 0.95, "输入", "订单、结算、成本、竞对")
side(ax, 9.75, 15.675, 3.75, 0.95, "指标", "单均 UE、客单价、补贴率、补贴 ROI\n订单量、复购率、价格指数", kind="output")
arrow(ax, 3.40, 16.15, 4.30, 16.15, lw=0.85)
arrow(ax, 9.00, 16.15, 9.75, 16.15, lw=0.85)
arrow(ax, 6.65, 15.675, 6.65, 15.375)

# ---------------------------------------------------------------------------
# 03 诊断
# ---------------------------------------------------------------------------
process(ax, 14.525, 0.85, "03", "诊断", "拆补贴前 UE / 补贴后 UE，分开判断", "#B26A2E")
side(ax, 0.45, 14.525, 2.95, 0.85, "输入", "基线 UE、补贴、价格、成本、需求、履约")
side(ax, 9.75, 14.525, 3.75, 0.85, "输出", "结构性负 UE / 补贴过度 / UE 为正", kind="output")
arrow(ax, 3.40, 14.95, 4.30, 14.95, lw=0.85)
arrow(ax, 9.00, 14.95, 9.75, 14.95, lw=0.85)
arrow(ax, 6.65, 14.525, 6.65, 14.175)

diamond(ax, 6.65, 13.85, 3.10, 0.65, "补贴前 UE < 0？", size=6.4)

# structural branch
box(ax, 0.55, 12.775, 2.80, 0.55, fc="#FDF0E3", ec="#D8A56A", lw=0.9, rad=0.05)
text(ax, 1.95, 13.18, "结构性负 UE", size=7.1, weight="bold", color="#8A4E1E", ha="center", va="center", z=6)
text(ax, 1.95, 12.90, "砍补贴无法修复", size=5.7, color="#8A4E1E", ha="center", va="center", z=6)
arrow(ax, 5.10, 13.85, 3.35, 13.15, lw=0.95)
link_label(ax, 4.62, 13.72, "是", "#8A4E1E")

side(
    ax,
    0.45,
    11.55,
    3.15,
    1.15,
    "结构性原因 → 动作",
    "价格：低于竞对/成本线 → 调价、换规格\n成本：高于基准 → 换供应商、改包装\n需求：密度不足 → 扩商圈、调时段\n供给：售罄/出餐慢/退款高 → 调库存、扩范围",
    kind="constraint",
)
arrow(ax, 1.95, 12.775, 1.95, 12.70, lw=0.85)

# subsidy branch
diamond(ax, 9.80, 13.05, 3.20, 0.70, "补贴后 UE<0\n且 ROI<1？", size=6.2)
arrow(ax, 8.20, 13.85, 8.20, 13.05, lw=0.95)
link_label(ax, 8.43, 13.42, "否")

box(ax, 8.15, 11.825, 3.30, 0.55, fc="#FCECEC", ec="#C7837C", lw=0.9, rad=0.05)
text(ax, 9.80, 12.25, "补贴过度", size=7.1, weight="bold", color="#8E3B36", ha="center", va="center", z=6)
text(ax, 9.80, 11.97, "降补贴 / 改券", size=5.7, color="#8E3B36", ha="center", va="center", z=6)
arrow(ax, 9.80, 12.70, 9.80, 12.375, lw=0.85)
link_label(ax, 10.04, 12.54, "是", "#8A4E1E")

side(
    ax,
    7.95,
    10.85,
    4.60,
    0.95,
    "补贴过度看什么",
    "ROI = 增量贡献（扣自然基线）/ 补贴总费用\n<15 元订单占比、撤补 30 日复购、商家实收/利润",
    kind="constraint",
)
arrow(ax, 9.80, 11.825, 9.80, 11.80, lw=0.85)

box(ax, 11.75, 12.775, 1.75, 0.55, fc="#E8F5E9", ec="#8FBF9A", lw=0.9, rad=0.05)
text(ax, 12.625, 13.18, "UE 为正", size=6.7, weight="bold", color="#2E6B57", ha="center", va="center", z=6)
text(ax, 12.625, 12.90, "保持监控", size=5.7, color="#2E6B57", ha="center", va="center", z=6)
arrow(ax, 11.40, 13.05, 11.75, 13.05, lw=0.85)
link_label(ax, 11.57, 13.22, "否")

# converge to strategy
ax.plot([1.95, 1.95], [11.55, 10.35], color=ARROW, lw=0.95, zorder=4)
ax.plot([10.25, 10.25], [10.85, 10.35], color=ARROW, lw=0.95, zorder=4)
ax.plot([1.95, 10.25], [10.35, 10.35], color=ARROW, lw=0.95, zorder=4)
ax.add_patch(Circle((6.65, 10.35), 0.04, facecolor=ARROW, edgecolor="none", zorder=5))
arrow(ax, 6.65, 10.35, 6.65, 10.125, lw=0.95)
link_label(ax, 6.82, 10.45, "进入策略", size=5.2, ha="left")

# ---------------------------------------------------------------------------
# 04 策略
# ---------------------------------------------------------------------------
process(ax, 9.175, 0.95, "04", "策略", "输出动作方案：价格 / 补贴 / 供给三类动作", "#6F5AA6")
side(ax, 0.45, 9.175, 2.95, 0.95, "输入", "诊断结论、动作库")
side(ax, 9.75, 9.00, 3.75, 0.90, "选择约束", "平台规则、预算、商家毛利\n竞对反应、履约能力", kind="constraint")
arrow(ax, 3.40, 9.65, 4.30, 9.65, lw=0.85)
arrow(ax, 9.00, 9.45, 9.75, 9.45, lw=0.85, ls=(0, (3, 2)))

diamond(ax, 6.65, 8.65, 2.75, 0.65, "五道约束\n全部通过？", size=6.0)
arrow(ax, 6.65, 9.175, 6.65, 8.975, lw=0.95)
arrow(ax, 5.28, 8.65, 4.30, 9.45, color=BACK, lw=0.95, ls=(0, (3, 2)), rad=-0.35)
link_label(ax, 4.20, 9.05, "否：改策略", BACK, size=5.3, ha="right")

# ---------------------------------------------------------------------------
# 05 仿真
# ---------------------------------------------------------------------------
process(ax, 7.075, 0.95, "05", "仿真", "三情景 + 反事实；给区间，不给假精确", "#3C7C8C")
side(ax, 0.45, 7.075, 2.95, 0.95, "输入", "弹性、补贴响应、竞对价、成本、预算")
side(ax, 9.75, 7.075, 3.75, 0.95, "输出", "订单、UE、补贴、增量利润、ROI、最坏情况", kind="output")
arrow(ax, 3.40, 7.55, 4.30, 7.55, lw=0.85)
arrow(ax, 9.00, 7.55, 9.75, 7.55, lw=0.85)
arrow(ax, 6.65, 8.325, 6.65, 8.025)
link_label(ax, 6.85, 8.18, "是")

diamond(ax, 6.65, 6.50, 2.75, 0.65, "仿真通过？", size=6.3)
arrow(ax, 6.65, 7.075, 6.65, 6.825, lw=0.95)

# failed simulation returns to strategy constraints via the right margin
ax.plot([8.025, 13.70, 13.70], [6.50, 6.50, 9.45], color=BACK, lw=0.95, ls=(0, (3, 2)), zorder=4)
arrow(ax, 13.70, 9.45, 13.50, 9.45, color=BACK, lw=0.95, ls=(0, (3, 2)))
link_label(ax, 12.80, 6.66, "否：回策略", BACK, size=5.3, ha="right")
arrow(ax, 6.65, 6.175, 6.65, 5.875, lw=0.95)
link_label(ax, 6.85, 6.03, "是")

# ---------------------------------------------------------------------------
# 06 执行
# ---------------------------------------------------------------------------
process(ax, 4.925, 0.95, "06", "执行", "人工任务单 → 后台 / 接口；留下执行记录", "#A44A4A")
side(ax, 0.45, 4.925, 2.95, 0.95, "输入", "动作方案、执行人、时间")
side(ax, 9.75, 4.80, 3.75, 0.95, "控制", "权限、生效时间、互斥活动\n预算、24h 回滚、审计", kind="constraint")
arrow(ax, 3.40, 5.40, 4.30, 5.40, lw=0.85)
arrow(ax, 9.00, 5.28, 9.75, 5.28, lw=0.85, ls=(0, (3, 2)))

diamond(ax, 6.65, 4.35, 2.75, 0.65, "UE / 差评异常？", size=6.0)
arrow(ax, 6.65, 4.925, 6.65, 4.675, lw=0.95)

box(ax, 9.75, 4.075, 2.45, 0.55, fc="#FCECEC", ec="#C7837C", lw=0.9, rad=0.05)
text(ax, 10.975, 4.35, "回滚并记录", size=6.4, weight="bold", color="#8E3B36", ha="center", va="center", z=6)
arrow(ax, 8.025, 4.35, 9.75, 4.35, lw=0.9)
link_label(ax, 8.88, 4.52, "是", "#8A4E1E")
arrow(ax, 10.975, 4.075, 10.975, 3.10, lw=0.85, ls=(0, (3, 2)))
link_label(ax, 11.15, 3.58, "回滚记录", MUTED, size=5.2, ha="left")
arrow(ax, 6.65, 4.025, 6.65, 3.10)
link_label(ax, 6.85, 3.80, "否")
link_label(ax, 6.88, 3.58, "进入复盘", MUTED, size=5.3, ha="left")

# ---------------------------------------------------------------------------
# 07 复盘
# ---------------------------------------------------------------------------
process(ax, 2.00, 1.10, "07", "复盘", "四问：实际 vs 仿真；差异归因；保留 / 调整 / 停止", "#4E7A3A")
side(ax, 0.45, 2.00, 2.95, 1.10, "方法", "对照实验优先\n否则前后对比 / DiD / 合成对照")
side(
    ax,
    9.75,
    2.00,
    3.75,
    1.10,
    "指标",
    "平台 UE、商家 UE、订单、GMV、补贴、ROI、复购、退款、差评、配送时长、\n商家毛利、价格指数",
    kind="output",
)
arrow(ax, 3.40, 2.55, 4.30, 2.55, lw=0.85)
arrow(ax, 9.00, 2.55, 9.75, 2.55, lw=0.85)

# review feedback to baseline and strategy inputs
ax.plot([4.30, 4.30, 0.20, 0.20], [2.00, 1.35, 1.35, 16.15], color=FEED, lw=1.0, ls=(0, (4, 2)), zorder=4)
arrow(ax, 0.20, 16.15, 0.45, 16.15, color=FEED, lw=1.0, ls=(0, (4, 2)))
arrow(ax, 0.20, 9.65, 0.45, 9.65, color=FEED, lw=1.0, ls=(0, (4, 2)))
ax.add_patch(Circle((0.20, 9.65), 0.035, facecolor=FEED, edgecolor="none", zorder=5))
text(ax, 0.35, 1.08, "复盘回流：更新基线 / 策略库", size=5.6, color=FEED, weight="bold", va="center", z=6)

# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------
png = OUT / "operating_flow.png"
svg = OUT / "operating_flow.svg"
pdf = OUT / "operating_flow.pdf"
fig.savefig(png, dpi=220, facecolor=BG, bbox_inches=None)
fig.savefig(svg, facecolor=BG, bbox_inches=None)
fig.savefig(pdf, facecolor=BG, bbox_inches=None)
print(f"wrote {png}")
print(f"wrote {svg}")
print(f"wrote {pdf}")
