#!/usr/bin/env python3
"""종목 레이더 수집 스크립트 (테스트 전 초안).

하는 일
  1) 디시인사이드 갤러리 글 제목에서 종목명 언급 수를 세고, 최근 7일 평균(평소)을 history.json에 쌓아
     "평소 대비 급증"을 계산할 수 있게 trend.json에 함께 기록
  2) 종목별 현재가·등락률을 가져와 trend.json에 기록 (yfinance, 무료 시세라 지연될 수 있음)
  3) 국민연금 5% 룰 공시(DART OpenAPI, 환경변수 DART_API_KEY)
  4) 국민연금 미국 주식 13F 분기 비교(SEC EDGAR)
robots.txt가 허용하지 않는 사이트(FM코리아 등)는 건너뜁니다. FM코리아는 화면의 붙여넣기 입력칸을 쓰세요.

사용
  pip install requests beautifulsoup4 yfinance
  python stock_radar.py            # 전체 갱신(글 집계 + 시세 + 공시). 하루 몇 번 권장
  python stock_radar.py --prices   # 시세만 갱신. 1~5분마다 돌리면 화면이 1분 간격으로 반영
출력: trend.json, history.json (index.html과 같은 폴더)
"""
import json, os, re, sys, time, datetime, urllib.robotparser
from zoneinfo import ZoneInfo
from collections import defaultdict
from urllib.parse import urlparse
import requests
from bs4 import BeautifulSoup

KST = ZoneInfo("Asia/Seoul")
def now_kst():
    return datetime.datetime.now(KST)

UA = "Mozilla/5.0 (compatible; StockRadar/0.1; personal use)"
SEC_UA = os.environ.get("SEC_USER_AGENT", "StockRadar personal use your-email@example.com")  # SEC는 연락처 포함 UA를 요구
DELAY = 1.5
PAGES = 3
BASE_DAYS = 7
NPS_CIK = os.environ.get("NPS_CIK", "1608046")  # 실행 시 SEC 응답의 제출인 이름으로 한 번 더 검증함

SOURCES = {
    "neostock":  "https://gall.dcinside.com/board/lists/?id=neostock",
    "krstock":   "https://gall.dcinside.com/mgallery/board/lists/?id=krstock",
    "stockus":   "https://gall.dcinside.com/mgallery/board/lists/?id=stockus",
    "tenbagger": "https://gall.dcinside.com/mgallery/board/lists/?id=tenbagger",
    "invest":    "https://gall.dcinside.com/mgallery/board/lists/?id=invest",
    "fmkorea":   "https://www.fmkorea.com/stock",   # robots.txt 불허 → 자동으로 건너뜀
}

# 이름 → (별칭, 종목코드, 트레이딩뷰 심볼, 시세 심볼, 통화). 한 글자 별칭은 오탐이 많아 쓰지 않습니다.
STOCKS = {
    "삼성전자":   (["삼전", "삼성전자"], "005930", "KRX:005930", "005930.KS", "원"),
    "SK하이닉스": (["하이닉스", "SK하이닉스", "닉스"], "000660", "KRX:000660", "000660.KS", "원"),
    "현대로템":   (["현대로템", "로템"], "064350", "KRX:064350", "064350.KS", "원"),
    "한화에어로스페이스": (["한화에어로", "한화에어로스페이스"], "012450", "KRX:012450", "012450.KS", "원"),
    "두산에너빌리티": (["두산에너빌", "두에빌"], "034020", "KRX:034020", "034020.KS", "원"),
    "에코프로":   (["에코프로"], "086520", "KRX:086520", "086520.KQ", "원"),
    "셀트리온":   (["셀트리온"], "068270", "KRX:068270", "068270.KS", "원"),
    "엔비디아":   (["엔비디아", "NVDA", "엔비"], "NVDA", "NASDAQ:NVDA", "NVDA", "$"),
    "테슬라":     (["테슬라", "TSLA"], "TSLA", "NASDAQ:TSLA", "TSLA", "$"),
    "팔란티어":   (["팔란티어", "PLTR"], "PLTR", "NYSE:PLTR", "PLTR", "$"),
}

_robots = {}
def allowed(url):
    host = "{0.scheme}://{0.netloc}".format(urlparse(url))
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(host + "/robots.txt")
        try:
            rp.read()
        except Exception:
            rp = None
        _robots[host] = rp
    rp = _robots[host]
    return bool(rp) and rp.can_fetch(UA, url)

def fetch_titles(url):
    titles = []
    for page in range(1, PAGES + 1):
        r = requests.get(f"{url}&page={page}", headers={"User-Agent": UA}, timeout=15)
        if r.status_code != 200:
            break
        soup = BeautifulSoup(r.text, "html.parser")
        for a in soup.select("td.gall_tit a:not(.reply_numbox)"):
            t = a.get_text(strip=True)
            if t:
                titles.append(t)
        time.sleep(DELAY)
    return titles

def count_mentions(titles):
    out = {}
    for name, (aliases, *_rest) in STOCKS.items():
        pat = re.compile("|".join(re.escape(a) for a in aliases), re.I)
        out[name] = sum(1 for t in titles if pat.search(t))
    return out

def load_json(path, default):
    if os.path.exists(path):
        try:
            return json.load(open(path, encoding="utf-8"))
        except Exception:
            pass
    return default

# ---------- 평소(기준) 계산 ----------
def update_history(today_counts):
    """history.json: {날짜: {종목: {출처: 건수}}}. 같은 날 재실행하면 그날 값을 덮어씀."""
    hist = load_json("history.json", {})
    hist[now_kst().date().isoformat()] = today_counts
    for d in sorted(hist)[:-30]:
        del hist[d]
    json.dump(hist, open("history.json", "w", encoding="utf-8"), ensure_ascii=False)
    return hist

def baseline(hist, name):
    """오늘을 뺀 최근 BASE_DAYS일의 출처별 평균. 기록이 없으면 None(화면에 '기준 수집 중' 표시)."""
    today = now_kst().date().isoformat()
    days = [d for d in sorted(hist) if d != today][-BASE_DAYS:]
    days = [d for d in days if name in hist[d]]
    if not days:
        return None
    acc = defaultdict(float)
    for d in days:
        for src, c in hist[d][name].items():
            acc[src] += c
    return {src: round(v / len(days), 1) for src, v in acc.items()}

# ---------- 시세 ----------
def fetch_prices():
    try:
        import yfinance as yf
    except ImportError:
        print("yfinance가 없어 시세를 건너뜁니다 (pip install yfinance)")
        return {}, None
    out = {}
    for name, (_a, _c, _tv, ysym, ccy) in STOCKS.items():
        try:
            fi = yf.Ticker(ysym).fast_info
            last, prev = float(fi["last_price"]), float(fi["previous_close"])
            out[name] = {"price": round(last, 2), "chg": round((last / prev - 1) * 100, 2), "ccy": ccy}
        except Exception as e:
            print("시세 실패", name, e)
    return out, now_kst().strftime("%H:%M:%S")

# ---------- 국민연금 5% 룰 (DART) ----------
def fetch_nps(days=90):
    """DART 공시목록에서 국민연금이 낸 '주식등의대량보유' 보고를 모은다.
    반환: [[회사명, 종목코드, 수량(없으면 None), 공시일, 접수번호], ...] 최신순.
    목록 API에는 보유 수량이 없어 수량은 비워 두고, 화면에서 공시 원문 링크로 확인한다."""
    key = os.environ.get("DART_API_KEY", "").strip()
    if not key:
        return None
    end = now_kst().date()
    bgn = end - datetime.timedelta(days=days)
    rows, seen, page = [], set(), 1
    while page <= 20:
        r = requests.get("https://opendart.fss.or.kr/api/list.json", params={
            "crtfc_key": key, "bgn_de": bgn.strftime("%Y%m%d"), "end_de": end.strftime("%Y%m%d"),
            "pblntf_ty": "D", "page_no": page, "page_count": 100}, timeout=20).json()
        if r.get("status") not in ("000", "013"):   # 013 = 조회된 데이터 없음
            print("DART 응답:", r.get("status"), r.get("message"))
            break
        for it in r.get("list", []):
            if "대량보유" in it.get("report_nm", "") and "국민연금" in it.get("flr_nm", ""):
                no = it["rcept_no"]
                if no in seen:
                    continue
                seen.add(no)
                d = it["rcept_dt"]
                rows.append([it["corp_name"], it.get("stock_code", ""), None,
                             f"{d[:4]}-{d[4:6]}-{d[6:]}", no])
        if page >= int(r.get("total_page", 1) or 1):
            break
        page += 1
        time.sleep(0.3)
    rows.sort(key=lambda x: x[3], reverse=True)
    return rows[:60]

# ---------- 미국 13F (SEC EDGAR) ----------
def _sec(url):
    time.sleep(0.2)  # SEC는 초당 10회 이하를 요구
    r = requests.get(url, headers={"User-Agent": SEC_UA}, timeout=30)
    r.raise_for_status()
    return r

def _infotable(cik, accession):
    acc = accession.replace("-", "")
    base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}/"
    idx = _sec(base + "index.json").json()
    names = [i["name"] for i in idx["directory"]["item"] if i["name"].lower().endswith(".xml")]
    # 13F 표 파일은 파일명이 제각각이라 infotable 태그가 있는 xml을 찾는다
    for n in names:
        txt = _sec(base + n).text
        if "infoTable" in txt:
            soup = BeautifulSoup(txt, "xml")
            vals = defaultdict(lambda: [0.0, ""])
            for t in soup.find_all(re.compile("infoTable$")):
                cusip = t.find(re.compile("cusip$")).text.strip()
                v = float(t.find(re.compile("value$")).text)
                vals[cusip][0] += v
                vals[cusip][1] = t.find(re.compile("nameOfIssuer$")).text.strip()
            return vals
    return {}

def fetch_13f():
    sub = _sec(f"https://data.sec.gov/submissions/CIK{int(NPS_CIK):010d}.json").json()
    if "NATIONAL PENSION" not in sub.get("name", "").upper():
        print("13F: CIK의 제출인 이름이 국민연금이 아닙니다:", sub.get("name"), "→ NPS_CIK 확인 필요")
        return None
    rec = sub["filings"]["recent"]
    hits = [i for i, f in enumerate(rec["form"]) if f == "13F-HR"][:2]
    if len(hits) < 2:
        return None
    cur = _infotable(NPS_CIK, rec["accessionNumber"][hits[0]])
    old = _infotable(NPS_CIK, rec["accessionNumber"][hits[1]])
    rows = []
    for c in set(cur) | set(old):
        cv, ov = cur.get(c, [0, ""])[0], old.get(c, [0, ""])[0]
        name = (cur.get(c) or old.get(c))[1]
        status = "new" if ov == 0 else "out" if cv == 0 else "up" if cv > ov * 1.05 else "down" if cv < ov * 0.95 else None
        if status:
            rows.append({"issuer": name, "cusip": c, "prev": ov, "curr": cv, "status": status})
    # 13F value 단위는 보고서마다 달라 보일 수 있음(예전에는 천 달러). 원본 확인 필요
    rows.sort(key=lambda r: -(r["curr"] - r["prev"]))
    return {"period": rec["reportDate"][hits[0]], "filedAt": rec["filingDate"][hits[0]], "rows": rows}

def main():
    prices_only = "--prices" in sys.argv
    old = load_json("trend.json", {})
    out = dict(old) if prices_only and old else {}
    skipped = old.get("skipped", []) if prices_only else []

    if not prices_only or not old:
        counts = {n: {} for n in STOCKS}
        skipped = []
        for sid, url in SOURCES.items():
            if not allowed(url):
                skipped.append(f"{sid} (robots.txt로 자동 수집 불허 또는 확인 실패)")
                continue
            try:
                c = count_mentions(fetch_titles(url))
            except Exception as e:
                skipped.append(f"{sid} ({e})")
                continue
            for name, v in c.items():
                counts[name][sid] = v
        hist = update_history(counts)
        prev_rank = {s["name"]: i + 1 for i, s in enumerate(old.get("stocks", []))}
        stocks = []
        for name, (aliases, code, tv, _y, ccy) in STOCKS.items():
            m = counts[name]
            if sum(m.values()) > 0:
                s = {"name": name, "code": code, "tv": tv, "aliases": aliases,
                     "prev": prev_rank.get(name), "m": m}
                b = baseline(hist, name)
                if b is not None:
                    s["b"] = b
                stocks.append(s)
        stocks.sort(key=lambda s: -sum(s["m"].values()))
        out.update({"generatedAt": now_kst().strftime("%Y-%m-%d %H:%M"),
                    "skipped": skipped, "stocks": stocks,
                    "dict": [{"name": n, "code": v[1], "tv": v[2], "aliases": v[0]} for n, v in STOCKS.items()]})
        nps = fetch_nps()
        if nps:
            out["nps"] = nps
        try:
            f13 = fetch_13f()
            if f13:
                out["f13"] = f13
        except Exception as e:
            print("13F 실패:", e)

    px, at = fetch_prices()
    for s in out.get("stocks", []):
        s.update(px.get(s["name"], {}))
    out["priceAt"] = at
    json.dump(out, open("trend.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"trend.json 저장: {len(out.get('stocks', []))}종목, 시세 {len(px)}건")

if __name__ == "__main__":
    main()
