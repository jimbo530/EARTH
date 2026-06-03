#!/usr/bin/env python3
"""
fix-leaderboard-scan.py - Fix leaderboard.html scan loop to use ALL_FACTORIES
Run on VPS: python3 /tmp/fix-leaderboard-scan.py
"""

import os

PATH = "/var/www/tasern/leaderboard.html"

def main():
    if not os.path.exists(PATH):
        print(f"ERROR: {PATH} not found")
        return

    with open(PATH, 'r', encoding='utf-8') as f:
        content = f.read()

    # The old scan block (exact match from the file):
    old_scan = """  try {
    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    const currentBlock = await provider.getBlockNumber();
    for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += CHUNK + 1) {
      const to = Math.min(from + CHUNK, currentBlock);
      const events = await factory.queryFilter("TokenLaunched", from, to);
      for (const ev of events) {
        if (!BRICKED.has(ev.args.reactor)) {
          allReactors.push(ev.args.reactor);
          allReactors.push(ev.args.charReactor);
        }
      }
    }
  } catch (e) { console.warn("Factory scan:", e.message); }"""

    new_scan = """  try {
    const currentBlock = await provider.getBlockNumber();
    for (const f of ALL_FACTORIES) {
      const factory = new ethers.Contract(f.addr, FACTORY_ABI, provider);
      for (let from = f.deployBlock; from <= currentBlock; from += CHUNK + 1) {
        const to = Math.min(from + CHUNK, currentBlock);
        try {
          const events = await factory.queryFilter("TokenLaunched", from, to);
          for (const ev of events) {
            if (!BRICKED.has(ev.args.reactor)) {
              allReactors.push(ev.args.reactor);
              allReactors.push(ev.args.charReactor);
            }
          }
        } catch (e) { console.warn("scan chunk skip:", f.addr.slice(0,10), e.message); }
      }
    }
  } catch (e) { console.warn("Factory scan:", e.message); }"""

    if old_scan in content:
        content = content.replace(old_scan, new_scan)
        with open(PATH, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"SUCCESS: Updated scan loop in {PATH} to iterate ALL_FACTORIES")
    else:
        print("WARN: Exact scan block not found. Checking if already fixed...")
        if 'for (const f of ALL_FACTORIES)' in content:
            print("Already fixed!")
        else:
            print("ERROR: Could not match scan block. Manual fix needed.")
            # Print what we see around line 179
            lines = content.split('\n')
            for i, line in enumerate(lines):
                if 'new ethers.Contract(FACTORY' in line or 'queryFilter' in line:
                    print(f"  Line {i+1}: {line.rstrip()}")

if __name__ == "__main__":
    main()
