#!/usr/bin/env python3
"""
fix-vps-launch-ui.py - Fix three issues on the MycoPad/Unruggable launch UI
Run on VPS: python3 /tmp/fix-vps-launch-ui.py

Issue 1: terms.html says "minimum $1" instead of "$5"
Issue 2: leaderboard.html only scans V4.3 factory, misses V5.2 launches
Issue 3: leaderboard.html references only old V4.3 factory address
"""

import os
import re
import sys

CHANGES = []

def fix_file(path, description, replacements):
    """Apply a list of (old, new) replacements to a file."""
    if not os.path.exists(path):
        print(f"  SKIP: {path} does not exist")
        return False

    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    for old, new in replacements:
        count = content.count(old)
        if count == 0:
            print(f"  WARN: pattern not found in {path}: {old[:60]}...")
            continue
        content = content.replace(old, new)
        print(f"  REPLACED {count}x in {path}: {old[:60]}... -> {new[:60]}...")
        CHANGES.append(f"{description}: replaced '{old[:80]}' with '{new[:80]}' ({count}x) in {path}")

    if content != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  WROTE: {path}")
        return True
    else:
        print(f"  NO CHANGES: {path}")
        return False


def fix_issue_1():
    """Fix terms.html: minimum $1 -> minimum $5"""
    print("\n=== ISSUE 1: Fix $1 -> $5 in terms.html ===")
    fix_file(
        "/var/www/tasern/terms.html",
        "Issue 1: terms.html price fix",
        [
            (
                "Launching a token requires a USDC seed deposit (minimum $1).",
                "Launching a token requires a USDC seed deposit (minimum $5)."
            ),
        ]
    )


def fix_issue_2_and_3():
    """Fix leaderboard.html: add all factories including V5.2, not just V4.3"""
    print("\n=== ISSUE 2+3: Fix leaderboard.html to include all factories ===")

    path = "/var/www/tasern/leaderboard.html"
    if not os.path.exists(path):
        print(f"  SKIP: {path} does not exist")
        return

    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content

    # Replace single FACTORY constant with ALL_FACTORIES array
    old_factory_line = 'const FACTORY = "0x51eF41E0730c0e607950421e1EE113b089867d3e";'
    old_deploy_block = 'const FACTORY_DEPLOY_BLOCK = 45523770;'

    new_factories = """const ALL_FACTORIES = [
  { addr: "0x73dA1ac6f2f83291acbe2eBCA9Ab4BF970f9dE29", deployBlock: 45400000 },
  { addr: "0x51eF41E0730c0e607950421e1EE113b089867d3e", deployBlock: 45523770 },
  { addr: "0x655e0Ca995D10912574a92a3a67AE9D466424925", deployBlock: 45523770 },
  { addr: "0xb74fe5fA2D030706B4A0C901fDC42C5244695A6e", deployBlock: 45570000 },
  { addr: "0x2e0b20a4FFEaCAcB8D3CD0cF6b9bBE6660c4262e", deployBlock: 45700000 },
  { addr: "0xF0c1B3d6Bc0B4dEd2DDF81374feEA8a2c536bD51", deployBlock: 45639600 },
];
const FACTORY = ALL_FACTORIES[ALL_FACTORIES.length - 1].addr; // V5.2 (active)
const FACTORY_DEPLOY_BLOCK = ALL_FACTORIES[0].deployBlock; // earliest"""

    if old_factory_line in content and old_deploy_block in content:
        content = content.replace(old_factory_line, new_factories)
        content = content.replace(old_deploy_block, "// FACTORY_DEPLOY_BLOCK now in ALL_FACTORIES array above")
        CHANGES.append("Issue 2+3: Added ALL_FACTORIES array with all 6 factories including V5.2 to leaderboard.html")
        print("  REPLACED single factory with ALL_FACTORIES array")
    else:
        print("  WARN: Could not find expected factory constants in leaderboard.html")
        return

    # Now fix the event scanning loop to iterate all factories
    # The original code scans a single factory:
    #   const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);
    #   for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += CHUNK + 1) {
    #     const to = Math.min(from + CHUNK, currentBlock);
    #     const logs = await factory.queryFilter("TokenLaunched", from, to);
    #     events.push(...logs);
    #   }
    # We need to wrap this in a loop over ALL_FACTORIES

    old_scan = """    const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

    for (let from = FACTORY_DEPLOY_BLOCK; from <= currentBlock; from += CHUNK + 1) {
      const to = Math.min(from + CHUNK, currentBlock);
      const logs = await factory.queryFilter("TokenLaunched", from, to);
      events.push(...logs);
    }"""

    new_scan = """    for (const f of ALL_FACTORIES) {
      const factory = new ethers.Contract(f.addr, FACTORY_ABI, provider);
      for (let from = f.deployBlock; from <= currentBlock; from += CHUNK + 1) {
        const to = Math.min(from + CHUNK, currentBlock);
        try {
          const logs = await factory.queryFilter("TokenLaunched", from, to);
          events.push(...logs);
        } catch (e) { console.warn("scan chunk skip:", f.addr.slice(0,10), e.message); }
      }
    }"""

    if old_scan in content:
        content = content.replace(old_scan, new_scan)
        CHANGES.append("Issue 2: Updated leaderboard event scan to iterate ALL_FACTORIES instead of single V4.3 factory")
        print("  REPLACED single-factory scan with multi-factory scan loop")
    else:
        print("  WARN: Could not find expected scan loop pattern in leaderboard.html")
        print("  Attempting flexible pattern match...")

        # Try a more flexible replacement
        # Just replace the single Contract line and adjust the loop
        old_contract = 'const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);'
        if old_contract in content:
            # Replace single factory scanning with multi-factory
            # Find the scanning block more flexibly
            scan_start = content.find(old_contract)
            # Find the end of the scanning for-loop (next line after events.push)
            push_idx = content.find('events.push(...logs);', scan_start)
            if push_idx > 0:
                # Find closing brace of inner for loop
                brace_idx = content.find('}', push_idx)
                if brace_idx > 0:
                    old_block = content[scan_start:brace_idx+1]
                    new_block = new_scan.strip()
                    content = content[:scan_start] + new_block + content[brace_idx+1:]
                    CHANGES.append("Issue 2: Updated leaderboard scan (flexible match)")
                    print("  REPLACED scan block (flexible match)")

    if content != original:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  WROTE: {path}")
    else:
        print(f"  NO CHANGES: {path}")


def copy_to_launcher():
    """Copy fixed leaderboard to launcher/ subdirectory if it exists there."""
    src = "/var/www/tasern/leaderboard.html"
    dst_dir = "/var/www/tasern/leaderboard/"
    if os.path.isdir(dst_dir) and os.path.exists(os.path.join(dst_dir, "index.html")):
        # leaderboard lives at /leaderboard/index.html, check if it's a copy
        import shutil
        # Only copy if they were the same before
        print(f"\n  NOTE: /var/www/tasern/leaderboard/index.html exists separately")
        print(f"  Check if it also needs the same factory fix")


def main():
    print("=" * 60)
    print("MycoPad Launch UI Fix Script")
    print("=" * 60)

    fix_issue_1()
    fix_issue_2_and_3()

    print("\n" + "=" * 60)
    print(f"SUMMARY: {len(CHANGES)} changes made")
    for i, c in enumerate(CHANGES, 1):
        print(f"  {i}. {c}")
    print("=" * 60)


if __name__ == "__main__":
    main()
