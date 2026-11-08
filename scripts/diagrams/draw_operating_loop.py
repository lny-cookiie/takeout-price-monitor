"""Draw the one-page operating-loop blueprint.

The figure is intentionally a single page: seven stages on the main line,
three detail panels for diagnosis, strategy/simulation, and execution/review,
plus the ten open boundary items at the bottom.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Polygon, Rectangle, Circle

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "前期调研" / "图表"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "Microsoft YaHei"
INK = "#22313F"
MUTED = "#6F7D8C"
LINE = "#D9DEE5"
BG = "#F6F8FA"
ARROW = "#58697A"
RETURN = "#2E6B57"

plt.rcParams["font.family"] = FONT
plt.rcParams["axes.unicode_minus"] = False


def wrap_mixed(text: str, max_units: float) -> str:
    """Wrap mixed Chinese/Latin text by approximate display width."""
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
    lw=1.0,
    rad=0.08,
    z=2,
    shadow=False,
):
    if shadow:
        ax.add_patch(
            FancyBboxPatch(
                (x + 0.04, y - 0.045),
                w,
                h,
                boxstyle=f"round,pad=0,rounding_size={rad}",
                linewidth=0,
                facecolor="#E2E7EC",
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
            zorder=z,
        )
    )


def text(
    ax,
    x,
    y,
    s,
    size=8,
    color=INK,
    weight="normal",
    ha="left",
    va="top",
    z=6,
    style="normal",
    linespacing=1.28,
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


def arrow(
    ax,
    x1,
    y1,
    x2,
    y2,
    color=ARROW,
    lw=1.25,
    ms=10,
    style="-|>",
    z=4,
    ls="-",
    connectionstyle="arc3,rad=0",
):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle=style,
            mutation_scale=ms,
            linewidth=lw,
            color=color,
            linestyle=ls,
            connectionstyle=connectionstyle,
            zorder=z,
            shrinkA=0,
            shrinkB=0,
        )
    )


def diamond(ax, cx, cy, w, h, s, fc="#FFF8E6", ec="#B8862E", size=7.0):
    ax.add_patch(
        Polygon(
            [(cx, cy + h / 2), (cx + w / 2, cy), (cx, cy - h / 2), (cx - w / 2, cy)],
            closed=True,
            facecolor=fc,
            edgecolor=ec,
            linewidth=1.1,
            zorder=4,
        )
    )
    text(ax, cx, cy + 0.005, s, size=size, ha="center", va="center", z=6, weight="bold")


def pill(ax, x, y, w, h, s, fc="#EEF3F8", ec="#B9C7D6", size=6.1):
    box(ax, x, y, w, h, fc=fc, ec=ec, lw=0.8, rad=0.12, z=4)
    text(ax, x + w / 2, y + h / 2, s, size=size, ha="center", va="center", z=6)


def table(
    ax,
    x,
    y_top,
    col_widths,
    headers,
    rows,
    row_heights,
    header_h=0.28,
    font_size=6.5,
    header_size=6.5,
    row_fills=("#FFFFFF", "#F7F9FB"),
    col_colors=None,
):
    total_w = sum(col_widths)
    # header
    ax.add_patch(Rectangle((x, y_top - header_h), total_w, header_h, facecolor="#2F3B4A", edgecolor="none", zorder=3))
    cx = x
    for i, (cw, h) in enumerate(zip(col_widths, headers)):
        text(ax, cx + 0.07, y_top - header_h / 2, h, size=header_size, color="white", weight="bold", va="center", z=5)
        cx += cw
    y = y_top - header_h
    for ri, (row, rh) in enumerate(zip(rows, row_heights)):
        ax.add_patch(
            Rectangle((x, y - rh), total_w, rh, facecolor=row_fills[ri % 2], edgecolor="none", zorder=2)
        )
        cx = x
        for ci, (cw, cell) in enumerate(zip(col_widths, row)):
            color = INK if ci == 0 else (col_colors[ci] if col_colors else "#425262")
            weight = "bold" if ci == 0 else "normal"
            if "\n" not in cell:
                max_units = max(4, (cw - 0.16) * 72 / (font_size * 0.95))
                cell = wrap_mixed(cell, max_units)
            text(
                ax,
                cx + 0.07,
                y - rh / 2,
                cell,
                size=font_size,
                color=color,
                weight=weight,
                va="center",
                z=5,
            )
            cx += cw
        ax.plot([x, x + total_w], [y - rh, y - rh], color="#E4E9EF", lw=0.55, zorder=3)
        y -= rh
    # outer border
    ax.add_patch(Rectangle((x, y), total_w, y_top - y, fill=False, edgecolor="#D6DDE5", lw=0.9, zorder=4))
    return y


# ---------------------------------------------------------------------------
# canvas
# ---------------------------------------------------------------------------
fig = plt.figure(figsize=(20, 14.2), dpi=200)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 20)
ax.set_ylim(0, 14.2)
ax.axis("off")
ax.set_facecolor(BG)
fig.patch.set_facecolor(BG)

# thin top rule
ax.add_patch(Rectangle((0, 14.08), 20, 0.12, facecolor=INK, edgecolor="none", zorder=1))

# ---------------------------------------------------------------------------
# header
# ---------------------------------------------------------------------------
text(ax, 0.42, 13.62, "经营循环", size=25, weight="bold", color=INK)
text(
    ax,
    3.55,
    13.70,
    "从包销范围到复盘回流：七步闭环，每一步都有输入、输出和停止条件",
    size=10.5,
    color=MUTED,
)
text(
    ax,
    19.58,
    13.70,
    "京东外卖 · 包销品 UE 经营数据产品",
    size=8.8,
    color=MUTED,
    ha="right",
)

# ---------------------------------------------------------------------------
# main seven stages
# ---------------------------------------------------------------------------
stages = [
    {
        "no": "01",
        "title": "定范围",
        "sub": "先把包销范围定死",
        "color": "#2F6B9A",
        "bullets": [
            "合同 + 结算双条件",
            "is_baoxiao 只取是 / 否",
            "业务、财务、法务、商家确认，产品不替代合同判断",
            "成交形态按订单记录，校验价格与归因",
        ],
        "note": "闸门：证据不足判非包销，补齐重判",
    },
    {
        "no": "02",
        "title": "建基线",
        "sub": "用京东订单、结算和成本重建",
        "color": "#347A6B",
        "bullets": [
            "连续 4 周订单",
            "品类 / 城市层级 / 用户类型 / 时段 / 渠道",
            "单均 UE、客单价、补贴率、补贴 ROI、订单量、复购率、价格指数",
            "不用上月均值，避免活动和季节混入；\n样本不足不硬算",
        ],
        "note": "边界：公开数据只定初始区间，不替代内部基线",
    },
    {
        "no": "03",
        "title": "诊断",
        "sub": "先分清结构性负 UE 和补贴过度",
        "color": "#B26A2E",
        "bullets": [
            "拆补贴前 UE / 补贴后 UE",
            "补贴前为负：价格 / 成本 / 需求 / 供给履约",
            "补贴前为正、补贴后为负：查补贴过度",
            "补贴过度：单均 UE<0 且边际 ROI<1",
        ],
        "note": "闸门：结构性负 UE 不能靠砍补贴修复",
    },
    {
        "no": "04",
        "title": "策略",
        "sub": "三类动作，五道约束",
        "color": "#6F5AA6",
        "bullets": [
            "价格类：降价、恢复原价、起送价、配送费",
            "补贴类：商家 / 平台 / 新客 / 老客 / 时段 / 城市",
            "供给类：SKU、包装、出餐、配送范围、库存、履约",
            "五道约束：合同、平台规则、预算、商家毛利、竞对反应",
        ],
        "note": "闸门：五道约束不过，不生成方案",
    },
    {
        "no": "05",
        "title": "仿真",
        "sub": "给区间和条件，不给假精确",
        "color": "#3C7C8C",
        "bullets": [
            "输入：基线 UE、弹性、补贴响应、竞对价、成本、密度、预算",
            "情景：不做 / 竞对跟进 / 仅老客；乐观 / 基准 / 悲观",
            "输出：订单、UE、补贴、增量利润、ROI、最坏情况",
            "首版用历史回测 + 保守区间，标注置信度",
        ],
        "note": "闸门：仿真不通过，不进入执行",
    },
    {
        "no": "06",
        "title": "执行",
        "sub": "人工任务单起步，控制先行",
        "color": "#A44A4A",
        "bullets": [
            "对象：价格、补贴、券、SKU、包装、配送范围、出餐",
            "方式：人工任务单（业务在平台后台操作）→ 商家后台 / 平台接口",
            "控制：权限、生效时间、互斥活动、预算、\n24h 回滚、审计",
            "合规前置：7 天告知；发起方 / 出资方 / 商家确认 / 成本底线 / 退出记录",
            "节奏：日常监控按日，策略上线按周",
        ],
        "note": "闸门：冲突 / 超预算 / 不合规不执行",
    },
    {
        "no": "07",
        "title": "复盘",
        "sub": "回答四个问题，结果回流",
        "color": "#4E7A3A",
        "bullets": [
            "四问：实际 vs 仿真；差异来自价格/补贴/供给/竞对/季节；\n影响用户/时段；保留/调整/停止",
            "方法：对照实验优先；否则前后对比 / DiD / 合成对照",
            "指标：平台 UE、商家 UE、订单、GMV、补贴、ROI、复购、退款、差评、配送时长、\n商家毛利、价格指数",
            "回流：基线 / 模型 / 策略库",
        ],
        "note": "回流：结果进入下一轮诊断和策略",
    },
]

CARD_X0 = 0.42
CARD_W = 2.48
CARD_GAP = 0.30
CARD_TOP = 12.54
CARD_H = 3.06
CARD_BOTTOM = CARD_TOP - CARD_H
centers = []

for i, s in enumerate(stages):
    x = CARD_X0 + i * (CARD_W + CARD_GAP)
    centers.append(x + CARD_W / 2)
    box(ax, x, CARD_BOTTOM, CARD_W, CARD_H, fc="#FFFFFF", ec="#D5DDE6", lw=1.0, rad=0.09, shadow=True)
    # top accent
    ax.add_patch(Rectangle((x + 0.10, CARD_TOP - 0.075), CARD_W - 0.20, 0.055, facecolor=s["color"], edgecolor="none", zorder=5))
    # number
    ax.add_patch(Circle((x + 0.28, CARD_TOP - 0.30), 0.145, facecolor=s["color"], edgecolor="none", zorder=5))
    text(ax, x + 0.28, CARD_TOP - 0.300, s["no"], size=7.4, color="white", weight="bold", ha="center", va="center", z=6)
    text(ax, x + 0.51, CARD_TOP - 0.18, s["title"], size=11.2, weight="bold", color=INK, va="top", z=6)
    text(ax, x + 0.16, CARD_TOP - 0.58, s["sub"], size=6.7, color=MUTED, style="italic", va="top", z=6)

    yy = CARD_TOP - 0.92
    for b in s["bullets"]:
        wrapped = wrap_mixed(b, 20.0)
        text(ax, x + 0.16, yy, "·", size=8.0, color=s["color"], weight="bold", va="top", z=6)
        text(ax, x + 0.31, yy, wrapped, size=7.05, color="#334252", va="top", linespacing=1.23, z=6)
        yy -= 0.145 * (wrapped.count("\n") + 1) + 0.055

    # footer separator + gate/note
    ax.plot([x + 0.14, x + CARD_W - 0.14], [CARD_BOTTOM + 0.24, CARD_BOTTOM + 0.24], color="#E4E9EF", lw=0.7, zorder=4)
    text(
        ax,
        x + 0.16,
        CARD_BOTTOM + 0.12,
        wrap_mixed(s["note"], 22.5),
        size=5.85,
        color=s["color"],
        weight="bold",
        va="top",
        linespacing=1.15,
        z=6,
    )

# forward arrows
for i in range(6):
    x1 = CARD_X0 + i * (CARD_W + CARD_GAP) + CARD_W + 0.015
    x2 = CARD_X0 + (i + 1) * (CARD_W + CARD_GAP) - 0.015
    arrow(ax, x1, 11.10, x2, 11.10, color=ARROW, lw=1.35, ms=10)

# return bus above the cards
bus_y = 12.86
ax.plot([centers[-1], centers[-1], centers[1]], [CARD_TOP + 0.01, bus_y, bus_y], color=RETURN, lw=1.3, ls=(0, (4, 2)), zorder=4)
arrow(ax, centers[1], bus_y, centers[1], CARD_TOP + 0.01, color=RETURN, lw=1.3, ms=9, ls=(0, (4, 2)))
arrow(ax, centers[3], bus_y, centers[3], CARD_TOP + 0.01, color=RETURN, lw=1.3, ms=9, ls=(0, (4, 2)))
ax.plot([centers[3], centers[3]], [bus_y, bus_y], color=RETURN, lw=1.3, zorder=4)
text(
    ax,
    11.33,
    bus_y + 0.055,
    "复盘回流：更新基线 / 模型 / 策略库",
    size=7.4,
    color=RETURN,
    weight="bold",
    ha="center",
    va="bottom",
    bbox=dict(facecolor=BG, edgecolor="none", pad=1.5),
    z=6,
)

# ---------------------------------------------------------------------------
# three detail panels
# ---------------------------------------------------------------------------
P_TOP = 9.22
P_BOTTOM = 5.18
P_H = P_TOP - P_BOTTOM
panels = [
    (0.42, 6.66, "#B26A2E", "03 诊断分叉", "先分清结构性负 UE 和补贴过度"),
    (7.28, 6.36, "#6F5AA6", "04 策略 → 05 仿真", "三类动作、五道约束、四步闸门"),
    (13.84, 5.74, "#4E7A3A", "06 执行 → 07 复盘", "控制、合规、归因、回流"),
]
for px, pw, pc, pt, ps in panels:
    box(ax, px, P_BOTTOM, pw, P_H, fc="#FFFFFF", ec="#D5DDE6", lw=1.0, rad=0.09, shadow=True)
    ax.add_patch(Rectangle((px + 0.10, P_TOP - 0.075), pw - 0.20, 0.055, facecolor=pc, edgecolor="none", zorder=5))
    text(ax, px + 0.18, P_TOP - 0.19, pt, size=10.2, weight="bold", color=INK, va="top", z=6)
    text(ax, px + 0.18, P_TOP - 0.49, ps, size=6.6, color=MUTED, style="italic", va="top", z=6)
    ax.plot([px + 0.14, px + pw - 0.14], [P_TOP - 0.60, P_TOP - 0.60], color="#E4E9EF", lw=0.7, zorder=4)

# --- P1 diagnosis -----------------------------------------------------------
p1x, p1w = 0.42, 6.66
diamond(ax, 3.55, 8.43, 1.78, 0.50, "补贴前 UE < 0？", size=7.0)
# left branch
box(ax, 0.70, 7.92, 2.25, 0.42, fc="#FDF0E3", ec="#D8A56A", lw=0.9, rad=0.06, z=4)
text(ax, 1.825, 8.155, "结构性负 UE", size=7.2, weight="bold", color="#8A4E1E", ha="center", va="center", z=6)
text(ax, 1.825, 7.985, "砍补贴无法修复", size=5.8, color="#8A4E1E", ha="center", va="center", z=6)
arrow(ax, 2.66, 8.43, 2.30, 8.30, color="#B26A2E", lw=1.0, ms=8)
text(ax, 2.42, 8.47, "是", size=6.2, color="#8A4E1E", ha="center", va="bottom", z=6)
# right decision
arrow(ax, 4.44, 8.43, 5.07, 8.43, color=ARROW, lw=1.0, ms=8)
text(ax, 4.76, 8.48, "否", size=6.2, color=MUTED, ha="center", va="bottom", z=6)
diamond(ax, 5.86, 8.43, 1.78, 0.50, "补贴后 UE<0\n且 ROI<1?", size=6.2)
text(ax, 5.32, 8.02, "是 → 补贴过度", size=5.8, color="#A44A4A", weight="bold", ha="center", va="top", z=6)
text(ax, 6.47, 8.02, "否 → 非补贴过度", size=5.8, color="#2E6B57", weight="bold", ha="center", va="top", z=6)

# diagnosis table
diag_rows = [
    ["价格", "成交价低于竞对或成本线", "调价、换规格"],
    ["成本", "食材、包装、配送、人工高于基准", "换供应商、改包装"],
    ["需求", "订单密度不足，配送成本摊不薄", "扩商圈、调时段"],
    ["供给履约", "售罄、范围小、出餐慢、退款高", "调库存、扩范围"],
    [
        "补贴过度",
        "单均 UE<0 且边际 ROI<1；\nROI=增量贡献（扣自然基线）/补贴总费用",
        "降补贴、改券；看 <15 元订单占比、撤补 30 日复购、商家实收/利润；\n20% 补贴率仅经验线，按品类回测",
    ],
]
table(
    ax,
    0.58,
    7.60,
    [0.98, 2.38, 2.92],
    ["原因", "判断依据", "动作方向"],
    diag_rows,
    [0.34, 0.34, 0.34, 0.34, 0.62],
    header_h=0.26,
    font_size=6.15,
    header_size=6.2,
)

# --- P2 strategy and simulation --------------------------------------------
p2x, p2w = 7.28, 6.36
cats = [
    ("价格类", "降价 / 恢复原价\n起送价 / 配送费"),
    ("补贴类", "商家 / 平台 / 新客\n老客复购 / 时段 / 城市"),
    ("供给类", "SKU / 包装 / 出餐\n配送范围 / 库存 / 履约"),
]
for j, (h, body) in enumerate(cats):
    cx = p2x + 0.18 + j * 2.03
    box(ax, cx, 7.87, 1.92, 0.68, fc="#F5F3FA", ec="#CFC7E2", lw=0.8, rad=0.06, z=3)
    text(ax, cx + 0.10, 8.47, h, size=6.8, weight="bold", color="#5E4C8E", va="top", z=5)
    text(ax, cx + 0.10, 8.23, body, size=5.7, color="#3F3A4D", va="top", linespacing=1.2, z=5)

text(ax, p2x + 0.18, 7.69, "五道约束", size=6.4, color=MUTED, weight="bold", va="top", z=5)
for j, lab in enumerate(["合同", "平台规则", "预算", "商家毛利", "竞对反应"]):
    pill(ax, p2x + 1.08 + j * 1.01, 7.48, 0.95, 0.24, lab, fc="#F1F5F9", ec="#C7D3DE", size=5.75)

box(ax, p2x + 0.18, 7.02, p2w - 0.36, 0.34, fc="#FFF4E5", ec="#E0A45A", lw=0.9, rad=0.05, z=3)
text(
    ax,
    p2x + 0.30,
    7.19,
    "硬约束（GB/T 46862-2025）：平台促销成本自担；不得强制或变相强制商家；\n不得设置不合理前置条件；至少提前 7 天告知",
    size=5.8,
    color="#7A4519",
    weight="bold",
    va="center",
    z=5,
)

sim_rows = [
    ("① 输入", "基线 UE / 价格弹性 / 补贴响应 / 竞对价 / 成本结构 / 订单密度 / 预算"),
    ("② 情景", "不做 / 竞对跟进 / 仅老客；乐观 / 基准 / 悲观"),
    ("③ 输出", "订单量 / UE / 补贴支出 / 增量利润 / ROI / 最坏情况"),
    ("④ 闸门", "置信度 + 关键假设；首版历史回测 + 保守区间；不通过不执行"),
]
ax.plot([p2x + 0.30, p2x + 0.30], [6.88, 5.32], color="#8FA3B5", lw=1.0, zorder=3)
for j, (lab, body) in enumerate(sim_rows):
    y = 6.84 - j * 0.43
    ax.add_patch(Circle((p2x + 0.30, y - 0.15), 0.09, facecolor="#6F5AA6", edgecolor="none", zorder=5))
    text(ax, p2x + 0.45, y, lab, size=6.3, color="#5E4C8E", weight="bold", va="top", z=5)
    text(ax, p2x + 1.06, y, body, size=5.9, color="#334252", va="top", z=5)

# --- P3 execution and review ------------------------------------------------
p3x, p3w = 13.84, 5.74
exec_rows = [
    ("对象", "价格、补贴、券、SKU、包装、配送范围、出餐"),
    ("方式", "人工任务单（业务在平台后台操作；记录执行人、时间、前后截图、结果）\n→ 商家后台 / 平台接口"),
    ("控制", "权限、生效时间、冲突检测、预算、24h 异常回滚、审计日志"),
    ("合规前置", "7 天告知；发起方 / 出资方 / 商家确认 / 成本底线 / 退出记录必填"),
]
yy = 8.44
for lab, body in exec_rows:
    text(ax, p3x + 0.18, yy, lab, size=6.2, color="#8A3B3B", weight="bold", va="top", z=5)
    text(ax, p3x + 0.66, yy, wrap_mixed(body, 38), size=5.8, color="#334252", va="top", linespacing=1.18, z=5)
    yy -= 0.28 + 0.10 * (wrap_mixed(body, 38).count("\n"))

ax.plot([p3x + 0.16, p3x + p3w - 0.16], [7.06, 7.06], color="#DDE4EB", lw=0.8, zorder=4)
text(ax, p3x + 0.18, 6.94, "复盘", size=7.0, color="#3F6B2E", weight="bold", va="top", z=5)
review_rows = [
    ("四问", "实际 vs 仿真；差异来自价格/补贴/供给/竞对/季节；\n影响用户/时段；保留/调整/停止"),
    ("方法", "门店 / SKU 对照实验优先；否则前后对比 / DiD / 合成对照，标因果置信度"),
    ("指标", "平台 UE、商家 UE、订单、GMV、补贴、ROI、复购、退款、差评、配送时长、\n商家毛利、价格指数"),
    ("回流", "基线 / 模型 / 策略库；进入下一轮诊断和策略"),
]
yy = 6.67
for lab, body in review_rows:
    text(ax, p3x + 0.18, yy, lab, size=6.2, color="#3F6B2E", weight="bold", va="top", z=5)
    text(ax, p3x + 0.66, yy, wrap_mixed(body, 38), size=5.8, color="#334252", va="top", linespacing=1.18, z=5)
    yy -= 0.26 + 0.10 * (wrap_mixed(body, 38).count("\n"))

# ---------------------------------------------------------------------------
# bottom open-items table
# ---------------------------------------------------------------------------
text(ax, 0.42, 4.82, "待确认边界（10 项）", size=9.2, weight="bold", color=INK, va="top")
text(ax, 3.45, 4.85, "已确定的继续执行；待确认的按解决方式推进", size=6.5, color=MUTED, va="top")

open_rows = [
    ["包销范围", "合同和结算为必要条件，价格形态仅校验", "合同条款、SKU 清单、周期、区域；业务 / 法务 / 商家确认"],
    ["包销与券", "券订单仍属对应包销 SKU，按交易形态归因", "叠加规则、出资方、分摊方式；活动规则 / 账单 / 截图"],
    ["UE 视角", "平台 UE 考核、商家 UE 底线、SKU UE 诊断", "公司考核口径与目标值；财务和业务共定"],
    ["基线", "连续 4 周，按品类 / 城市 / 用户 / 时段 / 渠道", "样本量、异常剔除、季节调整；数据试算后定"],
    ["负 UE", "单均 UE<0 且补贴 ROI<1", "不同品类阈值；历史数据回测"],
    ["竞对比价", "同店 / 同品 / 同规格 / 同用户 / 同时段", "账号层级、个性化价格、许可；场景采集 + 证据"],
    ["策略", "价格、补贴、供给三类", "决策权限、预算、合同边界；审批矩阵"],
    ["执行", "人工任务单 + 回填", "哪些动作可自动化；先低风险、后高风险"],
    ["合规", "平台促销成本自担、不得强制、至少提前 7 天告知", "平台 / 商家 / 品牌促销边界；法务校验 + 审批记录"],
    ["复盘", "实验或准实验 + 归因", "无实验时的置信标准；方法白皮书"],
]
table(
    ax,
    0.42,
    4.48,
    [1.55, 8.02, 9.17],
    ["环节", "已确定", "待确认 / 解决方式"],
    [[wrap_mixed(c, 75 if i != 0 else 8) for i, c in enumerate(r)] for r in open_rows],
    [0.335] * 10,
    header_h=0.28,
    font_size=5.95,
    header_size=6.3,
    col_colors=["#22313F", "#2E5E4E", "#6B4E2E"],
)

# ---------------------------------------------------------------------------
# footer notes
# ---------------------------------------------------------------------------
ax.plot([0.42, 19.58], [1.02, 1.02], color="#DDE4EB", lw=0.7, zorder=3)
text(
    ax,
    0.42,
    0.86,
    "公开人均参考：中式正餐 51.5、火锅 58.3、烧烤 57.2、小吃快餐 22.4、现制饮品 18.4 元（红餐产业研究院 2025Q3，口径、时间、样本不同，仅定方向）。",
    size=5.9,
    color="#7A8694",
    va="top",
    z=5,
)
text(
    ax,
    0.42,
    0.56,
    "合规案例：2026 年 3 月北京市场监管通报淘宝闪购“爆品团”：18 元手工水饺实收 1.25 元；28 元红烧肉套餐成本 15.8 元、活动价 9.9 元，每单倒贴 5-6 元。",
    size=5.9,
    color="#7A8694",
    va="top",
    z=5,
)

# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------
png = OUT / "operating_loop.png"
svg = OUT / "operating_loop.svg"
pdf = OUT / "operating_loop.pdf"
fig.savefig(png, dpi=220, facecolor=BG, bbox_inches=None)
fig.savefig(svg, facecolor=BG, bbox_inches=None)
fig.savefig(pdf, facecolor=BG, bbox_inches=None)
print(f"wrote {png}")
print(f"wrote {svg}")
print(f"wrote {pdf}")
