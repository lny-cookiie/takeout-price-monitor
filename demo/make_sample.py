"""Generate synthetic sample data for the price-gap demo.

The data is fictional. It exists to show the calculation and report format,
not to represent any real merchant or platform price.
"""

import json
from pathlib import Path

STORES = [
    {"store_id": "S001", "name": "谷香鸡(国贸店)", "brand": "谷香鸡", "category": "快餐", "monthly_gmv": 1800000},
    {"store_id": "S002", "name": "川味小馆(国贸店)", "brand": "川味小馆", "category": "简餐", "monthly_gmv": 1200000},
    {"store_id": "S003", "name": "茶里茶气(国贸店)", "brand": "茶里茶气", "category": "奶茶", "monthly_gmv": 900000},
    {"store_id": "S004", "name": "轻食日记(国贸店)", "brand": "轻食日记", "category": "轻食", "monthly_gmv": 600000},
    {"store_id": "S005", "name": "北方饺子铺(国贸店)", "brand": "北方饺子铺", "category": "快餐", "monthly_gmv": 450000},
]

SKUS = [
    {"sku_id": "SKU001", "store_id": "S001", "name": "招牌鸡汤套餐", "spec": "1份", "category": "套餐"},
    {"sku_id": "SKU002", "store_id": "S001", "name": "香辣鸡腿饭", "spec": "1份", "category": "主食"},
    {"sku_id": "SKU003", "store_id": "S002", "name": "宫保鸡丁饭", "spec": "1份", "category": "主食"},
    {"sku_id": "SKU004", "store_id": "S002", "name": "麻婆豆腐套餐", "spec": "1份", "category": "套餐"},
    {"sku_id": "SKU005", "store_id": "S003", "name": "珍珠奶茶", "spec": "大杯", "category": "饮品"},
    {"sku_id": "SKU006", "store_id": "S003", "name": "芋泥波波奶茶", "spec": "大杯", "category": "饮品"},
    {"sku_id": "SKU007", "store_id": "S004", "name": "鸡胸沙拉", "spec": "1份", "category": "轻食"},
    {"sku_id": "SKU008", "store_id": "S004", "name": "牛油果三明治", "spec": "1份", "category": "轻食"},
    {"sku_id": "SKU009", "store_id": "S005", "name": "猪肉白菜饺子", "spec": "12只", "category": "主食"},
    {"sku_id": "SKU010", "store_id": "S005", "name": "韭菜鸡蛋饺子", "spec": "12只", "category": "主食"},
]

# store, sku, platform, list_price, packaging, delivery, merchant_discount,
# platform_discount, member_discount, payment_discount
ROWS = [
    ("S001", "SKU001", "美团", 32.0, 1.0, 3.0, 5.0, 3.0, 0.0, 0.5),
    ("S001", "SKU001", "淘宝闪购", 30.0, 1.0, 2.5, 4.0, 2.0, 0.0, 0.5),
    ("S001", "SKU001", "京东外卖", 33.0, 1.5, 3.5, 3.0, 1.0, 0.0, 0.0),
    ("S001", "SKU002", "美团", 28.0, 1.0, 3.0, 4.0, 2.0, 0.0, 0.5),
    ("S001", "SKU002", "淘宝闪购", 27.0, 1.0, 2.5, 3.0, 2.0, 0.0, 0.5),
    ("S001", "SKU002", "京东外卖", 28.0, 1.0, 3.0, 3.0, 2.0, 0.0, 0.0),
    ("S002", "SKU003", "美团", 26.0, 1.0, 3.0, 4.0, 2.0, 0.0, 0.5),
    ("S002", "SKU003", "淘宝闪购", 25.0, 1.0, 2.5, 3.0, 2.0, 0.0, 0.5),
    ("S002", "SKU003", "京东外卖", 26.0, 1.0, 3.0, 1.0, 1.0, 0.0, 0.0),
    ("S002", "SKU004", "美团", 22.0, 1.0, 2.5, 2.0, 1.0, 0.0, 0.5),
    ("S002", "SKU004", "淘宝闪购", 21.0, 1.0, 2.5, 2.0, 1.0, 0.0, 0.5),
    ("S002", "SKU004", "京东外卖", 20.0, 1.0, 2.0, 3.0, 1.0, 0.0, 0.0),
    ("S003", "SKU005", "美团", 18.0, 0.5, 2.5, 2.0, 1.0, 0.0, 0.0),
    ("S003", "SKU005", "淘宝闪购", 17.0, 0.5, 2.0, 1.0, 1.0, 0.0, 0.0),
    ("S003", "SKU005", "京东外卖", 19.0, 0.5, 3.0, 2.0, 0.0, 0.0, 0.0),
    ("S003", "SKU006", "美团", 22.0, 0.5, 2.5, 3.0, 1.0, 0.0, 0.0),
    ("S003", "SKU006", "淘宝闪购", 21.0, 0.5, 2.0, 2.0, 1.0, 0.0, 0.0),
    ("S003", "SKU006", "京东外卖", 22.0, 0.5, 2.5, 3.0, 1.0, 0.0, 0.0),
    ("S004", "SKU007", "美团", 29.0, 1.0, 3.5, 5.0, 2.0, 0.0, 0.5),
    ("S004", "SKU007", "淘宝闪购", 28.0, 1.0, 3.0, 4.0, 2.0, 0.0, 0.5),
    ("S004", "SKU007", "京东外卖", 26.0, 1.0, 3.0, 4.0, 2.0, 0.0, 0.0),
    ("S004", "SKU008", "美团", 26.0, 1.0, 3.0, 3.0, 1.0, 0.0, 0.5),
    ("S004", "SKU008", "淘宝闪购", 25.0, 1.0, 3.0, 3.0, 1.0, 0.0, 0.5),
    ("S004", "SKU008", "京东外卖", 27.0, 1.0, 3.0, 2.0, 1.0, 0.0, 0.0),
    ("S005", "SKU009", "美团", 24.0, 1.0, 2.5, 3.0, 2.0, 0.0, 0.5),
    ("S005", "SKU009", "淘宝闪购", 23.0, 1.0, 2.5, 3.0, 2.0, 0.0, 0.5),
    ("S005", "SKU009", "京东外卖", 24.0, 1.0, 3.0, 2.0, 2.0, 0.0, 0.0),
    ("S005", "SKU010", "美团", 22.0, 1.0, 2.5, 3.0, 1.0, 0.0, 0.5),
    ("S005", "SKU010", "淘宝闪购", 21.0, 1.0, 2.5, 3.0, 1.0, 0.0, 0.5),
    ("S005", "SKU010", "京东外卖", 22.0, 1.0, 3.0, 3.0, 1.0, 0.0, 0.0),
]

# Platform-funded subsidy per order, only known for JD's own observations.
# Competitor subsidy cost is not observable, so it is set to 0 in this demo.
JD_SUBSIDY = {
    ("S001", "SKU001"): 1.0,
    ("S001", "SKU002"): 1.0,
    ("S002", "SKU003"): 1.0,
    ("S002", "SKU004"): 1.0,
    ("S003", "SKU005"): 0.5,
    ("S003", "SKU006"): 0.5,
    ("S004", "SKU007"): 1.0,
    ("S004", "SKU008"): 1.0,
    ("S005", "SKU009"): 0.5,
    ("S005", "SKU010"): 0.5,
}

observations = []
for i, row in enumerate(ROWS, 1):
    store_id, sku_id, platform, list_price, packaging, delivery, merchant, platform_disc, member, payment = row
    final_price = round(list_price + packaging + delivery - merchant - platform_disc - member - payment, 2)
    subsidy_cost = JD_SUBSIDY.get((store_id, sku_id), 0.0) if platform == "京东外卖" else 0.0
    observations.append({
        "observation_id": f"OBS{i:03d}",
        "store_id": store_id,
        "sku_id": sku_id,
        "platform": platform,
        "list_price": list_price,
        "packaging_fee": packaging,
        "delivery_fee": delivery,
        "merchant_discount": merchant,
        "platform_discount": platform_disc,
        "member_discount": member,
        "payment_discount": payment,
        "final_price": final_price,
        "platform_subsidy_cost": subsidy_cost,
        "captured_at": "2026-11-01T11:30:00+08:00",
        "probe_id": f"P{i:03d}",
        "account_type": "老客非会员",
        "source": "synthetic",
    })

data = {
    "meta": {
        "title": "外卖三平台价格力示例数据",
        "date": "2026-11-01",
        "city": "北京",
        "business_district": "国贸",
        "currency": "CNY",
        "note": "全部为模拟数据，仅用于演示计算和报告格式，不代表任何真实商户或平台价格。",
    },
    "stores": STORES,
    "skus": SKUS,
    "observations": observations,
}

out = Path(__file__).with_name("sample_data.json")
out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"wrote {out} ({len(observations)} observations)")
