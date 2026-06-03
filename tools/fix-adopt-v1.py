import re

for path in ['/var/www/tasern/adopt.html', '/var/www/tasern/launcher/adopt.html']:
    with open(path) as f:
        content = f.read()

    changes = 0

    # 1. Replace V2 ABI with V1 ABI
    old_abi = '''// V2 Adoption ABI — adopt(token, upstream, usdcAmount) returns (reactor, charReactor)
const ADOPTION_ABI = [
  {"inputs":[{"type":"address"},{"type":"address"},{"type":"uint256"}],"name":"adopt","outputs":[{"type":"address"},{"type":"address"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"type":"address"}],"name":"reactorOf","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"type":"address"}],"name":"isAdopted","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"adoptionCount","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  // V2 event: TokenAdopted(token, reactor, charReactor, adopter, upstreamReactor, usdcAmount, name, symbol)
  {"anonymous":false,"inputs":[{"indexed":true,"name":"token","type":"address"},{"indexed":true,"name":"reactor","type":"address"},{"indexed":true,"name":"charReactor","type":"address"},{"indexed":false,"name":"adopter","type":"address"},{"indexed":false,"name":"upstreamReactor","type":"address"},{"indexed":false,"name":"usdcAmount","type":"uint256"},{"indexed":false,"name":"name","type":"string"},{"indexed":false,"name":"symbol","type":"string"}],"name":"TokenAdopted","type":"event"}
];'''

    new_abi = '''// V1 Adoption ABI — adopt(token, upstream) returns reactor
// V2 with MfT/CHAR LP coming soon — contract written, pending deploy
const ADOPTION_ABI = [
  {"inputs":[{"type":"address"},{"type":"address"}],"name":"adopt","outputs":[{"type":"address"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"type":"address"}],"name":"reactorOf","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"type":"address"}],"name":"isAdopted","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"adoptionCount","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[],"name":"ADOPTION_FEE","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"}
];'''

    if old_abi in content:
        content = content.replace(old_abi, new_abi, 1)
        changes += 1
        print(f'{path}: 1. ABI reverted to V1')
    else:
        print(f'{path}: 1. ABI pattern not found')

    # 2. Replace contract address placeholder with V1
    old_addr = '// V2 Adoption contract — PLACEHOLDER until deployed\nconst ADOPTION_CONTRACT = "0xV2_ADOPTION_CONTRACT_HERE";'
    new_addr = 'const ADOPTION_CONTRACT = "0x013a1091108D50eF5F9cC3FDa38f9b2BA4D3F81d";'

    if old_addr in content:
        content = content.replace(old_addr, new_addr, 1)
        changes += 1
        print(f'{path}: 2. Contract address restored to V1')
    else:
        print(f'{path}: 2. Contract address pattern not found')

    # 3. Remove the V2 placeholder check that blocks adoption
    old_check = '''  if (!ADOPTION_CONTRACT || ADOPTION_CONTRACT.includes("HERE")) {
    alert("Adoption V2 contract not yet deployed. Coming soon!");
    return;
  }'''

    if old_check in content:
        content = content.replace(old_check, '', 1)
        changes += 1
        print(f'{path}: 3. Placeholder check removed')
    else:
        print(f'{path}: 3. Placeholder check not found')

    # 4. Fix adopt() call — V1 takes 2 params, fixed $5
    # Replace variable amount logic with fixed $5
    old_call = '''    // Call adopt(token, upstream, usdcAmount)
    const upstream = validatedUpstream !== ZERO_ADDR ? validatedUpstream : ZERO_ADDR;
    out("Adopting token into reactor network...", "info");
    out("Token: " + tokenAddr, "info");
    out("Amount: $" + rawAmount.toFixed(2) + " USDC (90% MfT/Token LP, 10% CHAR/Token LP)", "info");
    if (upstream !== ZERO_ADDR) out("Upstream: " + upstream.slice(0,10) + "...", "info");

    const adoption = new ethers.Contract(ADOPTION_CONTRACT, ADOPTION_ABI, signer);
    const tx = await adoption.adopt(tokenAddr, upstream, usdcAmount, { gasLimit: 3000000 });'''

    new_call = '''    // Call adopt(token, upstream) — V1 fixed $5
    const upstream = validatedUpstream !== ZERO_ADDR ? validatedUpstream : ZERO_ADDR;
    out("Adopting token into reactor network...", "info");
    out("Token: " + tokenAddr, "info");
    out("Fee: $5 USDC", "info");
    if (upstream !== ZERO_ADDR) out("Upstream: " + upstream.slice(0,10) + "...", "info");

    const adoption = new ethers.Contract(ADOPTION_CONTRACT, ADOPTION_ABI, signer);
    const tx = await adoption.adopt(tokenAddr, upstream, { gasLimit: 2000000 });'''

    if old_call in content:
        content = content.replace(old_call, new_call, 1)
        changes += 1
        print(f'{path}: 4. adopt() call reverted to V1 (2 params)')
    else:
        print(f'{path}: 4. adopt() call pattern not found')

    # 5. Fix USDC approval amount — V1 uses fixed ADOPTION_FEE ($5)
    old_approve = '''    if (bal < usdcAmount) {
      out("Need $" + rawAmount.toFixed(2) + " USDC. Balance: $" + ethers.formatUnits(bal, 6), "err");
      resetBtn(); return;
    }

    // Approve USDC
    out("Checking USDC approval...", "info");
    const allowance = await usdcRead.allowance(userAddr, ADOPTION_CONTRACT);
    if (allowance < usdcAmount) {
      out("Approving $" + rawAmount.toFixed(2) + " USDC...", "info");
      const appTx = await usdc.approve(ADOPTION_CONTRACT, usdcAmount);'''

    new_approve = '''    const fee = BigInt(5000000); // $5 USDC
    if (bal < fee) {
      out("Need $5 USDC. Balance: $" + ethers.formatUnits(bal, 6), "err");
      resetBtn(); return;
    }

    // Approve USDC
    out("Checking USDC approval...", "info");
    const allowance = await usdcRead.allowance(userAddr, ADOPTION_CONTRACT);
    if (allowance < fee) {
      out("Approving $5 USDC...", "info");
      const appTx = await usdc.approve(ADOPTION_CONTRACT, fee);'''

    if old_approve in content:
        content = content.replace(old_approve, new_approve, 1)
        changes += 1
        print(f'{path}: 5. USDC approval fixed to $5')
    else:
        print(f'{path}: 5. USDC approval pattern not found')

    # 6. Fix event parsing — V1 TokenAdopted has no charReactor
    old_event = '''    // Parse event to get both reactor addresses
    let reactorAddr = "";
    let charReactorAddr = "";
    for (const log of receipt.logs) {
      try {'''

    new_event = '''    // Parse event to get reactor address
    let reactorAddr = "";
    for (const log of receipt.logs) {
      try {'''

    if old_event in content:
        content = content.replace(old_event, new_event, 1)
        changes += 1
        print(f'{path}: 6. Event parsing reverted to V1')
    else:
        print(f'{path}: 6. Event parsing pattern not found')

    # 7. Fix event field — V1 event has 'reactor' not 'charReactor'
    # Replace charReactor parsing if present
    old_parse = 'charReactorAddr = parsed.args.charReactor;'
    if old_parse in content:
        content = content.replace(old_parse, '', 1)
        changes += 1
        print(f'{path}: 7. Removed charReactor parse')

    # 8. Fix isAdopted check — remove the placeholder detection
    old_check2 = '    if (ADOPTION_CONTRACT && !ADOPTION_CONTRACT.includes("HERE")) {'
    new_check2 = '    if (ADOPTION_CONTRACT) {'
    if old_check2 in content:
        content = content.replace(old_check2, new_check2, 1)
        changes += 1
        print(f'{path}: 8. isAdopted check simplified')

    with open(path, 'w') as f:
        f.write(content)

    print(f'{path}: {changes} changes applied\n')
