"""Exports the Web3 engine's market map as JSON for tools/populate_instruments.js.

Reads TOKEN_REGISTRY (tokens per network), STATIC_CORE_POOLS (the anchor pools per network)
and NETWORK_CONFIGS (network names) from supervisor/arbitrage_scanner.py in the web3-dex-bot
repository without importing it, so no web3 dependencies are needed. RPC endpoints are left
out.

  python3 tools/web3_markets.py /path/to/web3-dex-bot/supervisor/arbitrage_scanner.py
"""
import ast
import json
import sys

WANTED = {"TOKEN_REGISTRY": "tokens", "STATIC_CORE_POOLS": "core_pools", "NETWORK_CONFIGS": "networks"}


def read_map(path):
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read(), path)
    out = {"tokens": {}, "core_pools": {}, "networks": {}}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        else:
            continue
        for name in names:
            if name in WANTED:
                out[WANTED[name]] = ast.literal_eval(node.value)
    out["networks"] = {k: {"name": (v or {}).get("name")} for k, v in out["networks"].items()}
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: web3_markets.py <path to arbitrage_scanner.py>")
    json.dump(read_map(sys.argv[1]), sys.stdout)
