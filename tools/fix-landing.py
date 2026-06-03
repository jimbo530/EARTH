with open('/var/www/tasern/index.html') as f:
    content = f.read()

# Add card-adopt style next to card-launch
old_style = "  .card-launch .tag { background: #122d18; color: var(--green); border: 1px solid var(--border2); }"
new_style = """  .card-launch .tag { background: #122d18; color: var(--green); border: 1px solid var(--border2); }
  .card-adopt .tag { background: #1a2a1e; color: #58d68d; border: 1px solid #2d5a3e; }"""

if old_style in content:
    content = content.replace(old_style, new_style, 1)
    print('1. adopt style: added')
else:
    print('1. adopt style: pattern not found')

# Add Become Unruggable card right after Unruggable Launcher card
old_card = """  <a class="card card-agents" href="/agents.html">"""

new_card = """  <a class="card card-adopt" href="/adopt.html">
    <div class="icon">&#x1F6E1;</div>
    <h2>Become Unruggable</h2>
    <p>Already have a token? Wrap it with locked V3 liquidity, a reactor, and permanent floors. Keep your community. Lose the rug risk.</p>
    <span class="tag">Adopt</span>
  </a>

  <a class="card card-agents" href="/agents.html">"""

if old_card in content:
    content = content.replace(old_card, new_card, 1)
    print('2. adopt card: added')
else:
    print('2. adopt card: pattern not found')

with open('/var/www/tasern/index.html', 'w') as f:
    f.write(content)

print('done')
