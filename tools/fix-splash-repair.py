#!/usr/bin/env python3
"""
Repair wrongly-placed splash code in bomberman-poop.html and blocks-burg.html.
Run on VPS: python3 /tmp/fix-splash-repair.py
"""

# === FIX BOMBERMAN-POOP ===
filepath = '/var/www/tasern/games/bomberman-poop.html'
with open(filepath, 'r') as f:
    content = f.read()

# Remove the wrongly-placed splash gameloop code from the touchstart handler
bad_block = """  if (state === 'splash') {
    splashTimer -= dt;
    if (splashTimer <= 0) { state = 'title'; }
    drawSplash();
    requestAnimationFrame(gameLoop);
    return;
  }

"""
if bad_block in content:
    content = content.replace(bad_block, '', 1)
    print('bomberman-poop: removed bad block from touchstart')
else:
    print('bomberman-poop: bad block not found (may already be fixed)')

# Now add the splash handling at the correct place: inside gameLoop, before 'title' check
# The gameLoop has: ctx.fillRect(0, 0, W, H); then if (state === 'title')
splash_gameloop = """  if (state === 'splash') {
    splashTimer -= dt;
    if (splashTimer <= 0) { state = 'title'; }
    drawSplash();
    requestAnimationFrame(gameLoop);
    return;
  }

  """

target = "ctx.fillRect(0, 0, W, H);\n\n  if (state === 'title')"
if target in content:
    content = content.replace(
        target,
        "ctx.fillRect(0, 0, W, H);\n\n" + splash_gameloop + "if (state === 'title')",
        1
    )
    print('bomberman-poop: added splash to gameLoop')
else:
    print('bomberman-poop: gameLoop target not found')

with open(filepath, 'w') as f:
    f.write(content)
print('bomberman-poop: SAVED')


# === FIX BLOCKS-BURG ===
filepath = '/var/www/tasern/games/blocks-burg.html'
with open(filepath, 'r') as f:
    content = f.read()

# The bad output has case "splash" before the switch statement
bad_switch = """  case "splash": drawSplashScreen(); break;
    switch (STATE.screen) {
    case "title":"""

good_switch = """  switch (STATE.screen) {
    case "splash": drawSplashScreen(); break;
    case "title":"""

if bad_switch in content:
    content = content.replace(bad_switch, good_switch, 1)
    print('blocks-burg: fixed switch case ordering')
else:
    print('blocks-burg: bad switch pattern not found (may already be fixed)')

with open(filepath, 'w') as f:
    f.write(content)
print('blocks-burg: SAVED')
