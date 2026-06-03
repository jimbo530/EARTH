for path in ['/var/www/tasern/adopt.html', '/var/www/tasern/launcher/adopt.html']:
    with open(path) as f:
        content = f.read()

    changes = 0

    # 1. Fix the success check — V1 only has reactorAddr, no charReactorAddr
    old = 'if (reactorAddr && charReactorAddr) {'
    new = 'if (reactorAddr) {'
    if old in content:
        content = content.replace(old, new, 1)
        changes += 1
        print(f'{path}: 1. Success check fixed (removed charReactorAddr)')

    # 2. Fix the success log — remove charReactor reference
    old2 = '''      out("\\n  TOKEN ADOPTED SUCCESSFULLY!", "ok");
      out("  Token Reactor: " + reactorAddr, "ok");
      out("  CHAR Reactor:  " + charReactorAddr, "ok");
      out("  Status: Ready for pools", "info");'''
    new2 = '''      out("\\n  TOKEN ADOPTED SUCCESSFULLY!", "ok");
      out("  Reactor: " + reactorAddr, "ok");
      out("  Status: Ready for pools — go to Card Shop to add LPs", "info");'''
    if old2 in content:
        content = content.replace(old2, new2, 1)
        changes += 1
        print(f'{path}: 2. Success log fixed')

    # 3. Remove charReactor variable usage in result HTML
    old3 = '      const vCharReactor = validAddr(charReactorAddr);'
    if old3 in content:
        content = content.replace(old3, '', 1)
        changes += 1
        print(f'{path}: 3. Removed vCharReactor variable')

    # 4. Remove CHAR reactor display card from result
    old4 = '''          <div class="result-ca" style="border-color:var(--gold)">
            <span class="label" style="color:var(--gold)">CHAR Reactor</span>
            <span class="addr" style="color:var(--gold)">${vCharReactor}</span>
            <button class="copy-btn" onclick="navigator.clipboard.writeText('${vCharReactor}')">Copy</button>
          </div>'''
    if old4 in content:
        content = content.replace(old4, '', 1)
        changes += 1
        print(f'{path}: 4. Removed CHAR reactor card from result')

    # 5. Update fuel lines text — no CHAR reactor in V1
    old5 = 'Your reactors collect trading fees every 2 hours. Fees flow upstream through the invite chain -- the more pools, the more fuel. Your CHAR reactor tracks your token\'s carbon impact.'
    new5 = 'Your reactor collects trading fees every 2 hours. Fees flow upstream through the invite chain. Add more pools in the Card Shop to increase fuel flow.'
    if old5 in content:
        content = content.replace(old5, new5, 1)
        changes += 1
        print(f'{path}: 5. Fuel lines text updated for V1')

    with open(path, 'w') as f:
        f.write(content)

    print(f'{path}: {changes} changes applied\n')
