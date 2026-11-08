"""Draw the two complete-form route maps for packaged-product price collection.

1. Technical route: full target-state architecture across six stages.
2. Business route: the business question and decision logic at the same six stages.

Both figures share the same stage order, colors and header so they can be read
side by side.
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch, Rectangle

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "前期调研" / "图表"
OUT.mkdir(parents=True, exist_ok=True)

FONT = "Microsoft YaHei"
INK = "#22313F"
MUTED = "#647385"
LINE = "#CFD8E2"
BG = "#F7F9FB"
ARROW = "#53677A"
AI = "#6F5AA6"

plt.rcParams["font.family"] = FONT
plt.rcParams["axes.unicode_minus"] = False

STAGE_COLORS = ["#2F6B9A", "#347A6B", "#6F5AA6", "#B26A2E", "#A44A4A", "#4E7A3A"]
TECH_NAMES = [
    ("①", "输入层", "包销池"),
    ("②", "认知层", "同品识别"),
    ("③", "采集层", "同条件采价"),
    ("④", "评估层", "价差与 UE"),
    ("⑤", "执行层", "策略落地"),
    ("⑥", "反馈层", "复盘回流"),
]
BUSINESS_NAMES = [
    ("①", "包销品池", ""),
    ("②", "同品识别", ""),
    ("③", "同条件采价", ""),
    ("④", "价差与 UE", ""),
    ("⑤", "策略执行", ""),
    ("⑥", "复盘回流", ""),
]

CANVAS_W, CANVAS_H = 20, 13.5
X0, CARD_W, GAP = 0.55, 3.0, 0.23
CARD_TOP, CARD_BOTTOM = 11.20, 4.85
HEADER_Y, HEADER_H = 11.50, 0.55


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


def box(ax, x, y, w, h, fc="#FFFFFF", ec=LINE, lw=0.95, rad=0.05, dashed=False, z=2, shadow=False):
    if shadow:
        ax.add_patch(FancyBboxPatch((x + 0.025, y - 0.025), w, h, boxstyle=f"round,pad=0,rounding_size={rad}",
                                    linewidth=0, facecolor="#E1E6EC", zorder=z - 1))
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={rad}", linewidth=lw,
                                edgecolor=ec, facecolor=fc, linestyle=(0, (4, 2)) if dashed else "-", zorder=z))


def text(ax, x, y, s, size=6.2, color=INK, weight="normal", ha="left", va="top", z=6, linespacing=1.16, bbox=None, style="normal"):
    ax.text(x, y, s, fontsize=size, color=color, fontweight=weight, ha=ha, va=va, zorder=z, linespacing=linespacing, bbox=bbox, style=style)


def arrow(ax, x1, y1, x2, y2, color=ARROW, lw=1.0, ms=8, ls="-", z=4):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=ms, linewidth=lw,
                                 color=color, linestyle=ls, zorder=z, shrinkA=0, shrinkB=0))


def pill(ax, x, y, w, h, s, fc, ec, size=6.2, color=INK, weight="bold", dashed=False):
    box(ax, x, y, w, h, fc=fc, ec=ec, lw=0.9, rad=0.10, dashed=dashed)
    text(ax, x + w / 2, y + h / 2, s, size=size, color=color, weight=weight, ha="center", va="center")


def stage_frame(ax, mode: str):
    """Draw header, six stage pills and six card shells."""
    ax.add_patch(Rectangle((0, 13.32), 20, 0.18, facecolor=INK, edgecolor="none", zorder=1))
    title = "包销品竞对价格智能采集与经营技术路线（完全体）" if mode == "tech" else "包销品竞对价格经营业务流程图（完全体）"
    subtitle = (
        "从内部包销品池到多平台同品采价、UE 评估、策略执行与复盘回流；六阶段与业务图同序"
        if mode == "tech"
        else "从包销品池到同品识别、同条件采价、价差与 UE 评估、策略执行与复盘回流；六阶段与技术图同序"
    )
    legend = (
        "实线：技术链路　虚线：输入 / 约束 / 预测 / 输出"
        if mode == "tech"
        else "实线：业务动作　虚线：规则 / 证据 / 判断 / 回流"
    )
    text(ax, 0.55, 12.98, title, size=18.5, weight="bold", color=INK)
    text(ax, 0.55, 12.62, subtitle, size=8.6, color=MUTED)
    text(ax, 19.40, 12.62, legend, size=6.3, color=MUTED, ha="right")
    text(ax, 19.40, 13.02, "完全体目标态 · 全链路跑通", size=7.2, color=MUTED, ha="right")

    names = TECH_NAMES if mode == "tech" else BUSINESS_NAMES
    for i, (num, name, sub) in enumerate(names):
        x = X0 + i * (CARD_W + GAP)
        color = STAGE_COLORS[i]
        box(ax, x, HEADER_Y, CARD_W, HEADER_H, fc=color, ec=color, lw=0.8, rad=0.08)
        if sub:
            text(ax, x + 0.14, HEADER_Y + HEADER_H / 2 + 0.07, f"{num} {name}", size=8.0, color="white", weight="bold", va="center")
            text(ax, x + 0.14, HEADER_Y + HEADER_H / 2 - 0.12, sub, size=5.7, color="#EAF0F6", va="center")
        else:
            text(ax, x + 0.14, HEADER_Y + HEADER_H / 2, f"{num} {name}", size=8.0, color="white", weight="bold", va="center")
        if i < 5:
            text(ax, x + CARD_W + GAP / 2, HEADER_Y + HEADER_H / 2, "›", size=11, color="#8B9AAA", ha="center", va="center")
        # card shell
        box(ax, x, CARD_BOTTOM, CARD_W, CARD_TOP - CARD_BOTTOM, fc="#FFFFFF", ec="#C9D3DE", lw=0.95, rad=0.06, shadow=True)
        ax.add_patch(Rectangle((x + 0.03, CARD_TOP - 0.06), CARD_W - 0.06, 0.05, facecolor=color, edgecolor="none", zorder=5))
    return [X0 + i * (CARD_W + GAP) for i in range(6)]


def card_title(ax, x, title, subtitle=""):
    text(ax, x + 0.14, CARD_TOP - 0.14, title, size=8.1, weight="bold", color=INK)
    if subtitle:
        text(ax, x + 0.14, CARD_TOP - 0.42, subtitle, size=5.7, color=MUTED, style="normal")


def sub_box(ax, x, y, w, h, title, body, color="#2F6B9A", fill="#F7FAFD", dashed=False, title_size=6.1, body_size=5.35):
    box(ax, x, y, w, h, fc=fill, ec=color, lw=0.85, rad=0.04, dashed=dashed)
    wrapped = wrap_mixed(body, (w - 0.14) * 72 / (body_size * 1.05))
    if h >= 0.78:
        # Center the title + body block so tall boxes do not leave a large gap
        # under the title.
        body_h = (wrapped.count("\n") + 1) * body_size * 1.10 / 72
        title_h = title_size * 1.20 / 72
        gap = 0.10
        total = title_h + gap + body_h
        top = y + (h - total) / 2 + total
        text(ax, x + 0.08, top, title, size=title_size, weight="bold", color=color)
        text(ax, x + 0.08, top - title_h - gap, wrapped, size=body_size, color="#344454", linespacing=1.10)
    else:
        text(ax, x + 0.08, y + h - 0.07, title, size=title_size, weight="bold", color=color)
        text(ax, x + 0.08, y + h - 0.29, wrapped, size=body_size, color="#344454", linespacing=1.10)


def memory_bus(ax, mode: str, xs):
    y = 12.28
    start = xs[5] + CARD_W / 2
    ax.plot([start, start], [HEADER_Y + HEADER_H, y], color=AI, lw=1.0, ls=(0, (4, 2)), zorder=4)
    if mode == "tech":
        targets = [xs[1], xs[2], xs[3], xs[4]]
        label = "Memory：采集 / 匹配样本、模型与策略效果回流"
    else:
        targets = [xs[0], xs[1], xs[4]]
        label = "结果回流：更新包销池、同品映射与策略库"
    ax.plot([start, xs[1] + CARD_W / 2], [y, y], color=AI, lw=1.0, ls=(0, (4, 2)), zorder=4)
    ax.plot([xs[1] + CARD_W / 2, xs[4] + CARD_W / 2], [y, y], color=AI, lw=1.0, ls=(0, (4, 2)), zorder=4)
    for target in targets:
        cx = target + CARD_W / 2
        arrow(ax, cx, y, cx, HEADER_Y + HEADER_H + 0.01, color=AI, lw=1.0, ms=7, ls=(0, (4, 2)))
    text(ax, 10.0, y + 0.06, label, size=6.2, color=AI, weight="bold", ha="center", va="bottom",
         bbox=dict(facecolor=BG, edgecolor="none", pad=1.2))


def footer(ax, mode: str):
    text(ax, 0.55, 4.38, "横向支撑" if mode == "tech" else "业务支撑", size=8.6, weight="bold", color=INK)


def support_panel(ax, x, y, w, h, title, rows, color, fill):
    """Bottom support panel: one bold row label plus one body line."""
    box(ax, x, y, w, h, fc=fill, ec=color, lw=0.95, rad=0.05)
    text(ax, x + 0.16, y + h - 0.22, title, size=7.2, weight="bold", color=color)
    yy = y + h - 0.58
    for i, (label, body) in enumerate(rows):
        text(ax, x + 0.16, yy, label, size=5.9, weight="bold", color=color)
        text(ax, x + 0.16, yy - 0.20,
             wrap_mixed(body, (w - 0.30) * 72 / (5.35 * 1.05)),
             size=5.35, color="#344454", linespacing=1.08)
        if i < len(rows) - 1:
            ax.plot([x + 0.15, x + w - 0.15], [yy - 0.40, yy - 0.40],
                    color="#DCE4EC", lw=0.6, zorder=3)
        yy -= 0.66


# ---------------------------------------------------------------------------
# technical
# ---------------------------------------------------------------------------
def draw_technical():
    fig = plt.figure(figsize=(CANVAS_W, CANVAS_H), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, CANVAS_W); ax.set_ylim(0, CANVAS_H); ax.axis("off")
    ax.set_facecolor(BG); fig.patch.set_facecolor(BG)
    xs = stage_frame(ax, "tech")
    memory_bus(ax, "tech", xs)
    footer(ax, "tech")

    # 01 inputs
    x = xs[0]
    card_title(ax, x, "输入与包销池", "目标：包销 SKU、竞对候选、完整条件")
    items = [
        ("内部包销品表", "SKU / 门店 / 区域 / 周期\nis_baoxiao：true / false", "#2F6B9A", "#F2F7FC", False),
        ("京东订单与结算", "实付、供货价、结算价、补贴\n退款、售后、履约状态", "#2F6B9A", "#F2F7FC", False),
        ("竞对平台目录", "门店、菜单、活动、价格带\n品类、评分、月售", "#347A6B", "#F3F8F4", False),
        ("采集条件", "账号、券、会员、点位、餐期\n设备、版本、网络环境", "#6F5AA6", "#F6F3FA", True),
        ("外部变量", "天气、节假日、平台大促\n商圈、竞对开业 / 闭店", "#B26A2E", "#FBF6EC", True),
    ]
    yy = 9.80
    for title, body, c, f, dash in items:
        sub_box(ax, x + 0.12, yy, CARD_W - 0.24, 0.78, title, body, c, f, dash)
        yy -= 0.88
    sub_box(ax, x + 0.12, 5.35, CARD_W - 0.24, 0.70, "输出", "目标包销 SKU + 竞对候选 + 场景条件\n条件随包销品表版本更新", "#2E6B57", "#EAF4EE", True)

    # 02 cognition
    x = xs[1]
    card_title(ax, x, "认知与同品匹配", "品牌 → 门店 → 商品；规则 + 模型 + 人审")
    ladder = [
        ("品牌：模糊匹配", "搜索框品牌名、别名、多品牌；fuzzy / 向量召回\n同义词、错别字、区域别名", "#347A6B", "#F3F8F4"),
        ("门店：精准匹配", "结果页完整分店名 + 地址 + 城市；exact\n同名店按地址与城市消歧", "#347A6B", "#F3F8F4"),
        ("商品：同品匹配", "品类 + 名称 + 规格 + 选项 + 套餐组成\n同品：主料、份量、做法一致", "#2F6B9A", "#F2F7FC"),
        ("人工：确认入库", "置信度、缺项、证据；版本化 mapping\n低置信度进人工队列", AI, "#F6F3FA"),
    ]
    yy = 9.80
    for title, body, c, f in ladder:
        sub_box(ax, x + 0.12, yy, CARD_W - 0.24, 0.86, title, body, c, f)
        if yy > 8.2:
            arrow(ax, x + CARD_W / 2, yy - 0.01, x + CARD_W / 2, yy - 0.10, lw=0.8, ms=6)
        yy -= 0.96
    sub_box(ax, x + 0.12, 5.35, CARD_W - 0.24, 1.40, "品类树（同品口径）",
            "正餐：地方菜 / 烧烤 / 西餐 / 火锅\n茶饮：现制茶饮\n快餐小吃\n品类决定规格、套餐、价格带与补贴\n同品先看品类，再看规格与套餐",
            "#B26A2E", "#FBF6EC", True)

    # 03 acquisition
    x = xs[2]
    card_title(ax, x, "多平台采集与证据", "授权入口；多设备；页面状态机")
    sub_box(ax, x + 0.12, 9.78, CARD_W - 0.24, 0.65, "多平台适配器",
            "京东 Android · 美团 H5 · 淘宝 H5 · 授权 API\n统一页面状态机与证据契约", "#6F5AA6", "#F6F3FA", True)
    acq = [
        ("调度", "多设备 / 多账号 / 动态频率 / 时窗\n按餐期错峰，失败退避", "#6F5AA6", "#F6F3FA"),
        ("页面", "状态机 / 控件锚点 / 视觉定位 / OCR\n搜索 / 门店 / 菜单 / 商品 / 结算", "#2F6B9A", "#F2F7FC"),
        ("采价", "购物车 / 结算 / 券 / 配送 / 包装\n单品行单独结算，不拼篮\n每店按销量取前五，不足说明原因", "#B26A2E", "#FBF6EC"),
        ("证据", "截图 / 原文 / SHA256 / 手机号脱敏\n时间戳、设备、账号", "#4E7A3A", "#EAF4EE"),
    ]
    yy = 8.88
    for title, body, c, f in acq:
        sub_box(ax, x + 0.12, yy, CARD_W - 0.24, 0.78, title, body, c, f)
        yy -= 0.85
    sub_box(ax, x + 0.12, 5.35, CARD_W - 0.24, 0.80, "输出", "结算应付 + 费用 / 优惠 + 可回看证据\n每个报价可回看：截图 + 原文 + 时间", "#2E6B57", "#EAF4EE", True)

    # 04 prediction + assessment
    x = xs[3]
    card_title(ax, x, "预测与评估", "先判断可比，再判断能不能跟")
    sub_box(ax, x + 0.12, 9.55, CARD_W - 0.24, 1.00, "预测",
            "竞对价格 / 活动、需求、产能、补贴响应\n需求弹性 / 竞对反应 / 履约产能\n输出区间、置信度、关键假设", "#B26A2E", "#FBF6EC", True)
    assess = [
        ("可比性", "五同条件 + 5 分钟时差 + 资格有效期\n不满足则退出比较", "#2F6B9A", "#F2F7FC"),
        ("价差归因", "商品 / 配送 / 包装 / 优惠 / 补贴\n价差拆到单项费用", "#6F5AA6", "#F6F3FA"),
        ("UE 与供给", "平台 UE / 商家 UE / SKU UE\n补贴 ROI + 供给健康\n平台 UE 为正、商家 UE 可持续", "#4E7A3A", "#EAF4EE"),
    ]
    yy = 8.55
    for title, body, c, f in assess:
        sub_box(ax, x + 0.12, yy, CARD_W - 0.24, 0.92, title, body, c, f)
        yy -= 1.03
    sub_box(ax, x + 0.12, 5.35, CARD_W - 0.24, 1.00, "输出", "动作候选 + 预期 UE / ROI / 风险\n含预期增量、补贴成本、风险等级", "#2E6B57", "#EAF4EE", True)

    # 05 execution
    x = xs[4]
    card_title(ax, x, "策略与执行", "价格 / 补贴 / 供给；先仿真再落地")
    for j, (label, c) in enumerate([("价格", "#A44A4A"), ("补贴", "#B26A2E"), ("供给", "#4E7A3A")]):
        pill(ax, x + 0.12 + j * 0.92, 10.08, 0.84, 0.30, label, "#FFFFFF", c, size=6.0)
    sub_box(ax, x + 0.12, 8.90, CARD_W - 0.24, 0.82, "仿真", "乐观 / 基准 / 悲观；反事实；不通过不执行\n先小步灰度，再放量", "#6F5AA6", "#F6F3FA", True)
    sub_box(ax, x + 0.12, 7.70, CARD_W - 0.24, 0.82, "约束", "平台规则 / 预算 / 商家毛利 / 竞对反应 / 履约\n任一不满足即否决", "#B26A2E", "#FBF6EC", True)
    sub_box(ax, x + 0.12, 6.50, CARD_W - 0.24, 0.82, "执行", "审批 / 任务单 / 后台或 API / 回滚 / 审计\n灰度城市 / 门店 / 时段，小步放量", "#A44A4A", "#FCECEC")
    sub_box(ax, x + 0.12, 5.35, CARD_W - 0.24, 0.80, "输出", "执行记录 + 前后值 + 回滚条件\n失败即回滚，记录原因", "#2E6B57", "#EAF4EE", True)

    # 06 feedback
    x = xs[5]
    card_title(ax, x, "反馈与记忆", "效果归因；模型和策略持续更新")
    fb = [
        ("归因", "实验 / 准实验 / 前后对比 / 合成对照\n区分价格、补贴、供给、外部变量", "#4E7A3A", "#EAF4EE"),
        ("指标", "平台 UE、商家 UE、订单、GMV、补贴 ROI\n复购、退款、差评、配送、价格指数", "#2F6B9A", "#F2F7FC"),
        ("Memory", "匹配样本 / 模型版本 / 策略效果\n正负例、版本、效果可追溯", AI, "#F6F3FA"),
        ("AI 协同", "看板下钻 / 异常推送 / 人工审核\n异常解释、建议动作、人工确认", "#B26A2E", "#FBF6EC"),
    ]
    yy = 9.65
    for title, body, c, f in fb:
        sub_box(ax, x + 0.12, yy, CARD_W - 0.24, 0.95, title, body, c, f)
        yy -= 1.02
    sub_box(ax, x + 0.12, 5.35, CARD_W - 0.24, 1.10, "输出", "更新包销池 / 匹配 / 评估 / 策略\n下一轮沿用或修正", "#2E6B57", "#EAF4EE", True)

    # bottom cross-cutting
    bottom = [
        ("数据与证据", [
            ("统一对象", "SKU、门店、品牌、城市、品类，一套 ID 贯穿"),
            ("数据分层", "原始证据 / 标准化 / 特征 / 指标四层"),
            ("质量与血缘", "来源、版本、缺失、冲突、复核状态"),
            ("证据仓", "截图 + 同屏原文 + SHA256，可按报价回看"),
        ], "#2F6B9A", "#F2F7FC"),
        ("AI 协同", [
            ("人找 AI", "驾驶舱按城市 / 品类 / 包销 SKU 下钻"),
            ("AI 找人", "价差异常、补贴过度、竞对活动、供给风险"),
            ("人审", "品牌门店商品匹配、策略、执行三道路径"),
            ("模型治理", "版本、置信度、人工复核样本持续回流"),
        ], AI, "#F6F3FA"),
        ("治理与安全", [
            ("来源授权", "平台许可、采集范围、有效期逐条登记"),
            ("隐私保护", "手机号与地址脱敏，PII 不进入模型"),
            ("执行边界", "不提交订单、不支付、不绕验证码与风控"),
            ("审计留痕", "操作日志、证据可回看、责任到人"),
        ], "#A44A4A", "#FCECEC"),
        ("Memory", [
            ("采集规则", "页面结构、控件锚点、采集频率与失败样本"),
            ("匹配样本", "品牌 / 门店 / 商品的正例与负例"),
            ("模型与策略", "版本、参数、适用条件、失效条件"),
            ("复盘回流", "每轮更新，保留历史版本可追溯"),
        ], "#4E7A3A", "#EAF4EE"),
    ]
    bw, gap = 4.615, 0.23
    for i, (title, rows, c, f) in enumerate(bottom):
        bx = 0.55 + i * (bw + gap)
        support_panel(ax, bx, 0.65, bw, 3.20, title, rows, c, f)

    png, svg, pdf = OUT / "collection_tech_full.png", OUT / "collection_tech_full.svg", OUT / "collection_tech_full.pdf"
    for path in (png, svg, pdf):
        fig.savefig(path, dpi=220, facecolor=BG, bbox_inches=None)
    print("wrote", png)


# ---------------------------------------------------------------------------
# business
# ---------------------------------------------------------------------------
def question(ax, x, s):
    pill(ax, x + 0.12, 10.34, CARD_W - 0.24, 0.30, s, "#EEF3F8", "#8FA8BF", size=6.9, color=INK)


def draw_business():
    fig = plt.figure(figsize=(CANVAS_W, CANVAS_H), dpi=200)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_xlim(0, CANVAS_W); ax.set_ylim(0, CANVAS_H); ax.axis("off")
    ax.set_facecolor(BG); fig.patch.set_facecolor(BG)
    xs = stage_frame(ax, "business")
    memory_bus(ax, "business", xs)
    footer(ax, "business")

    # 01 pool
    x = xs[0]
    card_title(ax, x, "包销品池", "先确定卖什么")
    question(ax, x, "卖什么？")
    sub_box(ax, x + 0.12, 9.38, CARD_W - 0.24, 0.82, "内部包销品表", "SKU / 门店 / 区域 / 周期\nis_baoxiao 只有 true / false\n字段缺失标数据缺失，不推断", "#2F6B9A", "#F2F7FC")
    sub_box(ax, x + 0.12, 8.21, CARD_W - 0.24, 0.82, "经营目标", "平台 UE 为正\n商家 UE 可持续\n订单和利润健康", "#4E7A3A", "#EAF4EE")
    sub_box(ax, x + 0.12, 7.05, CARD_W - 0.24, 0.82, "业务产出", "目标包销 SKU + 门店 + 周期\n竞对候选清单\n周期：周 / 月 / 大促", "#6F5AA6", "#F6F3FA")
    sub_box(ax, x + 0.12, 5.45, CARD_W - 0.24, 1.25, "口径", "包销品只做二值判断\n不把非包销 SKU 混入包销 UE\n成交形态按订单记录\n字段缺失标缺失，不推断补值", "#B26A2E", "#FBF6EC", True)

    # 02 matching
    x = xs[1]
    card_title(ax, x, "同品识别", "品牌 → 门店 → 商品，先确认和谁比")
    question(ax, x, "和谁比？")
    ladder = [
        ("品牌", "搜索框品牌名：模糊匹配\n别名、多品牌、简繁/中英\n同义词、错别字、区域别名", "#347A6B", "#F3F8F4"),
        ("门店", "结果页门店名：精准匹配\n完整分店名 + 地址 + 城市\n同名店按地址与城市消歧", "#347A6B", "#F3F8F4"),
        ("商品", "菜品主体 + 规格 + 选项 + 套餐\n按品类归一\n主料、份量、做法一致", "#2F6B9A", "#F2F7FC"),
        ("人工", "置信度 + 缺项 + 证据\n确认后版本化\n低置信度进人工队列", AI, "#F6F3FA"),
    ]
    yy = 9.54
    for title, body, c, f in ladder:
        sub_box(ax, x + 0.12, yy, CARD_W - 0.24, 0.66, title, body, c, f)
        if yy > 7.5:
            arrow(ax, x + CARD_W / 2, yy - 0.01, x + CARD_W / 2, yy - 0.10, lw=0.8, ms=6)
        yy -= 0.81
    sub_box(ax, x + 0.12, 5.45, CARD_W - 0.24, 1.52, "品类树",
            "正餐：地方菜 / 烧烤 / 西餐 / 火锅\n茶饮：现制茶饮\n快餐小吃\n品类决定规格、套餐、价格带与补贴\n同品先看品类，再看规格与套餐",
            "#B26A2E", "#FBF6EC", True)

    # 03 price
    x = xs[2]
    card_title(ax, x, "同条件采价", "每店按销量取前五，先确认到手价")
    question(ax, x, "到手价多少？")
    sub_box(ax, x + 0.12, 9.25, CARD_W - 0.24, 0.95, "五同条件",
            "同店、同品同规格、同用户\n同时段、同履约方式\n缺一项即退出比较", "#2F6B9A", "#F2F7FC")
    sub_box(ax, x + 0.12, 8.08, CARD_W - 0.24, 0.95, "结算应付",
            "商品金额 + 包装费 + 配送费\n- 优惠 / 券 / 会员权益\n实付口径，不用标价代替", "#6F5AA6", "#F6F3FA")
    sub_box(ax, x + 0.12, 6.92, CARD_W - 0.24, 0.95, "单独记录",
            "菜单价、券后价、起送价\n配送费、包装费、优惠明细\n费用和优惠逐项拆开", "#B26A2E", "#FBF6EC")
    sub_box(ax, x + 0.12, 5.45, CARD_W - 0.24, 1.25, "证据",
            "结算页截图 + 同屏原文 + 时间\n门店、规格、数量、用户条件\n采集设备、账号、券与会员状态\n缺一项就不算可比报价", "#4E7A3A", "#EAF4EE", True)

    # 04 assessment
    x = xs[3]
    card_title(ax, x, "价差与 UE", "先判断差多少，再判断能不能跟")
    question(ax, x, "差多少、差在哪？")
    sub_box(ax, x + 0.12, 9.28, CARD_W - 0.24, 0.92, "价差",
            "京东结算应付 - 竞对结算应付\n价差 / 百分比 / 价格指数\n同店同品同条件才计算", "#2F6B9A", "#F2F7FC")
    sub_box(ax, x + 0.12, 8.13, CARD_W - 0.24, 0.92, "归因",
            "商品价 / 配送 / 包装\n优惠 / 券 / 补贴\n价差拆到单项费用", "#6F5AA6", "#F6F3FA")
    sub_box(ax, x + 0.12, 6.98, CARD_W - 0.24, 0.92, "UE 与供给",
            "平台 UE / 商家 UE / SKU UE\n补贴 ROI / 供给健康\n平台 UE 为正、商家 UE 可持续", "#4E7A3A", "#EAF4EE")
    sub_box(ax, x + 0.12, 5.45, CARD_W - 0.24, 1.30, "判断",
            "差价值得跟吗？\n平台 UE 能打正吗？\n商家还可持续吗？\n竞对会跟进吗？\n缺证据或缺口径，不进入执行", "#B26A2E", "#FBF6EC", True)

    # 05 execution
    x = xs[4]
    card_title(ax, x, "策略执行", "跟价、补贴还是换供给")
    question(ax, x, "怎么做？")
    for j, (label, c) in enumerate([("价格", "#A44A4A"), ("补贴", "#B26A2E"), ("供给", "#4E7A3A")]):
        pill(ax, x + 0.12 + j * 0.92, 9.80, 0.84, 0.30, label, "#FFFFFF", c, size=6.0)
    sub_box(ax, x + 0.12, 8.85, CARD_W - 0.24, 0.75, "约束", "平台规则 / 预算 / 商家毛利 / 竞对反应 / 履约\n任一不满足即否决", "#B26A2E", "#FBF6EC", True)
    sub_box(ax, x + 0.12, 7.86, CARD_W - 0.24, 0.75, "仿真", "乐观 / 基准 / 悲观；不通过不执行\n先小步灰度，再放量", "#6F5AA6", "#F6F3FA", True)
    sub_box(ax, x + 0.12, 6.87, CARD_W - 0.24, 0.75, "执行", "审批 / 任务单 / 后台或接口 / 回滚\n灰度城市 / 门店 / 时段", "#A44A4A", "#FCECEC")
    sub_box(ax, x + 0.12, 5.45, CARD_W - 0.24, 1.18, "产出", "执行记录、前后值\n责任人、时间、证据\n异常回滚条件\n失败即回滚，记录原因", "#2E6B57", "#EAF4EE", True)

    # 06 review
    x = xs[5]
    card_title(ax, x, "复盘回流", "有没有效，下一轮怎么改")
    question(ax, x, "有没有效？")
    sub_box(ax, x + 0.12, 9.25, CARD_W - 0.24, 0.95, "四问",
            "实际 vs 仿真；差异归因\n影响用户 / 时段\n保留 / 调整 / 停止\n差异写回假设", "#4E7A3A", "#EAF4EE")
    sub_box(ax, x + 0.12, 8.07, CARD_W - 0.24, 0.95, "方法",
            "对照实验优先\n否则前后对比 / DiD / 合成对照\n样本不足时延长观察", "#2F6B9A", "#F2F7FC")
    sub_box(ax, x + 0.12, 6.90, CARD_W - 0.24, 0.95, "指标",
            "平台 UE、商家 UE、订单、GMV\n补贴 ROI、复购、退款、差评\n配送、价格指数", "#6F5AA6", "#F6F3FA")
    sub_box(ax, x + 0.12, 5.45, CARD_W - 0.24, 1.22, "回流",
            "更新包销池\n更新同品映射\n更新评估模型\n更新策略库\n版本号 + 生效时间 + 责任人", "#B26A2E", "#FBF6EC", True)

    # bottom business support
    bottom = [
        ("业务指标", [
            ("覆盖", "包销 SKU 覆盖率、同品匹配率、可比报价率"),
            ("价格", "价差、价格指数、低于竞对的 SKU 占比"),
            ("经营", "平台 UE、商家 UE、订单、GMV、补贴 ROI"),
            ("健康", "复购、退款、差评、配送、供给稳定"),
        ], "#2F6B9A", "#F2F7FC"),
        ("数据与证据", [
            ("统一口径", "SKU、门店、品牌、城市、品类一套 ID"),
            ("证据链", "结算截图 + 同屏原文 + 时间 + 设备"),
            ("质量", "同品匹配率、可比报价率、缺失与争议"),
            ("版本", "包销表 / 映射 / 策略版本可追溯"),
        ], "#347A6B", "#F3F8F4"),
        ("AI 协同", [
            ("人找 AI", "按城市 / 品类 / 包销 SKU 逐层下钻"),
            ("AI 找人", "价差异常、补贴过度、竞对活动、供给风险"),
            ("人审", "品牌门店商品匹配、策略、执行"),
            ("闭环", "任务推送、处理结果回写、效果复核"),
        ], AI, "#F6F3FA"),
        ("业务规则", [
            ("包销二值", "true / false，非包销 SKU 不混入包销 UE"),
            ("可比口径", "五同条件、5 分钟时差、证据先行"),
            ("决策边界", "平台 UE 为正，商家 UE 可持续"),
            ("执行红线", "不提交订单、不支付、不绕风控"),
        ], "#4E7A3A", "#EAF4EE"),
    ]
    bw, gap = 4.60, 0.25
    for i, (title, rows, c, f) in enumerate(bottom):
        bx = 0.55 + i * (bw + gap)
        support_panel(ax, bx, 0.65, bw, 3.20, title, rows, c, f)

    png, svg, pdf = OUT / "collection_business_full.png", OUT / "collection_business_full.svg", OUT / "collection_business_full.pdf"
    for path in (png, svg, pdf):
        fig.savefig(path, dpi=220, facecolor=BG, bbox_inches=None)
    print("wrote", png)


if __name__ == "__main__":
    draw_technical()
    draw_business()
