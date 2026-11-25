#!/usr/bin/env python3
"""Fake mihomo controller for UI prototype screenshots."""
import json, random, time, sys, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, unquote, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19090
random.seed(7)

REGIONS = [
    ("🇭🇰 香港", 6), ("🇯🇵 日本", 5), ("🇸🇬 新加坡", 4), ("🇺🇸 美国", 5), ("🇹🇼 台湾", 3), ("🇰🇷 韩国", 2), ("🇬🇧 英国", 2), ("🇩🇪 德国", 1),
]
NODES = []
for region, n in REGIONS:
    for i in range(1, n + 1):
        suffix = ["IEPL 专线", "BGP", "原生", "x1.5", "Premium", "游戏"][i % 6]
        NODES.append(f"{region} {i:02d} | {suffix}")

BASE_DELAY = {"香港": 38, "日本": 62, "新加坡": 71, "美国": 168, "台湾": 49, "韩国": 77, "英国": 231, "德国": 214}

def delay_of(name):
    for k, v in BASE_DELAY.items():
        if k in name:
            r = random.Random(name)
            d = v + r.randint(-12, 40)
            if r.random() < 0.08:
                return 0
            return d
    return 120

now_ms = time.strftime("%Y-%m-%dT%H:%M:%S.000+08:00")

def proxy_obj(name, typ="Shadowsocks"):
    d = delay_of(name)
    return {"name": name, "type": typ, "udp": True, "xudp": False, "tfo": False, "alive": d > 0,
            "history": [{"time": now_ms, "delay": d}], "extra": {}, "id": "", "interface": "", "mptcp": False, "smux": False, "dialer-proxy": ""}

PROXIES = {n: proxy_obj(n, random.Random(n).choice(["Shadowsocks", "Trojan", "Vmess", "Hysteria2"])) for n in NODES}
HK = [n for n in NODES if "香港" in n]
JP = [n for n in NODES if "日本" in n]
US = [n for n in NODES if "美国" in n]
SG = [n for n in NODES if "新加坡" in n]
for nm, typ in [("DIRECT", "Direct"), ("REJECT", "Reject")]:
    PROXIES[nm] = {"name": nm, "type": typ, "udp": True, "alive": True, "history": [], "extra": {}}

def group(name, typ, all_, now):
    g = {"name": name, "type": typ, "all": all_, "now": now, "udp": True, "alive": True, "history": [], "extra": {}, "hidden": False, "icon": ""}
    if typ == "URLTest":
        g["testUrl"] = "https://www.gstatic.com/generate_204"
    return g

GROUPS = [
    group("🚀 节点选择", "Selector", ["♻️ 自动选择", "🇭🇰 香港节点", "🇯🇵 日本节点", "🇺🇸 美国节点", "🇸🇬 狮城节点"] + NODES + ["DIRECT"], HK[0]),
    group("♻️ 自动选择", "URLTest", NODES, HK[2]),
    group("🇭🇰 香港节点", "URLTest", HK, HK[0]),
    group("🇯🇵 日本节点", "URLTest", JP, JP[1]),
    group("🇺🇸 美国节点", "URLTest", US, US[0]),
    group("🇸🇬 狮城节点", "URLTest", SG, SG[0]),
    group("📹 YouTube", "Selector", ["🚀 节点选择", "🇭🇰 香港节点", "🇯🇵 日本节点", "🇺🇸 美国节点"], "🚀 节点选择"),
    group("🎥 Netflix", "Selector", ["🚀 节点选择", "🇸🇬 狮城节点", "🇺🇸 美国节点"], "🇸🇬 狮城节点"),
    group("🤖 OpenAI", "Selector", ["🇺🇸 美国节点", "🇯🇵 日本节点", "🚀 节点选择"], "🇺🇸 美国节点"),
    group("🍎 Apple", "Selector", ["DIRECT", "🚀 节点选择"], "DIRECT"),
    group("🎯 全球直连", "Selector", ["DIRECT", "🚀 节点选择"], "DIRECT"),
    group("🐟 漏网之鱼", "Selector", ["🚀 节点选择", "DIRECT"], "🚀 节点选择"),
]
for g in GROUPS:
    PROXIES[g["name"]] = g
PROXIES["GLOBAL"] = group("GLOBAL", "Selector", ["DIRECT", "REJECT"] + [g["name"] for g in GROUPS] + NODES, "🚀 节点选择")

RULES = [
    ("DOMAIN-SUFFIX", "openai.com", "🤖 OpenAI"), ("DOMAIN-SUFFIX", "chatgpt.com", "🤖 OpenAI"),
    ("DOMAIN-SUFFIX", "youtube.com", "📹 YouTube"), ("DOMAIN-SUFFIX", "googlevideo.com", "📹 YouTube"),
    ("DOMAIN-SUFFIX", "netflix.com", "🎥 Netflix"), ("DOMAIN-SUFFIX", "nflxvideo.net", "🎥 Netflix"),
    ("DOMAIN-SUFFIX", "apple.com", "🍎 Apple"), ("DOMAIN-SUFFIX", "icloud.com", "🍎 Apple"),
    ("DOMAIN-SUFFIX", "github.com", "🚀 节点选择"), ("DOMAIN-KEYWORD", "google", "🚀 节点选择"),
    ("DOMAIN-SUFFIX", "bilibili.com", "🎯 全球直连"), ("DOMAIN-SUFFIX", "qq.com", "🎯 全球直连"),
    ("GEOSITE", "cn", "🎯 全球直连"), ("GEOIP", "LAN", "DIRECT"), ("GEOIP", "CN", "🎯 全球直连"), ("MATCH", "", "🐟 漏网之鱼"),
]

HOSTS = [
    ("www.youtube.com", "chrome.exe", "📹 YouTube", "DOMAIN-SUFFIX", "youtube.com"),
    ("rr3---sn-a5mekn6s.googlevideo.com", "chrome.exe", "📹 YouTube", "DOMAIN-SUFFIX", "googlevideo.com"),
    ("chatgpt.com", "chrome.exe", "🤖 OpenAI", "DOMAIN-SUFFIX", "chatgpt.com"),
    ("api.github.com", "Code.exe", "🚀 节点选择", "DOMAIN-SUFFIX", "github.com"),
    ("github.com", "git.exe", "🚀 节点选择", "DOMAIN-SUFFIX", "github.com"),
    ("www.bilibili.com", "msedge.exe", "🎯 全球直连", "DOMAIN-SUFFIX", "bilibili.com"),
    ("api.telegram.org", "Telegram.exe", "🐟 漏网之鱼", "MATCH", ""),
    ("discord.com", "Discord.exe", "🐟 漏网之鱼", "MATCH", ""),
    ("steamcommunity.com", "steam.exe", "🐟 漏网之鱼", "MATCH", ""),
    ("www.netflix.com", "msedge.exe", "🎥 Netflix", "DOMAIN-SUFFIX", "netflix.com"),
]

START = time.time()

def chain_for(grp):
    g = PROXIES.get(grp)
    out = [grp]
    seen = 0
    while g and g.get("now") and seen < 5:
        out.insert(0, g["now"])
        g = PROXIES.get(g["now"])
        seen += 1
    return out

def connections():
    t = time.time() - START
    conns = []
    for i, (host, proc, grp, rt, rp) in enumerate(HOSTS):
        up = int((i + 1) * 13400 + t * 900 * (i % 3 + 1))
        down = int((i + 1) * 284000 + t * 52000 * ((i % 4) + 1))
        conns.append({"id": f"c0a8-{i:04d}", "metadata": {"network": "tcp", "type": "HTTP", "sourceIP": "127.0.0.1", "destinationIP": "", "sourcePort": str(51000 + i),
                      "destinationPort": "443", "host": host, "dnsMode": "normal", "process": proc, "processPath": f"C:\\Program Files\\{proc}", "specialProxy": "", "sniffHost": ""},
                      "upload": up, "download": down, "start": time.strftime("%Y-%m-%dT%H:%M:%S.000+08:00", time.localtime(START - 60 * i)),
                      "chains": chain_for(grp), "rule": rt, "rulePayload": rp})
    return {"downloadTotal": int(1.84e9 + t * 400000), "uploadTotal": int(2.1e8 + t * 30000), "connections": conns, "memory": 58_000_000}

CONFIGS = {"port": 0, "socks-port": 0, "redir-port": 0, "tproxy-port": 0, "mixed-port": 7890, "allow-lan": False, "bind-address": "*", "mode": "rule",
           "log-level": "info", "ipv6": False, "tun": {"enable": False, "stack": "mixed", "device": "Zephyr"}, "unified-delay": True, "mode-list": ["rule", "global", "direct"]}

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,PUT,PATCH,POST,DELETE,OPTIONS")
    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def no_content(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()
    def do_OPTIONS(self):
        self.no_content()
    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}
    def do_PUT(self):
        p = unquote(urlparse(self.path).path)
        if p.startswith("/proxies/"):
            name = p[len("/proxies/"):]
            b = self.body()
            if name in PROXIES and b.get("name"):
                PROXIES[name]["now"] = b["name"]
            return self.no_content()
        self.body()
        return self.no_content()
    def do_PATCH(self):
        b = self.body()
        if isinstance(b, dict):
            for k, v in b.items():
                if k in CONFIGS:
                    CONFIGS[k] = v
        return self.no_content()
    do_POST = do_PATCH
    def do_DELETE(self):
        return self.no_content()
    def do_GET(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        if p == "/traffic":
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                k = 0
                while True:
                    k += 1
                    down = int(2.4e6 + 1.6e6 * abs(((k * 37) % 23) / 11.0 - 1) + random.randint(0, 600000))
                    up = int(180000 + random.randint(0, 120000))
                    line = (json.dumps({"up": up, "down": down}) + "\n").encode()
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
                    self.wfile.flush()
                    time.sleep(0.25)
            except Exception:
                return
        if p == "/memory":
            return self.send_json({"inuse": 58_000_000, "oslimit": 0})
        if p == "/version":
            return self.send_json({"meta": True, "version": "v1.19.17"})
        if p == "/configs":
            return self.send_json(CONFIGS)
        if p == "/proxies":
            return self.send_json({"proxies": PROXIES})
        if p.startswith("/proxies/") and p.endswith("/delay"):
            name = p[len("/proxies/"):-len("/delay")]
            d = delay_of(name)
            if d == 0:
                return self.send_json({"message": "timeout"}, 504)
            return self.send_json({"delay": d})
        if p.startswith("/group/") and p.endswith("/delay"):
            name = p[len("/group/"):-len("/delay")]
            g = PROXIES.get(name, {})
            return self.send_json({n: delay_of(n) for n in g.get("all", []) if n in NODES and delay_of(n)})
        if p.startswith("/proxies/"):
            name = p[len("/proxies/"):]
            return self.send_json(PROXIES.get(name, {}))
        if p == "/providers/proxies":
            return self.send_json({"providers": {"default": {"name": "default", "type": "Proxy", "vehicleType": "Compatible", "proxies": [PROXIES[n] for n in NODES]}}})
        if p == "/providers/rules":
            return self.send_json({"providers": {}})
        if p == "/rules":
            return self.send_json({"rules": [{"type": a, "payload": b, "proxy": c, "size": -1} for a, b, c in RULES]})
        if p == "/connections":
            return self.send_json(connections())
        if p == "/dns/query":
            return self.send_json({"Status": 0, "Answer": []})
        return self.send_json({})

if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
