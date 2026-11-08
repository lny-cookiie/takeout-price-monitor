"""Draw the current price-collection tool as a business + technical route map.

Top lane: business loop. Middle lane: implemented technical chain. Bottom band:
live / fixture-only / restricted source status and hard boundaries.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Rectangle

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "前期调研" / "图表"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "Microsoft YaHei"
INK = "#22313F"
MUTED = "#647385"
LINE = "#CFD8E2"
BG = "#F7F9FB"
ARROW = "#53677A"
BUSINESS = "#2F6B9A"
TECH = "#6F5AA6"
LIVE = "#2E6B57"
FIXTURE = "#B26A2E"
RESTRICTED = "#A44A4A"

plt.rcParams["font.family"] = FONT
plt.rcParams["axes.unicode_minus"] = False


def wrap_mixed(text: str, max_units: float) -> str:
    lines, current, units = [], "", 0.0
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


def box(ax, x, y, w, h, fc="#FFFFFF", ec=LINE, lw=1.0, rad=0.06, dashed=False, z=2, shadow=False):
    if shadow:
        ax.add_patch(FancyBboxPatch((x + 0.03, y - 0.03), w, h, boxstyle=f"round,pad=0,rounding_size={rad}",
                                    linewidth=0, facecolor="#E1E6EC", zorder=z - 1))
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={rad}", linewidth=lw,
                                edgecolor=ec, facecolor=fc, linestyle=(0, (4, 2)) if dashed else "-", zorder=z))


def text(ax, x, y, s, size=6.5, color=INK, weight="normal", ha="left", va="top", z=6, linespacing=1.18, rotation=0):
    ax.text(x, y, s, fontsize=size, color=color, fontweight=weight, ha=ha, va=va, zorder=z,
            linespacing=linespacing, rotation=rotation)


def arrow(ax, x1, y1, x2, y2, color=ARROW, lw=1.0, ms=8, ls="-", z=4):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=ms, linewidth=lw,
                                 color=color, linestyle=ls, zorder=z, shrinkA=0, shrinkB=0))


def card(ax, x, y, w, h, num, title, body, color, body_size=6.2, title_size=8.4, fill="#FFFFFF"):
    box(ax, x, y, w, h, fc=fill, ec="#C9D3DE", lw=1.0, rad=0.06, shadow=True)
    ax.add_patch(Rectangle((x + 0.03, y + 0.06), 0.06, h - 0.12, facecolor=color, edgecolor="none", zorder=5))
    ax.add_patch(Circle((x + 0.27, y + h - 0.27), 0.13, facecolor=color, edgecolor="none", zorder=5))
    text(ax, x + 0.27, y + h - 0.27, num, size=6.3, color="white", weight="bold", ha="center", va="center")
    text(ax, x + 0.47, y + h - 0.16, title, size=title_size, weight="bold", color=INK)
    text(ax, x + 0.15, y + h - 0.50, wrap_mixed(body, (w - 0.28) * 72 / (body_size * 1.0)),
         size=body_size, color="#3B4B5C", linespacing=1.15)


# ---------------------------------------------------------------------------
# canvas
# ---------------------------------------------------------------------------
fig = plt.figure(figsize=(20, 11.6), dpi=200)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 20)
ax.set_ylim(0, 11.6)
ax.axis("off")
ax.set_facecolor(BG)
fig.patch.set_facecolor(BG)

# lanes
ax.add_patch(Rectangle((0.55, 8.68), 18.95, 1.98, facecolor="#F1F6FB", edgecolor="none", zorder=0))
ax.add_patch(Rectangle((0.55, 4.05), 18.95, 3.82, facecolor="#F5F6F8", edgecolor="none", zorder=0))
ax.add_patch(Rectangle((0, 11.42), 20, 0.18, facecolor=INK, edgecolor="none", zorder=1))

# lane labels
ax.add_patch(Rectangle((0.20, 8.78), 0.07, 1.80, facecolor=BUSINESS, edgecolor="none", zorder=3))
ax.add_patch(Rectangle((0.20, 4.15), 0.07, 3.62, facecolor=TECH, edgecolor="none", zorder=3))
text(ax, 0.34, 9.68, "业务路线", size=7.6, color=BUSINESS, weight="bold", ha="center", va="center", rotation=90)
text(ax, 0.34, 5.96, "技术路线", size=7.6, color=TECH, weight="bold", ha="center", va="center", rotation=90)

# header
text(ax, 0.62, 11.10, "竞对平台价格自动采集：业务与技术路线", size=19, weight="bold", color=INK)
text(ax, 0.62, 10.74, "同一门店、同一商品、同一用户条件、同一时段，比较京东与竞对的结算应付", size=8.6, color=MUTED)
text(ax, 19.35, 11.14, "当前实现 · 2026-11-07", size=7.2, color=MUTED, ha="right")

# ---------------------------------------------------------------------------
# business lane
# ---------------------------------------------------------------------------
bx = [0.90, 4.65, 8.40, 12.15, 15.90]
bw, bh, by = 3.55, 1.50, 8.79
business = [
    ("01", "目标与映射", "京东订单导入\n门店 / 商品 / 规格 / 实付\n竞对候选匹配 + 人工确认"),
    ("02", "监测计划", "选目标、账号、收货点\n餐期、天数、数量\n生成三平台计划槽位"),
    ("03", "自动采价", "到点触发\n京东按销量取前五，逐品结算\n竞对当前为模拟回放"),
    ("04", "校验与证据", "结算应付、费用、优惠\n用户资格、时间窗\n异常停止，保留证据"),
    ("05", "比较与输出", "同店同品同条件\n5 分钟内价差与明细\n人工复核、导出、看板"),
]
for i, (n, t, b) in enumerate(business):
    card(ax, bx[i], by, bw, bh, n, t, b, BUSINESS, body_size=6.8, title_size=8.8)
    if i < 4:
        arrow(ax, bx[i] + bw + 0.02, by + bh / 2, bx[i + 1] - 0.02, by + bh / 2, color=ARROW, lw=1.1, ms=8)

# connectors to tech lane
tech_tops = [7.40, 7.40, 7.70, 7.40, 7.40]
for x, top in zip(bx, tech_tops):
    cx = x + bw / 2
    arrow(ax, cx, by - 0.01, cx, top, color="#8FA8BF", lw=0.9, ms=6.5, ls=(0, (3, 2)))

# ---------------------------------------------------------------------------
# technical lane
# ---------------------------------------------------------------------------
ty, th = 5.10, 2.30
tech = [
    ("01", "目标与映射", "HTTP/UI\nCompetitionStore / SQLite\nmarket_orders → targets → mappings\nModelGateway：门店 / 商品匹配\nstoreGate / itemGate → 人工确认"),
    ("02", "计划与槽位", "market_plans\nruns / slots\n账号 / 设备 / 收货点 / 餐期\nplan revision → 槽位展开\n（试点 162）\nexpire 过期窗口"),
    ("", "", ""),
    ("04", "校验与证据", "checkObservation / checkResult\nparseCny\nModelGateway：控件定位 / 金额 / 菜单价\n结构读 + 模型读（JD）\nEvidenceStore：PNG + JSON + SHA256\n裁剪、夹取、手机号脱敏\nattempt_steps / events"),
    ("05", "比较与输出", "comparePair / comparisonRows\n同组、同资格、≤5 分钟\nreview disputed 退出\nobservations 历史 / price_changed\nCSV / UI"),
]
for i in [0, 1, 3, 4]:
    n, t, b = tech[i]
    card(ax, bx[i], ty, bw, th, n, t, b, TECH, body_size=6.4, title_size=8.5, fill="#FBFCFD")
    if i in (0, 1, 3):
        arrow(ax, bx[i] + bw + 0.02, 6.25, bx[i + 1] - 0.02, 6.25, color=ARROW, lw=1.0, ms=7.5)

# stage 3 card
x3, w3, y3, h3 = bx[2], bw, 4.65, 3.05
box(ax, x3, y3, w3, h3, fc="#FBFCFD", ec="#C9D3DE", lw=1.0, rad=0.06, shadow=True)
ax.add_patch(Rectangle((x3 + 0.03, y3 + 0.06), 0.06, h3 - 0.12, facecolor=TECH, edgecolor="none", zorder=5))
ax.add_patch(Circle((x3 + 0.27, y3 + h3 - 0.27), 0.13, facecolor=TECH, edgecolor="none", zorder=5))
text(ax, x3 + 0.27, y3 + h3 - 0.27, "03", size=6.3, color="white", weight="bold", ha="center", va="center")
text(ax, x3 + 0.47, y3 + h3 - 0.16, "调度与采集", size=8.1, weight="bold", color=INK)
text(ax, x3 + 0.15, y3 + h3 - 0.50, "Scheduler.tick → claim\n账号 + 设备锁 / timeout / 关键失败暂停", size=5.6, color="#3B4B5C", linespacing=1.12)

# JD live sub-box
jdx, jdy, jdw, jdh = x3 + 0.12, y3 + 0.90, w3 - 0.24, 1.30
box(ax, jdx, jdy, jdw, jdh, fc="#EAF4EE", ec="#8FBF9A", lw=0.95, rad=0.05)
text(ax, jdx + 0.09, jdy + jdh - 0.10, "京东 live", size=6.4, weight="bold", color=LIVE)
text(ax, jdx + 0.09, jdy + jdh - 0.33,
     "ADB → Midscene AndroidDevice\nReviewedScreen：UI 树 + 控件锚点\nopenJdStore → scanJdShelf\n（前五，需销量锚点）\njdQuoteTasks → 5 个报价槽\n加购 → 结算 → 读应付 → 恢复",
     size=5.8, color="#2F4F45", linespacing=1.10)

# fixture sub-box
fxx, fxy, fxw, fxh = x3 + 0.12, y3 + 0.10, w3 - 0.24, 0.65
box(ax, fxx, fxy, fxw, fxh, fc="#FFF4E5", ec="#D8A56A", lw=0.9, rad=0.05, dashed=True)
text(ax, fxx + 0.09, fxy + fxh - 0.10, "美团 / 淘宝 · fixture", size=6.0, weight="bold", color=FIXTURE)
text(ax, fxx + 0.09, fxy + fxh - 0.33, "Playwright 本机回放\nFixtureCollector · 只产 synthetic", size=5.6, color="#6B4E2E", linespacing=1.10)

arrow(ax, bx[1] + bw + 0.02, 6.25, x3 - 0.02, 6.25, color=ARROW, lw=1.0, ms=7.5)
arrow(ax, x3 + w3 + 0.02, 6.25, bx[3] - 0.02, 6.25, color=ARROW, lw=1.0, ms=7.5)

# ---------------------------------------------------------------------------
# bottom status and boundaries
# ---------------------------------------------------------------------------
text(ax, 0.62, 3.75, "平台现状与落地边界", size=8.6, weight="bold", color=INK)
status = [
    ("京东外卖 · live", "Android 真机链路已实现\nADB + Midscene + 控件锚点\n待真机验收、来源授权、模型配置", LIVE, "#EAF4EE", "#8FBF9A"),
    ("美团 · fixture", "仅本机 Playwright 回放\n真实入口未接通\n状态 pending", FIXTURE, "#FFF4E5", "#D8A56A"),
    ("淘宝闪购 · fixture", "仅本机 Playwright 回放\n书面许可前置\n状态 restricted", RESTRICTED, "#FCECEC", "#C7837C"),
]
sx = [0.90, 6.75, 12.60]
sw, sh, sy = 5.55, 0.95, 2.45
for (title, body, color, fill, edge), x in zip(status, sx):
    box(ax, x, sy, sw, sh, fc=fill, ec=edge, lw=0.95, rad=0.05)
    text(ax, x + 0.14, sy + sh - 0.14, title, size=6.6, weight="bold", color=color)
    text(ax, x + 0.14, sy + sh - 0.38, body, size=6.0, color="#3B4B5C", linespacing=1.12)

box(ax, 0.90, 0.60, 8.75, 1.05, fc="#FFFFFF", ec="#C9D3DE", lw=0.95, rad=0.05)
text(ax, 1.04, 1.50, "边界", size=6.4, weight="bold", color=INK)
text(ax, 1.04, 1.27, "不提交订单 / 不支付\n不绕验证码、签名、风控\n账号与设备串行；关键失败暂停并保留原因\n模型密钥留在本机；证据脱敏", size=5.85, color="#3B4B5C", linespacing=1.12)
box(ax, 9.90, 0.60, 9.10, 1.05, fc="#FFFFFF", ec="#C9D3DE", lw=0.95, rad=0.05)
text(ax, 10.04, 1.50, "数据落点", size=6.4, weight="bold", color=INK)
text(ax, 10.04, 1.27, "SQLite：runs / slots / attempts / attempt_steps / observations / locks / paused_resources + market_*\nEvidenceStore：PNG + JSON + SHA256\n比较结果：价差、明细、复核、CSV / UI", size=5.7, color="#3B4B5C", linespacing=1.12)

# ---------------------------------------------------------------------------
# save
# ---------------------------------------------------------------------------
png = OUT / "collection_route.png"
svg = OUT / "collection_route.svg"
pdf = OUT / "collection_route.pdf"
fig.savefig(png, dpi=220, facecolor=BG, bbox_inches=None)
fig.savefig(svg, facecolor=BG, bbox_inches=None)
fig.savefig(pdf, facecolor=BG, bbox_inches=None)
print(f"wrote {png}")
print(f"wrote {svg}")
print(f"wrote {pdf}")
