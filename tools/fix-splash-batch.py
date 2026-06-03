#!/usr/bin/env python3
"""
Add MfT 2-second splash screen to arcade games that are missing it.
Run on VPS: python3 fix-splash-batch.py
"""

import re
import os
import sys

GAMES_DIR = "/var/www/tasern/games"

# === SHARED SPLASH DRAW FUNCTION (for tasern-engine games using TAS.particles) ===
TASERN_DRAW_SPLASH = '''
// === DRAW MfT SPLASH ===
function drawSplash() {
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, GW, GH);

  var progress = 1 - (splashTimer / 2);
  var alpha = progress < 0.3 ? progress / 0.3 : progress > 0.7 ? (1 - progress) / 0.3 : 1;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  ctx.textAlign = 'center';
  ctx.fillStyle = '#44dd88';
  ctx.font = 'bold 32px monospace';
  ctx.fillText('MfT', GW / 2, GH / 2 - 10);

  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText('Memes for Trees', GW / 2, GH / 2 + 15);

  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.fillText('tasern.quest', GW / 2, GH / 2 + 35);

  // Green line
  var lineW = 120 * Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = '#44dd88';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GW / 2 - lineW / 2, GH / 2 + 48);
  ctx.lineTo(GW / 2 + lineW / 2, GH / 2 + 48);
  ctx.stroke();

  if (frame % 4 === 0 && splashTimer > 0.5) {
    TAS.particles.spawn(
      GW / 2 + (Math.random() - 0.5) * 100,
      GH / 2 + (Math.random() - 0.5) * 40,
      Math.random() > 0.5 ? '#44dd88' : '#88ccff',
      1, 0.8, { size: 1, sizeVar: 1 }
    );
  }

  TAS.particles.draw();
  ctx.globalAlpha = 1;
}
'''

def add_splash_tasern(filepath, game_name):
    """Add splash to a tasern-engine game (uses TAS.*, GW, GH, ctx, frame)."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'splashTimer' in content:
        print(f"  SKIP {game_name}: already has splashTimer")
        return False

    changes = 0

    # 1. Change initial state from 'title' to 'splash'
    #    Match patterns like: let state = 'title';  or  var state = 'title';
    new_content, n = re.subn(
        r"""((?:let|var|const)\s+state\s*=\s*)'title'(\s*;)""",
        r"\1'splash'\2",
        content,
        count=1
    )
    if n > 0:
        changes += 1
        print(f"  [1] Changed initial state to 'splash'")
    else:
        print(f"  WARN: Could not find 'state = title' declaration in {game_name}")
        return False

    # 2. Add splashTimer variable right after the state declaration line
    new_content = re.sub(
        r"""((?:let|var|const)\s+state\s*=\s*'splash'\s*;)""",
        r"\1\nvar splashTimer = 2.0;",
        new_content,
        count=1
    )
    changes += 1
    print(f"  [2] Added splashTimer variable")

    # 3. Add splash handling at start of update() function
    #    Insert after the TAS.particles.update(dt) and TAS.fx.updateEffects(dt) lines
    #    Look for first state check in update
    splash_update_code = """
  // MfT Splash
  if (state === 'splash') {
    splashTimer -= dt;
    if (splashTimer <= 0) {
      state = 'title';
    }
    return;
  }
"""
    # Find the first "if (state ===" inside update() and insert before it
    # We need to find function update(dt) { ... first state check
    update_match = re.search(r'(function\s+update\s*\(\s*dt\s*\)\s*\{[^}]*?)(  if \(state ===)', new_content)
    if update_match:
        insert_pos = update_match.start(2)
        new_content = new_content[:insert_pos] + splash_update_code + "\n" + new_content[insert_pos:]
        changes += 1
        print(f"  [3] Added splash logic to update()")
    else:
        print(f"  WARN: Could not find state check in update() for {game_name}")
        return False

    # 4. Add splash branch at start of draw() function
    splash_draw_branch = "  if (state === 'splash') { drawSplash(); return; }\n"

    # Find the first "if (state ===" inside draw()
    # Need to be careful to find the draw function, not update
    draw_func_match = re.search(r'function\s+draw\s*\(\s*(?:dt)?\s*\)\s*\{', new_content)
    if draw_func_match:
        # Find the first state check after draw function declaration
        after_draw = new_content[draw_func_match.end():]
        state_in_draw = re.search(r'(\n\s*)(if \(state ===)', after_draw)
        if state_in_draw:
            abs_pos = draw_func_match.end() + state_in_draw.start(2)
            new_content = new_content[:abs_pos] + splash_draw_branch + new_content[abs_pos:]
            changes += 1
            print(f"  [4] Added splash branch to draw()")
        else:
            print(f"  WARN: Could not find state check in draw() for {game_name}")
            return False
    else:
        print(f"  WARN: Could not find draw() function for {game_name}")
        return False

    # 5. Insert drawSplash() function before the draw() function
    draw_func_match2 = re.search(r'\nfunction\s+draw\s*\(\s*(?:dt)?\s*\)\s*\{', new_content)
    if draw_func_match2:
        new_content = new_content[:draw_func_match2.start()] + "\n" + TASERN_DRAW_SPLASH + new_content[draw_func_match2.start():]
        changes += 1
        print(f"  [5] Added drawSplash() function")
    else:
        print(f"  WARN: Could not insert drawSplash() for {game_name}")
        return False

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)

    print(f"  OK {game_name}: {changes} changes applied")
    return True


def add_splash_arkanoid(filepath):
    """Add splash to arkanoid-mft.html (uses ctx, GAME_W, GAME_H)."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'splashTimer' in content:
        print(f"  SKIP arkanoid-mft: already has splashTimer")
        return False

    changes = 0

    # 1. Change state = 'title' to state = 'splash'
    content, n = re.subn(
        r"""(let\s+state\s*=\s*)'title'""",
        r"\1'splash'",
        content,
        count=1
    )
    changes += n
    print(f"  [1] Changed initial state to 'splash'")

    # 2. Add splashTimer after state declaration
    content = re.sub(
        r"""(let\s+state\s*=\s*'splash'\s*;[^\n]*)""",
        r"\1\nlet splashTimer = 2.0;",
        content,
        count=1
    )
    changes += 1
    print(f"  [2] Added splashTimer variable")

    # 3. Add splash update logic at start of update()
    splash_update = """
  // MfT Splash
  if (state === 'splash') {
    splashTimer -= dt;
    if (splashTimer <= 0) { state = 'title'; }
    return;
  }
"""
    # Insert at the very start of update function body
    content = re.sub(
        r'(function\s+update\s*\(\s*dt\s*\)\s*\{)',
        r'\1' + splash_update,
        content,
        count=1
    )
    changes += 1
    print(f"  [3] Added splash logic to update()")

    # 4. Add splash draw branch at start of draw()
    # arkanoid's draw has a ctx.save() then state checks
    splash_draw = "  if (state === 'splash') { drawSplash(); ctx.restore(); return; }\n"
    content = re.sub(
        r"(if \(state === 'title'\) \{ drawTitle\(\); ctx\.restore\(\); return; \})",
        splash_draw + r"  \1",
        content,
        count=1
    )
    changes += 1
    print(f"  [4] Added splash branch to draw()")

    # 5. Add drawSplash function before draw()
    arkanoid_splash_fn = '''
// === DRAW MfT SPLASH ===
function drawSplash() {
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, GAME_W, GAME_H);

  var progress = 1 - (splashTimer / 2);
  var alpha = progress < 0.3 ? progress / 0.3 : progress > 0.7 ? (1 - progress) / 0.3 : 1;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  ctx.textAlign = 'center';
  ctx.fillStyle = '#44dd88';
  ctx.font = 'bold 32px monospace';
  ctx.fillText('MfT', GAME_W / 2, GAME_H / 2 - 10);

  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText('Memes for Trees', GAME_W / 2, GAME_H / 2 + 15);

  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.fillText('tasern.quest', GAME_W / 2, GAME_H / 2 + 35);

  var lineW = 120 * Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = '#44dd88';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GAME_W / 2 - lineW / 2, GAME_H / 2 + 48);
  ctx.lineTo(GAME_W / 2 + lineW / 2, GAME_H / 2 + 48);
  ctx.stroke();

  ctx.globalAlpha = 1;
}
'''
    content = re.sub(
        r'\nfunction draw\(\)',
        arkanoid_splash_fn + '\nfunction draw()',
        content,
        count=1
    )
    changes += 1
    print(f"  [5] Added drawSplash() function")

    # 6. Add click-to-skip: in the mousedown/touchstart handlers
    # The existing handler has: if (state === 'title') { startGame(); return; }
    # Add before it: if (state === 'splash') { splashTimer = 0; return; }
    splash_click = "  if (state === 'splash') { splashTimer = 0; return; }\n"
    content = re.sub(
        r"(  if \(state === 'title'\) \{ startGame\(\); return; \})",
        splash_click + r"  \1",
        content,
        count=2  # mousedown and touchstart
    )
    changes += 1
    print(f"  [6] Added click-to-skip in handlers")

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  OK arkanoid-mft: {changes} changes applied")
    return True


def add_splash_blocksburgh(filepath):
    """Add splash to blocks-burg.html (uses STATE.screen, canvasW, canvasH, ctx)."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'splashTimer' in content:
        print(f"  SKIP blocks-burg: already has splashTimer")
        return False

    changes = 0

    # 1. Change STATE.screen initial value from "title" to "splash"
    content = re.sub(
        r'''(screen:\s*)"title"''',
        r'\1"splash"',
        content,
        count=1
    )
    changes += 1
    print(f"  [1] Changed initial STATE.screen to 'splash'")

    # 2. Add splashTimer to STATE object (after screen line)
    content = re.sub(
        r'(screen:\s*"splash",)',
        r'\1\n  splashTimer: 2.0,',
        content,
        count=1
    )
    changes += 1
    print(f"  [2] Added splashTimer to STATE")

    # 3. Add drawSplash function before drawTitleScreen
    blocksburgh_splash_fn = '''
// === DRAW MfT SPLASH ===
function drawSplashScreen() {
  STATE.splashTimer -= 1/60; // approximate dt at 60fps
  if (STATE.splashTimer <= 0) {
    STATE.screen = "title";
    return;
  }

  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, canvasW, canvasH);

  var progress = 1 - (STATE.splashTimer / 2);
  var alpha = progress < 0.3 ? progress / 0.3 : progress > 0.7 ? (1 - progress) / 0.3 : 1;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  ctx.textAlign = 'center';
  ctx.fillStyle = '#44dd88';
  ctx.font = 'bold 32px monospace';
  ctx.fillText('MfT', canvasW / 2, canvasH / 2 - 10);

  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText('Memes for Trees', canvasW / 2, canvasH / 2 + 15);

  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.fillText('tasern.quest', canvasW / 2, canvasH / 2 + 35);

  var lineW = 120 * Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = '#44dd88';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(canvasW / 2 - lineW / 2, canvasH / 2 + 48);
  ctx.lineTo(canvasW / 2 + lineW / 2, canvasH / 2 + 48);
  ctx.stroke();

  ctx.globalAlpha = 1;
}
'''
    content = re.sub(
        r'(\nfunction drawTitleScreen\(\))',
        blocksburgh_splash_fn + r'\1',
        content,
        count=1
    )
    changes += 1
    print(f"  [3] Added drawSplashScreen() function")

    # 4. Add splash case to the switch in gameLoop
    content = re.sub(
        r'''(switch \(STATE\.screen\) \{\n\s*case "title":)''',
        r'case "splash": drawSplashScreen(); break;\n    \1',
        content,
        count=1
    )
    changes += 1
    print(f"  [4] Added splash case to gameLoop switch")

    # 5. Add click-to-skip: if STATE.screen === "splash" skip in mousedown/touchstart
    # The mousedown handler sets mouseClicked = true, we need to add splash skip
    content = re.sub(
        r'(canvas\.addEventListener\("mousedown", function\(e\) \{[^}]*?)(mouseClicked = true;)',
        r'\1if (STATE.screen === "splash") { STATE.splashTimer = 0; return; }\n  \2',
        content,
        count=1
    )
    changes += 1
    print(f"  [5] Added click-to-skip in mousedown")

    content = re.sub(
        r'(canvas\.addEventListener\("touchstart", function\(e\) \{[^}]*?)(mouseClicked = true;)',
        r'\1if (STATE.screen === "splash") { STATE.splashTimer = 0; return; }\n  \2',
        content,
        count=1
    )
    changes += 1
    print(f"  [6] Added click-to-skip in touchstart")

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  OK blocks-burg: {changes} changes applied")
    return True


def add_splash_bomberman(filepath):
    """Add splash to bomberman-poop.html (uses state, W, H, ctx)."""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    if 'splashTimer' in content or "'splash'" in content:
        print(f"  SKIP bomberman-poop: already has splash")
        return False

    changes = 0

    # 1. Change state = 'title' to state = 'splash'
    content, n = re.subn(
        r"""(let\s+state\s*=\s*)'title'""",
        r"\1'splash'",
        content,
        count=1
    )
    changes += n
    print(f"  [1] Changed initial state to 'splash'")

    # 2. Add splashTimer after state declaration
    content = re.sub(
        r"""(let\s+state\s*=\s*'splash'\s*;[^\n]*)""",
        r"\1\nlet splashTimer = 2.0;",
        content,
        count=1
    )
    changes += 1
    print(f"  [2] Added splashTimer variable")

    # 3. Add drawSplash function before drawTitle
    bomberman_splash_fn = '''
// === DRAW MfT SPLASH ===
function drawSplash() {
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  var progress = 1 - (splashTimer / 2);
  var alpha = progress < 0.3 ? progress / 0.3 : progress > 0.7 ? (1 - progress) / 0.3 : 1;
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  ctx.textAlign = 'center';
  ctx.fillStyle = '#44dd88';
  ctx.font = 'bold 32px monospace';
  ctx.fillText('MfT', W / 2, H / 2 - 10);

  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.fillText('Memes for Trees', W / 2, H / 2 + 15);

  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.fillText('tasern.quest', W / 2, H / 2 + 35);

  var lineW = 120 * Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = '#44dd88';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W / 2 - lineW / 2, H / 2 + 48);
  ctx.lineTo(W / 2 + lineW / 2, H / 2 + 48);
  ctx.stroke();

  ctx.globalAlpha = 1;
}
'''
    content = re.sub(
        r'(\nfunction drawTitle\(\))',
        bomberman_splash_fn + r'\1',
        content,
        count=1
    )
    changes += 1
    print(f"  [3] Added drawSplash() function")

    # 4. Add splash handling at top of gameLoop, before title check
    splash_loop = """  if (state === 'splash') {
    splashTimer -= dt;
    if (splashTimer <= 0) { state = 'title'; }
    drawSplash();
    requestAnimationFrame(gameLoop);
    return;
  }

  """
    content = re.sub(
        r"""(  if \(state === 'title'\) \{)""",
        splash_loop + r"\1",
        content,
        count=1
    )
    changes += 1
    print(f"  [4] Added splash handling in gameLoop")

    # 5. Add click-to-skip in touchstart handler
    # The existing touchstart has: if (state === 'title') { startGame(); return; }
    splash_touch = "  if (state === 'splash') { splashTimer = 0; return; }\n"
    content = re.sub(
        r"""(  if \(state === 'title'\) \{ startGame\(\); return; \})""",
        splash_touch + r"  \1",
        content,
        count=1
    )
    changes += 1
    print(f"  [5] Added touch-to-skip in touchstart")

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  OK bomberman-poop: {changes} changes applied")
    return True


def main():
    results = {}

    # === TASERN ENGINE GAMES ===
    tasern_games = [
        'adventure-island.html',
        'baseball-stars.html',
        'battletoads.html',
        'blades-of-poop.html',
        'bucky-ohare.html',
    ]

    for game_file in tasern_games:
        filepath = os.path.join(GAMES_DIR, game_file)
        name = game_file.replace('.html', '')
        print(f"\n--- {name} ---")
        if not os.path.exists(filepath):
            print(f"  ERROR: File not found: {filepath}")
            results[name] = 'NOT FOUND'
            continue
        try:
            ok = add_splash_tasern(filepath, name)
            results[name] = 'OK' if ok else 'SKIPPED'
        except Exception as e:
            print(f"  ERROR: {e}")
            results[name] = f'ERROR: {e}'

    # === ARCHON-BATTLE (already has splash) ===
    print(f"\n--- archon-battle ---")
    print(f"  SKIP: already has splash implementation")
    results['archon-battle'] = 'ALREADY HAS SPLASH'

    # === NON-ENGINE GAMES ===
    print(f"\n--- arkanoid-mft ---")
    filepath = os.path.join(GAMES_DIR, 'arkanoid-mft.html')
    if os.path.exists(filepath):
        try:
            ok = add_splash_arkanoid(filepath)
            results['arkanoid-mft'] = 'OK' if ok else 'SKIPPED'
        except Exception as e:
            print(f"  ERROR: {e}")
            results['arkanoid-mft'] = f'ERROR: {e}'
    else:
        results['arkanoid-mft'] = 'NOT FOUND'

    print(f"\n--- blocks-burg ---")
    filepath = os.path.join(GAMES_DIR, 'blocks-burg.html')
    if os.path.exists(filepath):
        try:
            ok = add_splash_blocksburgh(filepath)
            results['blocks-burg'] = 'OK' if ok else 'SKIPPED'
        except Exception as e:
            print(f"  ERROR: {e}")
            results['blocks-burg'] = f'ERROR: {e}'
    else:
        results['blocks-burg'] = 'NOT FOUND'

    print(f"\n--- bomberman-poop ---")
    filepath = os.path.join(GAMES_DIR, 'bomberman-poop.html')
    if os.path.exists(filepath):
        try:
            ok = add_splash_bomberman(filepath)
            results['bomberman-poop'] = 'OK' if ok else 'SKIPPED'
        except Exception as e:
            print(f"  ERROR: {e}")
            results['bomberman-poop'] = f'ERROR: {e}'
    else:
        results['bomberman-poop'] = 'NOT FOUND'

    # === SUMMARY ===
    print("\n\n========== SUMMARY ==========")
    for name, status in results.items():
        print(f"  {name:25s} {status}")
    print("=============================\n")


if __name__ == '__main__':
    main()
