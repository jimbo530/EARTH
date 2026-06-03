#!/usr/bin/env python3
"""
Fix two bugs in baseball-stars.html:
1. TAS.particles.spawn calls use wrong signature (passing options object as 3rd arg).
   Correct: TAS.particles.spawn(x, y, color, count, speed, opts)
2. TAS.fx.shake calls use decay values > 1 which makes shake grow instead of decay.
   Fix: use 0.85 as decay.
"""

import re
import sys

FILE = '/var/www/tasern/games/baseball-stars.html'

with open(FILE, 'r') as f:
    content = f.read()

original = content
changes = []

# ============================================================
# Bug 1: Fix TAS.particles.spawn calls
# ============================================================

# Pattern 1 (line 328): TAS.particles.spawn(240, 250, { count: 5, color: '#fff', speed: 2, life: 20 });
# Needs to become: TAS.particles.spawn(240, 250, '#fff', 5, 2, { life: 20 });
old1 = "TAS.particles.spawn(240, 250, { count: 5, color: '#fff', speed: 2, life: 20 });"
new1 = "TAS.particles.spawn(240, 250, '#fff', 5, 2, { life: 20 });"
if old1 in content:
    content = content.replace(old1, new1)
    changes.append(f"FIXED: foul ball particles\n  OLD: {old1}\n  NEW: {new1}")

# Pattern 2 (lines 394-398): homeRun fireworks
# TAS.particles.spawn(rnd(100, 380), rnd(20, 120), {
#   count: 3, color: pick([...]),
#   speed: rnd(1, 4), life: rnd(30, 60), gravity: 0.05
# });
# Extract and rebuild these multi-line spawn calls in the homeRun fireworks loop
old2 = """TAS.particles.spawn(rnd(100, 380), rnd(20, 120), {
      count: 3, color: pick(['#ff0','#f80','#f00','#0ff','#fff']),
      speed: rnd(1, 4), life: rnd(30, 60), gravity: 0.05
    });"""
new2 = """TAS.particles.spawn(rnd(100, 380), rnd(20, 120), pick(['#ff0','#f80','#f00','#0ff','#fff']), 3, rnd(1, 4), { life: rnd(30, 60), gravity: 0.05 });"""
if old2 in content:
    content = content.replace(old2, new2)
    changes.append(f"FIXED: homeRun fireworks particles\n  OLD: (x, y, {{count:3, color:..., speed:..., ...}})\n  NEW: (x, y, color, 3, speed, {{life:..., gravity:...}})")

# Pattern 3 (lines 857-860): celebration timer particles
old3 = """TAS.particles.spawn(rnd(50, 430), rnd(10, 100), {
        count: 2, color: pick(['#ff0','#f80','#0ff','#fff']),
        speed: rnd(1, 3), life: rnd(20, 40), gravity: 0.05
      });"""
new3 = """TAS.particles.spawn(rnd(50, 430), rnd(10, 100), pick(['#ff0','#f80','#0ff','#fff']), 2, rnd(1, 3), { life: rnd(20, 40), gravity: 0.05 });"""
if old3 in content:
    content = content.replace(old3, new3)
    changes.append(f"FIXED: celebration particles\n  OLD: (x, y, {{count:2, color:..., speed:..., ...}})\n  NEW: (x, y, color, 2, speed, {{life:..., gravity:...}})")

# ============================================================
# Bug 2: Fix TAS.fx.shake decay values
# ============================================================

# Line 316: TAS.fx.shake(3, 4) -> TAS.fx.shake(3, 0.85)
old_shake1 = "TAS.fx.shake(3, 4);"
new_shake1 = "TAS.fx.shake(3, 0.85);"
if old_shake1 in content:
    content = content.replace(old_shake1, new_shake1)
    changes.append(f"FIXED: contact shake\n  OLD: {old_shake1}\n  NEW: {new_shake1}")

# Line 387: TAS.fx.shake(8, 15) -> TAS.fx.shake(8, 0.85)
old_shake2 = "TAS.fx.shake(8, 15);"
new_shake2 = "TAS.fx.shake(8, 0.85);"
if old_shake2 in content:
    content = content.replace(old_shake2, new_shake2)
    changes.append(f"FIXED: homeRun shake\n  OLD: {old_shake2}\n  NEW: {new_shake2}")

# ============================================================
# Write result
# ============================================================

if content == original:
    print("WARNING: No changes were made! Patterns may not match.")
    sys.exit(1)

with open(FILE, 'w') as f:
    f.write(content)

print(f"SUCCESS: {len(changes)} fixes applied to {FILE}\n")
for i, c in enumerate(changes, 1):
    print(f"  {i}. {c}\n")
