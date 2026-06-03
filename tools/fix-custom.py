with open('/var/www/tasern/launcher/card-shop.html') as f:
    content = f.read()

# 1. External tokens: change "not verified" to just "External token", gate on isAdmin
old1 = """$("cr-badge").innerHTML = '<span style="color:var(--gold)">External token - not verified</span>';
      $("cr-add").disabled = !signer;"""

new1 = """$("cr-badge").innerHTML = '<span style="color:var(--gold)">External token</span>';
      $("cr-add").disabled = !isAdmin;"""

if old1 in content:
    content = content.replace(old1, new1, 1)
    print('1. external token badge+gate: fixed')
else:
    print('1. external token: pattern not found')

# 2. Remove confirm dialog for non-launched tokens
old2 = '''  if (!customTokenData.launched) {
    if (!confirm("This token was NOT launched on Unruggable. External tokens are unvetted. Continue?")) return;
  }'''

if old2 in content:
    content = content.replace(old2, '', 1)
    print('2. confirm dialog: removed')
else:
    # Try single-quote variant
    old2b = """  if (!customTokenData.launched) {
    if (!confirm('This token was NOT launched on Unruggable. External tokens are unvetted. Continue?')) return;
  }"""
    if old2b in content:
        content = content.replace(old2b, '', 1)
        print('2. confirm dialog (alt quotes): removed')
    else:
        print('2. confirm dialog: pattern not found')

with open('/var/www/tasern/launcher/card-shop.html', 'w') as f:
    f.write(content)

print('done')
