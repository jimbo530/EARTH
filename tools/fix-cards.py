import re

with open('/var/www/tasern/launcher/card-shop.html') as f:
    content = f.read()

# 1. Hide "Buy Card" buttons for non-admins — only show if isAdmin
# The existing line renders buy button for anyone with a signer
old_buy = """: `<button class="card-btn buy" ${!signer ? 'disabled title="Connect wallet"' : ''} onclick="window.__openBuy('${t.addr}', '${t.ticker}', ${t.fee || 10000})">Buy Card - $5+</button>`"""

new_buy = """: (isAdmin ? `<button class="card-btn buy" ${!signer ? 'disabled title="Connect wallet"' : ''} onclick="window.__openBuy('${t.addr}', '${t.ticker}', ${t.fee || 10000})">Buy Card - $5+</button>` : `<div style="color:var(--muted);font-size:11px;text-align:center">No pool yet</div>`)"""

if old_buy in content:
    content = content.replace(old_buy, new_buy, 1)
    print('buy buttons: admin-gated')
else:
    print('buy buttons: pattern not found')

# 2. Hide custom token "Look Up" button for non-admins
old_custom = '$("custom-add-btn").disabled = false;'
new_custom = '$("custom-add-btn").disabled = !isAdmin;'

if old_custom in content:
    content = content.replace(old_custom, new_custom, 1)
    print('custom add: admin-gated')
else:
    print('custom add: pattern not found')

# 3. Also gate the cr-add button at the bottom
old_cr = '$("cr-add").disabled = !signer;'
new_cr = '$("cr-add").disabled = !isAdmin;'

if old_cr in content:
    content = content.replace(old_cr, new_cr, 1)
    print('cr-add: admin-gated')
else:
    print('cr-add: pattern not found')

with open('/var/www/tasern/launcher/card-shop.html', 'w') as f:
    f.write(content)

print('done')
